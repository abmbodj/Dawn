import fs from "node:fs"
import path from "node:path"
import { type ToolSet, tool } from "ai"
import { z } from "zod"
import type { Bus } from "../bus/bus"
import { estimateTokens, maxReadLines, ttlForKind } from "../context/budget"
import type { ContextStore } from "../context/store"
import { getFileSummary } from "../context/summarize"
import type { ContextMode } from "../context/types"
import type { ContextWorkingSet } from "../context/working-set"
import type { Asker } from "../permission/asker"
import type { PermissionGate } from "../permission/permission"
import { applyEdit } from "./edit"
import { capLine, capLines, truncateMiddle } from "./truncate"

export interface ToolContext {
  cwd: string
  gate: PermissionGate
  bus: Bus
  asker?: Asker
  contextStore?: ContextStore
  workingSet?: ContextWorkingSet
  contextMode?: ContextMode
}

function resolvePath(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
}

function relative(cwd: string, p: string): string {
  const rel = path.relative(cwd, p)
  return rel.startsWith("..") ? p : rel || "."
}

function numberLines(content: string, offset: number): string {
  return content
    .split("\n")
    .map((line, i) => `${String(i + offset).padStart(5)}→${capLine(line)}`)
    .join("\n")
}

const OVERVIEW_IGNORED_DIRS = new Set([".git", ".next", "build", "coverage", "dist", "node_modules"])

interface PackageJson {
  name?: string
  version?: string
  description?: string
  private?: boolean
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
}

export interface RepoOverviewOptions {
  maxReadmeChars?: number
  maxTopLevelEntries?: number
  maxWorkspacePackages?: number
}

export function buildRepoOverview(cwd: string, opts: RepoOverviewOptions = {}): string {
  const maxReadmeChars = opts.maxReadmeChars ?? 1200
  const maxTopLevelEntries = opts.maxTopLevelEntries ?? 80
  const maxWorkspacePackages = opts.maxWorkspacePackages ?? 12
  const sections = [`Project overview for ${cwd}`]

  sections.push(`Top-level entries:\n${topLevelEntries(cwd, maxTopLevelEntries)}`)
  sections.push(`Git:\n${gitOverview(cwd)}`)

  const packageJson = readPackageJson(path.join(cwd, "package.json"))
  if (packageJson) {
    sections.push(`package.json:\n${packageSummary(packageJson)}`)
    const workspaces = workspacePackageSummaries(cwd, packageJson, maxWorkspacePackages)
    if (workspaces) sections.push(`Workspace packages:\n${workspaces}`)
  }

  const manifests = detectedManifests(cwd)
  if (manifests.length) sections.push(`Detected manifests:\n${manifests.join("\n")}`)

  const readme = readReadmeExcerpt(cwd, maxReadmeChars)
  if (readme) sections.push(`README excerpt:\n${readme}`)

  return sections.join("\n\n")
}

/** Human title for a tool invocation, shown in the TUI activity feed. */
export function toolTitle(toolName: string, input: any): string {
  switch (toolName) {
    case "repo_overview":
      return "project snapshot"
    case "bash":
      return String(input?.command ?? "").slice(0, 80)
    case "read":
    case "write":
    case "edit":
      return String(input?.filePath ?? "")
    case "grep":
      return `"${input?.pattern ?? ""}"${input?.path ? ` in ${input.path}` : ""}`
    case "glob":
      return String(input?.pattern ?? "")
    case "ls":
      return String(input?.path ?? ".")
    case "todo_write": {
      const active = Array.isArray(input?.todos)
        ? input.todos.find((t: any) => t?.status === "in_progress")
        : undefined
      return active?.content ?? "task list"
    }
    default:
      return ""
  }
}

/**
 * Capped diff/content preview for a tool call — shared by the permission dialog
 * and the TUI activity feed so both show the same thing.
 */
export function toolPreview(toolName: string, input: any): string | undefined {
  switch (toolName) {
    case "edit":
      return `${capLines(`- ${input?.oldString ?? ""}`, 6, 80)}\n${capLines(`+ ${input?.newString ?? ""}`, 6, 80)}`
    case "write":
      return capLines(
        String(input?.content ?? "")
          .split("\n")
          .map((l) => `+ ${l}`)
          .join("\n"),
        8,
        80,
      )
    default:
      return undefined
  }
}

const DENIED = "Permission denied by user. Ask before retrying, or propose an alternative."

