import fs from "node:fs"
import path from "node:path"
import { type ToolSet, tool } from "ai"
import { z } from "zod"
import type { Bus } from "../bus/bus"
import { compactBudget, estimateTokens, maxReadChars, maxReadLines, ttlForKind } from "../context/budget"
import { compactToolOutput } from "../context/compact"
import type { ContextStore } from "../context/store"
import { getFileSummary } from "../context/summarize"
import type { ContextMode } from "../context/types"
import type { ContextWorkingSet } from "../context/working-set"
import type { Asker } from "../permission/asker"
import type { PermissionGate } from "../permission/permission"
import type { SkillBuffer } from "../skills/buffer"
import { findSkill } from "../skills/registry"
import type { Skill } from "../skills/types"
import { applyEdit } from "./edit"
import { createGitTools } from "./git"
import { capLine, capLines, truncateMiddle } from "./truncate"

export interface BgProcess {
  proc: ReturnType<typeof Bun.spawn>
  chunks: string[]
  done: boolean
}

export interface ToolContext {
  cwd: string
  gate: PermissionGate
  bus: Bus
  asker?: Asker
  contextStore?: ContextStore
  workingSet?: ContextWorkingSet
  contextMode?: ContextMode
  bgProcs?: Map<string, BgProcess>
  /** Tags stashed compaction blobs; informational. */
  sessionId?: string
  /** Called when a heavy tool output is compacted, so the agent can tally savings. */
  onCompaction?: (beforeTokens: number, afterTokens: number) => void
  /** Naive baseline: skip tool-output compaction. */
  naive?: boolean
  /**
   * When true (caching provider with a large context window), file/range reads use
   * a very high TTL so they stay resident until evicted by budget pressure rather
   * than expiring after N turns. Defaults to false (lean/tight eviction).
   */
  ampleBudget?: boolean
  /**
   * Per-session read registry: maps absolute file path → hash of content at read time.
   * Populated by the `read` tool; checked by `edit` to enforce read-before-edit discipline.
   * Persists across turns so a file read three turns ago is still considered "known" as long
   * as the on-disk content hasn't changed.
   */
  readRegistry?: Map<string, string>
  /** Discovered skills — used by the skill() tool to load bodies on demand. */
  skills?: Skill[]
  /** Session-persistent buffer for dynamically loaded skill bodies. */
  skillBuffer?: SkillBuffer
}

/** Tools whose string output can be large enough to be worth content-aware compaction. */
const HEAVY_OUTPUT_TOOLS = new Set([
  "bash",
  "bash_output",
  "grep",
  "glob",
  "ls",
  "web_fetch",
  "web_search",
  "repo_map",
  "find_symbol",
  "git_diff",
  "git_log",
])

const SYNTAX_LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
}

/**
 * Parse-check a file we just wrote and return a warning if it no longer parses.
 *
 * A truncated or unbalanced edit is the classic silent failure: the tool reports
 * success and the breakage surfaces turns later, after the model has built more work
 * on top of it. Parsing is sub-millisecond and needs no project config, so the model
 * learns within the same step — unlike a full typecheck, which is advertised in the
 * system prompt for the model to run when it wants project-wide verification.
 */
function syntaxWarning(absPath: string, content: string): string {
  const ext = path.extname(absPath).toLowerCase()
  try {
    if (ext === ".json") {
      JSON.parse(content)
      return ""
    }
    const loader = SYNTAX_LOADERS[ext]
    if (!loader) return ""
    new Bun.Transpiler({ loader }).transformSync(content)
    return ""
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).split("\n").slice(0, 4).join("\n")
    return (
      `\n\n⚠️ The file no longer parses after this change:\n${detail}\n` +
      `Re-read the affected region and fix the syntax before moving on.`
    )
  }
}

function resolvePath(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
}

function relative(cwd: string, p: string): string {
  const rel = path.relative(cwd, p)
  return rel.startsWith("..") ? p : rel || "."
}

/** Fast content fingerprint for change detection (not cryptographic — just drift detection). */
function contentHash(content: string): string {
  return String(Bun.hash(content))
}

/**
 * Given a string that wasn't found as an exact match, find the closest region in
 * the file and return it with line numbers so the model can self-correct.
 */