const rgAvailable: Promise<boolean> = (async () => {
  try {
    const proc = Bun.spawn(["rg", "--version"], { stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
})()

export function createTools(ctx: ToolContext): ToolSet {
  const { cwd, gate } = ctx
  const mode = ctx.contextMode ?? "balanced"

  const repo_overview = tool({
    description:
      "Read a compact snapshot of the current repository: top-level files, manifests, README excerpt, workspace packages, scripts, dependencies, and git status. Use this before answering broad project/repo overview questions.",
    inputSchema: z.object({}),
    execute: async () => buildRepoOverview(cwd),
  })

  const read = tool({
    description:
      "Read a file with line numbers. Prefer reading only the range you need via offset/limit instead of whole large files.",
    inputSchema: z.object({
      filePath: z.string().describe("Path to the file (relative to cwd or absolute)"),
      offset: z.number().int().min(1).optional().describe("1-based line to start from"),
      limit: z.number().int().min(1).optional().describe("Max lines to read (default 2000)"),
    }),
    execute: async ({ filePath, offset = 1, limit = maxReadLines(mode) }) => {
      const abs = resolvePath(cwd, filePath)
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) throw new Error(`${filePath} is a directory — use ls`)
      if (stat.size > 10_000_000) throw new Error(`${filePath} is ${stat.size} bytes — too large to read`)
      const lines = fs.readFileSync(abs, "utf8").split("\n")
      const cappedLimit = Math.min(limit, maxReadLines(mode))
      const slice = lines.slice(offset - 1, offset - 1 + cappedLimit)
      if (slice.length === 0) return `[file has ${lines.length} lines — offset ${offset} is past the end]`
      const body = numberLines(slice.join("\n"), offset)
      ctx.workingSet?.add({
        kind: "file-range",
        path: relative(cwd, abs),
        startLine: offset,
        endLine: offset + slice.length - 1,
        content: body,
        reason: "read tool",
        ttl: ttlForKind(mode, "file-range"),
        estimatedTokens: estimateTokens(body),
      })
      if (ctx.contextStore) {
        const summary = getFileSummary({ cwd, path: relative(cwd, abs), store: ctx.contextStore })
        ctx.workingSet?.add({
          kind: "summary",
          path: summary.path,
          summary: summary.summary,
          reason: "read tool summary",
          ttl: ttlForKind(mode, "summary"),
          estimatedTokens: summary.tokenEstimate,
        })
      }
      const remaining = lines.length - (offset - 1 + slice.length)
      return remaining > 0
        ? `${body}\n[… ${remaining} more lines — continue with offset=${offset + slice.length}]`
        : body
    },
  })

  const write = tool({
    description: "Create or overwrite a file with the given content.",
    inputSchema: z.object({
      filePath: z.string(),
      content: z.string(),
    }),
    execute: async ({ filePath, content }) => {
      const abs = resolvePath(cwd, filePath)
      const exists = fs.existsSync(abs)
      const ok = await gate.ask({
        tool: "write",
        title: `${exists ? "Overwrite" : "Create"} ${relative(cwd, abs)}`,
        detail: toolPreview("write", { content }),
      })
      if (!ok) return DENIED
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      return `Wrote ${content.split("\n").length} lines to ${relative(cwd, abs)}`
    },
  })

  const edit = tool({
    description:
      "Replace an exact string in a file. oldString must match exactly once (include surrounding lines to disambiguate) unless replaceAll is set.",
    inputSchema: z.object({
      filePath: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    execute: async ({ filePath, oldString, newString, replaceAll }) => {
      const abs = resolvePath(cwd, filePath)
      const content = fs.readFileSync(abs, "utf8")
      const updated = applyEdit(content, oldString, newString, replaceAll)
      const ok = await gate.ask({
        tool: "edit",
        title: `Edit ${relative(cwd, abs)}`,
        detail: toolPreview("edit", { oldString, newString }),
      })
      if (!ok) return DENIED
      fs.writeFileSync(abs, updated)
      return `Edited ${relative(cwd, abs)}`
    },
  })

  const bash = tool({
    description: "Run a shell command in the project directory. Output is truncated in the middle when long.",
    inputSchema: z.object({
      command: z.string(),
      timeoutMs: z.number().int().max(600_000).optional().describe("Default 120000"),
    }),
    execute: async ({ command, timeoutMs = 120_000 }) => {
      const ok = await gate.ask({ tool: "bash", title: command })
      if (!ok) return DENIED
      const proc = Bun.spawn(["bash", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      let out = stdout
      if (stderr.trim()) out += `${out ? "\n" : ""}[stderr]\n${stderr}`
      out = truncateMiddle(out.trimEnd() || "(no output)")
      return exitCode === 0 ? out : `${out}\n[exit code ${exitCode}]`
    },
  })

  const grep = tool({
    description:
      "Search file contents with a regex (ripgrep if available, otherwise grep). Use this to locate code before reading files.",
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression to search for"),
      path: z.string().optional().describe("Directory or file to search (default cwd)"),
      glob: z.string().optional().describe('Limit to files matching a glob, e.g. "*.ts"'),
    }),
    execute: async ({ pattern, path: searchPath, glob }) => {
      if (await rgAvailable) {
        const args = ["--no-heading", "-n", "--color=never", "-S", "-m", "50"]
        if (glob) args.push("-g", glob)
        args.push("--", pattern, searchPath ? resolvePath(cwd, searchPath) : ".")
        const proc = Bun.spawn(["rg", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        if (exitCode === 1) return "No matches found"
        if (exitCode !== 0) throw new Error(`ripgrep failed: ${stderr.trim()}`)
        return truncateMiddle(stdout.trimEnd(), 15_000)
      } else {
        const args = ["-rn", "-m", "50"]
        if (glob) args.push(`--include=${glob}`)
        args.push("--", pattern, searchPath ? resolvePath(cwd, searchPath) : ".")
        const proc = Bun.spawn(["grep", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        if (exitCode === 1) return "No matches found"
        if (exitCode !== 0) throw new Error(`grep failed: ${stderr.trim()}`)
        return truncateMiddle(stdout.trimEnd(), 15_000)
      }
    },
  })

  const glob = tool({
    description: 'Find files by glob pattern, e.g. "src/**/*.ts". Returns paths relative to cwd.',
    inputSchema: z.object({
      pattern: z.string(),
    }),
    execute: async ({ pattern }) => {
      const matches: string[] = []
      for await (const file of new Bun.Glob(pattern).scan({ cwd, dot: false })) {
        matches.push(file)
        if (matches.length >= 500) break
      }
      if (matches.length === 0) return "No files match"
      matches.sort()
      const capped = matches.length >= 500 ? "\n[… capped at 500 results]" : ""
      return matches.join("\n") + capped
    },
  })

  const ls = tool({
    description: "List a directory. Directories have a trailing slash.",
    inputSchema: z.object({
      path: z.string().optional().describe("Directory to list (default cwd)"),
    }),
    execute: async ({ path: dirPath }) => {
      const abs = resolvePath(cwd, dirPath ?? ".")
      const entries = fs.readdirSync(abs, { withFileTypes: true })
      if (entries.length === 0) return "(empty directory)"
      const names = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .slice(0, 300)
      const capped = entries.length > 300 ? `\n[… ${entries.length - 300} more entries]` : ""
      return names.join("\n") + capped
    },
  })

  const ask_user = tool({
    description:
      "Ask the user a multiple-choice question to resolve a decision only they can make. " +
      "Use sparingly — only when the right path is genuinely ambiguous and acting without input would be risky.",
    inputSchema: z.object({
      question: z.string().describe("The question to ask the user"),
      options: z.array(z.string()).min(2).max(9).describe("The choices to present (2–9 items)"),
    }),
    execute: async ({ question, options }) => {
      const index = await ctx.asker?.ask({
        kind: "ask",
        question,
        options: options.map((label) => ({ label })),
      })
      if (index === undefined || index === -1) return "User dismissed the question."
      return options[index] ?? "User dismissed the question."
    },
  })

  const exit_plan_mode = tool({
    description:
      "Call this tool only while in plan mode, after you have researched the task and presented a complete plan. " +
      "It shows the plan to the user for approval before any files are modified.",
    inputSchema: z.object({
      plan: z.string().describe("The complete plan to present for user approval"),
    }),
    execute: async ({ plan }) => {
      const index = await ctx.asker?.ask({
        kind: "plan-approval",
        question: "Ready to proceed with this plan?",
        detail: plan,
        options: [
          { label: "Yes — auto-accept edits", description: "Proceed and auto-approve all file edits" },
          { label: "Yes — approve each edit", description: "Proceed but prompt before each file change" },
          { label: "No — keep planning", description: "Stay in plan mode and refine the plan" },
        ],
      })
      if (index === 0 || index === 1) return "Approved. You may now make changes."
      return "Stay in plan mode and refine the plan."
    },
  })

  const todo_write = tool({
    description:
      "Record or update the task checklist for the current multi-step work. Pass the FULL list every call (it replaces the previous one). " +
      "content = short imperative ('Add --json flag'); activeForm = its present-continuous form ('Adding --json flag'); keep exactly one item in_progress. " +
      "Use this for tasks with 3+ distinct steps and update it as you finish each step. Skip it for trivial or single-step work.",
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string(),
            activeForm: z.string(),
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        )
        .min(1),
    }),
    execute: async ({ todos }) => {
      ctx.bus.emit({ type: "todos", items: todos })
      const done = todos.filter((t) => t.status === "completed").length
      const active = todos.find((t) => t.status === "in_progress")
      return active
        ? `Tracking ${todos.length} tasks (${done} done). Now: ${active.content}`
        : `Tracking ${todos.length} tasks (${done} done).`
    },
  })

  return { repo_overview, read, write, edit, bash, grep, glob, ls, ask_user, exit_plan_mode, todo_write }
}

function topLevelEntries(cwd: string, maxEntries: number): string {
  try {
    const entries = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => !OVERVIEW_IGNORED_DIRS.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
    const capped = entries.length > maxEntries ? `\n[… ${entries.length - maxEntries} more entries]` : ""
    return entries.slice(0, maxEntries).join("\n") + capped
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function gitOverview(cwd: string): string {
  try {
    const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd })
      .stdout.toString()
      .trim()
    if (!branch) return "not a git repository"
    const status = Bun.spawnSync(["git", "status", "--short"], { cwd }).stdout.toString().trim()
    const lines = status ? status.split("\n") : []
    const changed = lines.length ? `${lines.length} changed file(s)` : "clean"
    const shown = lines.slice(0, 12).join("\n")
    const capped = lines.length > 12 ? `\n[… ${lines.length - 12} more changed file(s)]` : ""
    return shown ? `branch ${branch}, ${changed}\n${shown}${capped}` : `branch ${branch}, ${changed}`
  } catch {
    return "not a git repository"
  }
}

function detectedManifests(cwd: string): string[] {
  return [
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "biome.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "deno.json",
  ].filter((file) => fs.existsSync(path.join(cwd, file)))
}

function readPackageJson(filePath: string): PackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PackageJson
  } catch {
    return undefined
  }
}

function packageSummary(pkg: PackageJson): string {
  const lines = [
    pkg.name ? `name: ${pkg.name}` : "",
    pkg.version ? `version: ${pkg.version}` : "",
    pkg.description ? `description: ${pkg.description}` : "",
    typeof pkg.private === "boolean" ? `private: ${pkg.private}` : "",
    pkg.workspaces ? `workspaces: ${workspacePatterns(pkg).join(", ")}` : "",
    pkg.scripts ? `scripts: ${Object.keys(pkg.scripts).sort().join(", ")}` : "",
  ].filter(Boolean)

  const deps = dependencyNames(pkg)
  if (deps.length) lines.push(`dependencies: ${deps.slice(0, 30).join(", ")}${deps.length > 30 ? ", …" : ""}`)
  return lines.join("\n") || "(no summary fields)"
}

function dependencyNames(pkg: PackageJson): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ].sort()
}

function workspacePatterns(pkg: PackageJson): string[] {
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces
  return pkg.workspaces?.packages ?? []
}

function workspacePackageSummaries(cwd: string, pkg: PackageJson, maxPackages: number): string {
  const packageDirs = workspacePackageDirs(cwd, pkg).slice(0, maxPackages)
  const lines = packageDirs
    .map((dir) => {
      const workspacePkg = readPackageJson(path.join(cwd, dir, "package.json"))
      if (!workspacePkg) return ""
      const scripts = workspacePkg.scripts
        ? ` scripts: ${Object.keys(workspacePkg.scripts).sort().join(", ")}`
        : ""
      const description = workspacePkg.description ? ` - ${workspacePkg.description}` : ""
      return `${dir}: ${workspacePkg.name ?? "(unnamed)"}${description}${scripts}`
    })
    .filter(Boolean)
  const allDirs = workspacePackageDirs(cwd, pkg)
  const capped =
    allDirs.length > maxPackages ? `\n[… ${allDirs.length - maxPackages} more workspace package(s)]` : ""
  return lines.join("\n") + capped
}

function workspacePackageDirs(cwd: string, pkg: PackageJson): string[] {
  const patterns = workspacePatterns(pkg)
  const dirs = new Set<string>()
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) continue
    const base = pattern.slice(0, -2)
    const absBase = path.join(cwd, base)
    if (!fs.existsSync(absBase)) continue
    for (const entry of fs.readdirSync(absBase, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(absBase, entry.name, "package.json"))) {
        dirs.add(path.join(base, entry.name))
      }
    }
  }

  if (dirs.size === 0) {
    const fallback = path.join(cwd, "packages")
    if (fs.existsSync(fallback)) {
      for (const entry of fs.readdirSync(fallback, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(fallback, entry.name, "package.json"))) {
          dirs.add(path.join("packages", entry.name))
        }
      }
    }
  }

  return [...dirs].sort()
}

function readReadmeExcerpt(cwd: string, maxChars: number): string | undefined {
  const file = ["README.md", "Readme.md", "readme.md"]
    .map((name) => path.join(cwd, name))
    .find((candidate) => fs.existsSync(candidate))
  if (!file) return undefined
  const content = fs.readFileSync(file, "utf8").trim()
  if (!content) return undefined
  const excerpt = content.slice(0, maxChars)
  return content.length > maxChars ? `${excerpt}\n[…]` : excerpt
}