function findNearestMatch(content: string, oldString: string): string | undefined {
  const needle = oldString.split("\n")[0]?.trim()
  if (!needle || needle.length < 4) return undefined
  const lines = content.split("\n")
  const idx = lines.findIndex((l) => l.trim() === needle || (needle.length > 8 && l.includes(needle)))
  if (idx === -1) return undefined
  const windowLines = oldString.split("\n").length
  const start = Math.max(0, idx - 2)
  const end = Math.min(lines.length - 1, idx + windowLines + 1)
  return lines
    .slice(start, end + 1)
    .map((l, i) => `${String(start + i + 1).padStart(5)}→${l}`)
    .join("\n")
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
    case "repo_map":
      return input?.dirFilter ? `map of ${input.dirFilter}` : "repo map"
    case "find_symbol":
      return String(input?.symbol ?? "")
    case "bash":
      return String(input?.command ?? "").slice(0, 80)
    case "read":
    case "write":
    case "edit":
      return String(input?.filePath ?? "")
    case "multi_edit":
      return `${input?.filePath ?? ""} (${Array.isArray(input?.edits) ? input.edits.length : 0} changes)`
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
    case "git_status":
      return ""
    case "git_diff":
      return input?.staged ? "staged" : input?.path ? String(input.path) : "unstaged"
    case "git_log":
      return input?.path ? String(input.path) : `last ${input?.limit ?? 10}`
    case "git_commit":
      return String(input?.message ?? "").slice(0, 60)
    case "git_push":
      return `${input?.remote ?? "origin"}${input?.branch ? `/${input.branch}` : ""}`
    case "gh_pr_create":
      return String(input?.title ?? "").slice(0, 60)
    default:
      return ""
  }
}

/** Concise semantic result for a completed tool call, shown in the activity feed. */
export function toolResultSummary(toolName: string, input: any, output: unknown): string {
  const out = String(output ?? "")
  switch (toolName) {
    case "read": {
      // Count numbered lines (format: "    N→content")
      const lineCount = out.split("\n").filter((l) => /^\s*\d+→/.test(l)).length
      return lineCount > 0 ? `Read ${lineCount} line${lineCount === 1 ? "" : "s"}` : "Read"
    }
    case "grep": {
      if (out === "No matches found") return "no matches"
      const matches = out.split("\n").filter(Boolean).length
      return `${matches} match${matches === 1 ? "" : "es"}`
    }
    case "glob": {
      if (out === "No files match") return "no files"
      const count = out.split("\n").filter((l) => l && !l.startsWith("[")).length
      return `${count} file${count === 1 ? "" : "s"}`
    }
    case "ls": {
      if (out === "(empty directory)") return "empty"
      const count = out.split("\n").filter((l) => l && !l.startsWith("[")).length
      return `${count} entr${count === 1 ? "y" : "ies"}`
    }
    case "edit": {
      const added = (String(input?.newString ?? "").match(/\n/g) ?? []).length + 1
      const removed = (String(input?.oldString ?? "").match(/\n/g) ?? []).length + 1
      return `+${added} −${removed}`
    }
    case "write": {
      const lines = String(input?.content ?? "").split("\n").length
      return `Wrote ${lines} line${lines === 1 ? "" : "s"}`
    }
    case "bash": {
      const exitMatch = out.match(/\[exit code (\d+)\]$/)
      if (exitMatch) return `exit ${exitMatch[1]}`
      const lineCount = out.split("\n").filter(Boolean).length
      return lineCount > 1 ? `ok · ${lineCount} lines` : "ok"
    }
    case "repo_overview":
      return "snapshot"
    case "repo_map": {
      const fileCount = out.split("\n").filter((l) => l && !l.startsWith("Repository")).length
      return `${fileCount} file${fileCount === 1 ? "" : "s"}`
    }
    case "find_symbol": {
      const hits = out.split("\n").filter((l) => /:\d+:/.test(l)).length
      return hits > 0 ? `${hits} site${hits === 1 ? "" : "s"}` : "not found"
    }
    case "web_fetch": {
      const domain = (() => {
        try {
          return new URL(String(out)).hostname
        } catch {
          return ""
        }
      })()
      const lines = out.split("\n").filter(Boolean).length
      return domain ? `fetched ${domain}` : `${lines} line${lines === 1 ? "" : "s"}`
    }
    case "web_search": {
      if (out.startsWith("Search not configured")) return "not configured"
      const results = out.split("\n\n").filter(Boolean).length
      return `${results} result${results === 1 ? "" : "s"}`
    }
    case "bash_background":
      return out.startsWith("Started") ? `started ${out.match(/id: (\w+)/)?.[1] ?? ""}`.trim() : out
    case "bash_output": {
      const status = out.match(/\[(bg\w+)\] (\w+)/)?.[2] ?? ""
      return status || "polled"
    }
    case "bash_kill":
      return out.startsWith("Stopped") ? "killed" : out
    case "todo_write": {
      const todos = Array.isArray(input?.todos) ? input.todos : []
      const done = todos.filter((t: any) => t?.status === "completed").length
      return `${todos.length} task${todos.length === 1 ? "" : "s"} · ${done} done`
    }
    case "git_status": {
      if (out.startsWith("Not a git")) return "not a git repo"
      const changed = (out.match(/^[MADRCU?!]/gm) ?? []).length
      return changed === 0 ? "clean" : `${changed} file${changed === 1 ? "" : "s"} changed`
    }
    case "git_diff": {
      const insertions = Number(out.match(/(\d+) insertion/)?.[1] ?? 0)
      const deletions = Number(out.match(/(\d+) deletion/)?.[1] ?? 0)
      if (!insertions && !deletions) return "no diff"
      return `+${insertions} −${deletions}`
    }
    case "git_log": {
      const lines = out.split("\n").filter(Boolean).length
      return `${lines} commit${lines === 1 ? "" : "s"}`
    }
    case "git_commit":
      return out.startsWith("Permission denied") ? "denied" : (out.split("\n")[0] ?? "committed")
    case "git_push":
      return out.startsWith("Permission denied") ? "denied" : "pushed"
    case "gh_pr_create":
      return out.startsWith("Permission denied")
        ? "denied"
        : out.startsWith("http")
          ? "PR created"
          : (out.split("\n")[0] ?? "done")
    default: {
      const first = out.split("\n")[0] ?? ""
      return first.length > 80 ? `${first.slice(0, 80)}…` : first
    }
  }
}

/**
 * Capped diff/content preview for a tool call — shared by the permission dialog
 * and the TUI activity feed so both show the same thing.
 */
export function toolPreview(toolName: string, input: any): string | undefined {
  switch (toolName) {
    case "edit": {
      const oldLines = String(input?.oldString ?? "")
        .split("\n")
        .map((l: string) => `- ${l}`)
      const newLines = String(input?.newString ?? "")
        .split("\n")
        .map((l: string) => `+ ${l}`)
      return capLines([...oldLines, ...newLines].join("\n"), 14, 80)
    }
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
  const ampleBudget = ctx.ampleBudget ?? false

  const repo_overview = tool({
    description:
      "Compact repo snapshot: top-level files, manifests, README excerpt, packages, scripts, dependencies, git status. Use before broad project questions; then grep/read for exact claims.",
    inputSchema: z.object({}),
    execute: async () => buildRepoOverview(cwd),
  })

  const read = tool({
    description:
      "Read a real file with line numbers after locating it with grep/glob/ls or a user-provided path. Prefer only the needed range via offset/limit; cite these line numbers for repo/code claims.",
    inputSchema: z.object({
      filePath: z.string().describe("Path to the file (relative to cwd or absolute)"),
      offset: z.number().int().min(1).optional().describe("1-based line to start from"),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          `Max lines per call (default and hard cap ${maxReadLines(mode)} — larger requests are capped; a partial read ends with a "continue with offset=N" marker)`,
        ),
    }),
    execute: async ({ filePath, offset = 1, limit = maxReadLines(mode) }, { toolCallId } = {} as any) => {
      const abs = resolvePath(cwd, filePath)
      let stat: ReturnType<typeof fs.statSync>
      try {
        stat = fs.statSync(abs)
      } catch {
        // Try inserting /src/ after the package root (e.g. packages/foo/bar → packages/foo/src/bar)
        const withSrc = filePath.replace(/^(packages\/[^/]+)\/(?!src\/)/, "$1/src/")
        const absSrc = withSrc !== filePath ? resolvePath(cwd, withSrc) : null
        if (absSrc && fs.existsSync(absSrc)) {
          throw new Error(`File not found: ${filePath}\n\nDid you mean: ${withSrc}?`)
        }
        throw new Error(`File not found: ${filePath}\n\nVerify the path with ls or repo_map.`)
      }
      if (stat.isDirectory()) throw new Error(`${filePath} is a directory — use ls`)
      if (stat.size > 10_000_000) throw new Error(`${filePath} is ${stat.size} bytes — too large to read`)
      const cappedLimit = Math.min(limit, maxReadLines(mode))
      const relPath = relative(cwd, abs)
      if (ctx.workingSet?.hasFileRange(relPath, offset, offset + cappedLimit - 1)) {
        return `[already in context: ${relPath} lines ${offset}–${offset + cappedLimit - 1}. No need to re-read unless you've edited it since.]`
      }
      const rawContent = fs.readFileSync(abs, "utf8")
      // Register content hash so edit can verify the file hasn't drifted since this read
      if (ctx.readRegistry) ctx.readRegistry.set(abs, contentHash(rawContent))
      const lines = rawContent.split("\n")
      let slice = lines.slice(offset - 1, offset - 1 + cappedLimit)
      if (slice.length === 0) return `[file has ${lines.length} lines — offset ${offset} is past the end]`
      // Total char ceiling: keep whole lines up to the cap (always at least one)
      // so the "continue with offset=N" marker below stays accurate.
      const charCap = maxReadChars(mode)
      let used = 0
      let kept = 0
      for (const line of slice) {
        used += Math.min(line.length, 2000) + 8
        if (used > charCap && kept > 0) break
        kept++
      }
      if (kept < slice.length) slice = slice.slice(0, kept)
      const body = numberLines(slice.join("\n"), offset)
      ctx.workingSet?.add({
        kind: "file-range",
        path: relPath,
        startLine: offset,
        endLine: offset + slice.length - 1,
        content: body,
        reason: "read tool",
        ttl: ttlForKind(mode, "file-range", ampleBudget),
        estimatedTokens: estimateTokens(body),
        // The same body is the tool result in history; tagging it lets the planner
        // send one copy, not both, until history trimming drops the original.
        toolCallId,
      })
      if (ctx.contextStore) {
        const summary = getFileSummary({ cwd, path: relPath, store: ctx.contextStore })
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
      return `Wrote ${content.split("\n").length} lines to ${relative(cwd, abs)}${syntaxWarning(abs, content)}`
    },
  })

  // Read-before-edit discipline: the model must have read the file this session
  // and the content must not have drifted since then.
  const assertFreshRead = (abs: string, content: string): void => {
    if (!ctx.readRegistry) return
    const knownHash = ctx.readRegistry.get(abs)
    if (!knownHash) {
      throw new Error(
        `You haven't read ${relative(cwd, abs)} yet this session. Use the read tool on it first, then retry the edit.`,
      )
    }
    const currentHash = contentHash(content)
    if (currentHash !== knownHash) {
      // Update the registry so the next edit attempt doesn't re-flag this
      ctx.readRegistry.set(abs, currentHash)
      throw new Error(
        `${relative(cwd, abs)} has changed since you last read it. Re-read it with the read tool, then retry the edit.`,
      )
    }
  }

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
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath} — use write to create it`)
      const content = fs.readFileSync(abs, "utf8")
      assertFreshRead(abs, content)
      let updated: string
      try {
        updated = applyEdit(content, oldString, newString, replaceAll)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("not found")) {
          const nearest = findNearestMatch(content, oldString)
          const hint = nearest
            ? `\n\nClosest match found in ${relative(cwd, abs)}:\n${nearest}\n\nCheck indentation and whitespace — oldString must match the file exactly.`
            : `\n\nNo similar region found. Verify the file path and re-read the file before retrying.`
          throw new Error(`${msg}${hint}`)
        }
        if (msg.startsWith("oldString matches")) {
          // Find line numbers of each occurrence to give the model precise re-read targets
          const firstLine = (oldString.split("\n")[0] ?? "").trim()
          const fileLines = content.split("\n")
          const matchLines: number[] = []
          for (let i = 0; i < fileLines.length; i++) {
            if (firstLine && fileLines[i]?.includes(firstLine)) matchLines.push(i + 1)
          }
          const lineHint =
            matchLines.length > 0
              ? `\n\nOccurrences near lines: ${matchLines.join(", ")} in ${relative(cwd, abs)}. ` +
                `Re-read the file around those lines, then extend oldString with 3–5 lines of surrounding context to make it unique.`
              : `\n\nRe-read ${relative(cwd, abs)} around the target section and extend oldString with more surrounding context.`
          throw new Error(`${msg}${lineHint}`)
        }
        throw err
      }
      const ok = await gate.ask({
        tool: "edit",
        title: `Edit ${relative(cwd, abs)}`,
        detail: toolPreview("edit", { oldString, newString }),
      })
      if (!ok) return DENIED
      // Update registry with new hash after the edit is written
      fs.writeFileSync(abs, updated)
      if (ctx.readRegistry) ctx.readRegistry.set(abs, contentHash(updated))
      return `Edited ${relative(cwd, abs)}${syntaxWarning(abs, updated)}`
    },
  })

  const multi_edit = tool({
    description:
      "Apply several exact-string replacements to ONE file atomically (one permission prompt). Each edit's oldString must match exactly once in the file as left by the previous edits. Prefer this over repeated edit calls when changing multiple spots in the same file.",
    inputSchema: z.object({
      filePath: z.string(),
      edits: z
        .array(
          z.object({
            oldString: z.string(),
            newString: z.string(),
            replaceAll: z.boolean().optional(),
          }),
        )
        .min(1),
    }),
    execute: async ({ filePath, edits }) => {
      const abs = resolvePath(cwd, filePath)
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath} — use write to create it`)
      const content = fs.readFileSync(abs, "utf8")
      assertFreshRead(abs, content)
      // All-or-nothing: apply in memory first; any failure aborts the whole call.
      let updated = content
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i]
        if (!e) continue
        try {
          updated = applyEdit(updated, e.oldString, e.newString, e.replaceAll)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(
            `multi_edit hunk ${i + 1}/${edits.length} failed: ${msg}\n` +
              `No changes were written. Fix that hunk (or use single edit calls for detailed match hints) and retry.`,
          )
        }
      }
      const preview = edits
        .map((e) => toolPreview("edit", e))
        .filter(Boolean)
        .join("\n---\n")
      const ok = await gate.ask({
        tool: "edit",
        title: `Edit ${relative(cwd, abs)} (${edits.length} changes)`,
        detail: preview,
      })
      if (!ok) return DENIED
      fs.writeFileSync(abs, updated)
      if (ctx.readRegistry) ctx.readRegistry.set(abs, contentHash(updated))
      return `Applied ${edits.length} edits to ${relative(cwd, abs)}${syntaxWarning(abs, updated)}`
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
      "Search real file contents with a regex (ripgrep if available, otherwise grep). Use this first to locate repo/code truth before reading files; don't guess paths, symbols, or behavior from memory.",
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
    description:
      'Find real files by glob pattern, e.g. "src/**/*.ts". Returns paths relative to cwd; use before read when the path is uncertain.',
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
    description:
      "List a real directory. Directories have a trailing slash; use to verify project structure before relying on paths.",
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
      "Ask the user a multiple-choice question to resolve a decision only they can make; use sparingly.",
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
      "Call only in plan mode, after presenting a complete plan; shows it to the user for approval before any files change.",
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
      "Record or update the task checklist. Pass the FULL list every call (it replaces the previous one). content = short imperative; activeForm = its present-continuous form; keep exactly one item in_progress. Use for tasks with 3+ steps; skip for trivial work.",
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

  const WEB_FETCH_MAX_CHARS = 12_000

  const web_fetch = tool({
    description:
      "Fetch a URL and return its text content (HTML stripped). Use before relying on links or docs; if fetching fails, report that instead of simulating content.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to fetch"),
    }),
    execute: async ({ url }) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const contentType = res.headers.get("content-type") ?? ""
      let text = await res.text()
      if (contentType.includes("html")) {
        // Strip tags, collapse whitespace
        text = text
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/\s{2,}/g, " ")
          .trim()
      }
      const capped = truncateMiddle(text, WEB_FETCH_MAX_CHARS)
      const domain = new URL(url).hostname
      ctx.workingSet?.add({
        kind: "tool-result",
        content: capped,
        reason: `web_fetch ${domain}`,
        ttl: ttlForKind(mode, "tool-result"),
        estimatedTokens: estimateTokens(capped),
      })
      return capped
    },
  })

  const web_search = tool({
    description:
      "Search the web for current external information. Requires BRAVE_API_KEY or TAVILY_API_KEY; if unconfigured, use web_fetch with a known URL or say search is unavailable.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
    }),
    execute: async ({ query }) => {
      const braveKey = process.env.BRAVE_API_KEY
      const tavilyKey = process.env.TAVILY_API_KEY

      if (braveKey) {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`
        const res = await fetch(url, {
          headers: { Accept: "application/json", "X-Subscription-Token": braveKey },
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`Brave search HTTP ${res.status}`)
        const data = (await res.json()) as {
          web?: { results?: Array<{ title: string; url: string; description?: string }> }
        }
        const results = data.web?.results ?? []
        return (
          results.map((r) => `${r.title}\n${r.url}\n${r.description ?? ""}`).join("\n\n") || "No results."
        )
      }

      if (tavilyKey) {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5 }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`Tavily search HTTP ${res.status}`)
        const data = (await res.json()) as {
          results?: Array<{ title: string; url: string; content?: string }>
        }
        return (
          (data.results ?? []).map((r) => `${r.title}\n${r.url}\n${r.content ?? ""}`).join("\n\n") ||
          "No results."
        )
      }

      return "Search not configured. Set BRAVE_API_KEY or TAVILY_API_KEY, or use web_fetch with a known URL."
    },
  })

  // Background process registry (shared across tool instances in this session)
  const bgProcs: Map<string, BgProcess> = ctx.bgProcs ?? new Map()
  let bgCounter = 0

  const bash_background = tool({
    description:
      "Run a shell command in the background; returns a process id to poll with bash_output or stop with bash_kill. Use for dev servers, watchers, long builds.",
    inputSchema: z.object({
      command: z.string(),
    }),
    execute: async ({ command }) => {
      const ok = await gate.ask({ tool: "bash", title: `[background] ${command}` })
      if (!ok) return DENIED
      const id = `bg${++bgCounter}`
      const proc = Bun.spawn(["bash", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      const entry: BgProcess = { proc, chunks: [], done: false }
      bgProcs.set(id, entry)
      // Stream output into chunks asynchronously
      ;(async () => {
        const reader = proc.stdout.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          entry.chunks.push(decoder.decode(value))
        }
      })().catch(() => {})
      ;(async () => {
        const reader = proc.stderr.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          entry.chunks.push(`[stderr] ${decoder.decode(value)}`)
        }
      })().catch(() => {})
      proc.exited
        .then(() => {
          entry.done = true
        })
        .catch(() => {
          entry.done = true
        })
      return `Started background process (id: ${id}). Use bash_output to check output or bash_kill to stop it.`
    },
  })

  const bash_output = tool({
    description: "Return new output from a background process and whether it is still running.",
    inputSchema: z.object({
      id: z.string().describe("Process ID returned by bash when run_in_background was used"),
    }),
    execute: async ({ id }) => {
      const entry = bgProcs.get(id)
      if (!entry) return `No background process with id "${id}".`
      const output = entry.chunks.splice(0).join("")
      const status = entry.done ? "exited" : "running"
      const trimmed = truncateMiddle(output.trimEnd() || "(no new output)", 4000)
      return `[${id}] ${status}\n${trimmed}`
    },
  })

  const bash_kill = tool({
    description: "Stop a background process started with bash (run_in_background).",
    inputSchema: z.object({
      id: z.string().describe("Process ID to stop"),
    }),
    execute: async ({ id }) => {
      const entry = bgProcs.get(id)
      if (!entry) return `No background process with id "${id}".`
      try {
        entry.proc.kill()
      } catch {
        // already exited
      }
      entry.done = true
      bgProcs.delete(id)
      return `Stopped ${id}.`
    },
  })

  const expand = tool({
    description:
      "Retrieve the full, uncompacted output that an earlier tool result elided. When a tool result ends " +
      'with an «expand:HASH …» marker, its output was compacted to save tokens — call expand("HASH") to get ' +
      "the original. Narrow it with a regex pattern or offset/limit instead of pulling everything back.",
    inputSchema: z.object({
      hash: z.string().describe("The hash from an «expand:…» marker"),
      pattern: z.string().optional().describe("Only return lines matching this regex"),
      offset: z.number().int().min(1).optional().describe("1-based line to start from"),
      limit: z.number().int().min(1).optional().describe("Max lines to return"),
    }),
    execute: async ({ hash, pattern, offset, limit }) => {
      const blob = ctx.contextStore?.getBlob(hash)
      if (!blob)
        return `No stored output for hash "${hash}" — it may have been evicted. Re-run the original command if you still need it.`
      let lines = blob.content.split("\n")
      if (pattern) {
        let re: RegExp
        try {
          re = new RegExp(pattern)
        } catch {
          return `Invalid regex: ${pattern}`
        }
        lines = lines.filter((l) => re.test(l))
        if (lines.length === 0) return `No lines in the stored output match /${pattern}/.`
      }
      const start = offset ? offset - 1 : 0
      const slice = lines.slice(start, start + (limit ?? lines.length))
      const body = truncateMiddle(slice.join("\n"))
      const remaining = lines.length - (start + slice.length)
      return remaining > 0
        ? `${body}\n[… ${remaining} more lines — continue with offset=${start + slice.length + 1}]`
        : body
    },
  })

  const skill = tool({
    description:
      "Load the full instructions for a named skill (listed under # Skills in the system prompt) when the task matches its description.",
    inputSchema: z.object({
      name: z.string().describe("Skill name from the # Skills catalog"),
    }),
    execute: async ({ name }) => {
      const found = ctx.skills ? findSkill(ctx.skills, name) : undefined
      if (!found) {
        const available = ctx.skills?.map((s) => s.name).join(", ") ?? "none"
        return `No skill named "${name}". Available skills: ${available}`
      }
      if (ctx.skillBuffer?.has(name)) return `Skill "${name}" is already loaded in context.`
      ctx.skillBuffer?.load(found)
      return `Loaded skill "${name}". Its instructions are now in context — follow them for this session.`
    },
  })

  const repo_map = tool({
    description:
      "Importance-ranked map of the repo: directories, files, key exported symbols. Use to orient before grep/read. expand=true for more files; dirFilter to focus on a subdirectory.",
    inputSchema: z.object({
      dirFilter: z
        .string()
        .optional()
        .describe("Limit output to files under this directory (relative to cwd)"),
      expand: z.boolean().optional().describe("Include more files and symbols (default: concise view)"),
    }),
    execute: async ({ dirFilter, expand: expandView }) => {
      if (!ctx.contextStore) return "no index available — run `dawn index` first"
      const maxFiles = expandView ? 150 : 60
      const maxSymbolsPerFile = expandView ? 12 : 6
      const entries = ctx.contextStore.allIndexEntries(cwd)
      if (entries.length === 0) return "repo index is empty — run `dawn index` to build it"
      const filter = dirFilter ? path.resolve(cwd, dirFilter) : null
      const filtered = filter ? entries.filter((e) => path.resolve(cwd, e.path).startsWith(filter)) : entries
      // Rank by: has symbols > has imports > file size (larger = more important)
      const ranked = [...filtered].sort((a, b) => {
        const aScore = a.symbols.length * 10 + a.imports.length + Math.min(a.size / 1000, 5)
        const bScore = b.symbols.length * 10 + b.imports.length + Math.min(b.size / 1000, 5)
        return bScore - aScore
      })
      const lines = [
        `Repository map (${filtered.length} files, top ${Math.min(maxFiles, ranked.length)} shown):`,
      ]
      for (const entry of ranked.slice(0, maxFiles)) {
        const syms = entry.symbols.slice(0, maxSymbolsPerFile)
        const symStr = syms.length > 0 ? `  → ${syms.join(", ")}` : ""
        lines.push(`${entry.path}${symStr}`)
      }
      return lines.join("\n")
    },
  })

  const find_symbol = tool({
    description:
      "Find where a symbol is defined and referenced across the repo (definitions first). Use to jump to the right lines before reading.",
    inputSchema: z.object({
      symbol: z.string().describe("Symbol name to search for"),
      definitionOnly: z.boolean().optional().describe("Only return definition sites, not all usages"),
    }),
    execute: async ({ symbol, definitionOnly }) => {
      // First: check the symbol index for known definitions
      const symbolPattern = definitionOnly
        ? `(export\\s+)?(function|class|const|let|var|type|interface|enum)\\s+${symbol}\\b`
        : symbol
      const maxResults = 40

      if (await rgAvailable) {
        const defArgs = ["--no-heading", "-n", "--color=never", "-S", "-m", String(maxResults)]
        const defPattern = `(export\\s+)?(function|class|const|let|var|type|interface|enum|def|fn|pub fn)\\s+${symbol}\\b`
        defArgs.push("--", defPattern, ".")
        const defProc = Bun.spawn(["rg", ...defArgs], { cwd, stdout: "pipe", stderr: "pipe" })
        const [defOut, , defCode] = await Promise.all([
          new Response(defProc.stdout).text(),
          new Response(defProc.stderr).text(),
          defProc.exited,
        ])
        const defs = defCode === 0 ? defOut.trimEnd() : ""

        if (definitionOnly) {
          return defs || `no definition of '${symbol}' found`
        }

        // Also search for all usages
        const useArgs = ["--no-heading", "-n", "--color=never", "-S", "-m", "20", "--", symbol, "."]
        const useProc = Bun.spawn(["rg", ...useArgs], { cwd, stdout: "pipe", stderr: "pipe" })
        const [useOut, , useCode] = await Promise.all([
          new Response(useProc.stdout).text(),
          new Response(useProc.stderr).text(),
          useProc.exited,
        ])
        const usages = useCode === 0 ? useOut.trimEnd() : ""

        const parts: string[] = []
        if (defs) parts.push(`Definitions of '${symbol}':\n${defs}`)
        if (usages && !definitionOnly) parts.push(`Usages of '${symbol}':\n${truncateMiddle(usages, 5000)}`)
        return parts.join("\n\n") || `'${symbol}' not found`
      }

      // Fallback to grep
      const grepArgs = ["-rn", "-m", String(maxResults), "--", symbolPattern, "."]
      const proc = Bun.spawn(["grep", ...grepArgs], { cwd, stdout: "pipe", stderr: "pipe" })
      const [out, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return code === 0 ? truncateMiddle(out.trimEnd(), 8000) : `'${symbol}' not found`
    },
  })

  const gitTools = createGitTools(cwd, gate)

  const tools: ToolSet = {
    repo_overview,
    repo_map,
    find_symbol,
    read,
    write,
    edit,
    multi_edit,
    bash,
    bash_background,
    bash_output,
    bash_kill,
    grep,
    glob,
    ls,
    ask_user,
    exit_plan_mode,
    todo_write,
    web_fetch,
    web_search,
    expand,
    ...gitTools,
    ...(ctx.skills && ctx.skills.length > 0 ? { skill } : {}),
  }
  return withCompaction(tools, ctx)
}

/**
 * Wraps heavy-output tools so their string results pass through the compaction engine
 * before reaching the model. Compaction is once-only at execution time and deterministic,
 * so the compacted text is what lands in both history and the working set. A no-op when
 * there's no context store to stash originals for retrieval.
 */
function withCompaction(tools: ToolSet, ctx: ToolContext): ToolSet {
  if (!ctx.contextStore) return tools
  const budget = compactBudget(ctx.contextMode ?? "balanced")
  const wrapped: ToolSet = {}
  for (const [name, def] of Object.entries(tools)) {
    const d = def as any
    if (!HEAVY_OUTPUT_TOOLS.has(name) || typeof d.execute !== "function") {
      wrapped[name] = def
      continue
    }
    const original = d.execute.bind(d)
    wrapped[name] = {
      ...d,
      execute: async (input: any, options: any) => {
        const out = await original(input, options)
        if (typeof out !== "string") return out
        const outcome = compactToolOutput(out, {
          tool: name,
          budget,
          store: ctx.contextStore,
          sessionId: ctx.sessionId,
          naive: ctx.naive,
        })
        if (outcome.compacted) ctx.onCompaction?.(outcome.beforeTokens, outcome.afterTokens)
        return outcome.text
      },
    }
  }
  return wrapped
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

/**
 * Tools that have filesystem or shell side effects and must not be shown to the model
 * while in plan mode. Non-destructive inspection tools and UX tools are excluded from
 * this set and remain visible in all modes.
 */
const SIDE_EFFECTING_TOOLS = new Set([
  "write",
  "edit",
  "multi_edit",
  "bash",
  "bash_background",
  "bash_kill",
  "git_commit",
])

/**
 * Returns a filtered copy of the toolset that is appropriate for the current mode.
 * In plan mode: side-effecting tools are removed so the model never attempts them.
 * Config "deny" rules: those tools are removed entirely (saves tokens + prevents attempts).
 * Config "allow" rules are handled at gate.preAllow() time; "ask" is the reactive default.
 */
export function visibleTools(
  all: ToolSet,
  mode: "normal" | "acceptEdits" | "plan",
  permissions?: Record<string, "allow" | "ask" | "deny">,
): ToolSet {
  const result: ToolSet = {}
  for (const [name, def] of Object.entries(all)) {
    if (mode === "plan" && SIDE_EFFECTING_TOOLS.has(name)) continue
    if (permissions?.[name] === "deny") continue
    result[name] = def
  }
  return result
}

/**
 * Estimated tokens the tool schemas add to every request (names + descriptions +
 * JSON Schemas). Core tools carry zod schemas (serialized via z.toJSONSchema);
 * MCP tools carry an ai-SDK `jsonSchema` wrapper. Without this figure the context
 * plan understates every request by the size of the schema payload.
 */
export function estimateToolSchemaTokens(tools: ToolSet): number {
  let chars = 0
  for (const [name, def] of Object.entries(tools)) {
    chars += name.length + (def.description?.length ?? 0)
    const schema: unknown = (def as { inputSchema?: unknown }).inputSchema
    try {
      if (schema && typeof schema === "object" && "jsonSchema" in schema) {
        chars += JSON.stringify((schema as { jsonSchema: unknown }).jsonSchema).length
      } else if (schema) {
        chars += JSON.stringify(z.toJSONSchema(schema as never)).length
      }
    } catch {
      chars += 200
    }
  }
  return Math.ceil(chars / 4)
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
