import fs from "node:fs"
import path from "node:path"
import { tool, type ToolSet } from "ai"
import { z } from "zod"
import type { Bus } from "../bus/bus"
import type { PermissionGate } from "../permission/permission"
import { applyEdit } from "./edit"
import { capLine, truncateMiddle } from "./truncate"

export interface ToolContext {
  cwd: string
  gate: PermissionGate
  bus: Bus
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

/** Human title for a tool invocation, shown in the TUI activity feed. */
export function toolTitle(toolName: string, input: any): string {
  switch (toolName) {
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
    default:
      return ""
  }
}

const DENIED = "Permission denied by user. Ask before retrying, or propose an alternative."

export function createTools(ctx: ToolContext): ToolSet {
  const { cwd, gate } = ctx

  const read = tool({
    description:
      "Read a file with line numbers. Prefer reading only the range you need via offset/limit instead of whole large files.",
    inputSchema: z.object({
      filePath: z.string().describe("Path to the file (relative to cwd or absolute)"),
      offset: z.number().int().min(1).optional().describe("1-based line to start from"),
      limit: z.number().int().min(1).optional().describe("Max lines to read (default 2000)"),
    }),
    execute: async ({ filePath, offset = 1, limit = 2000 }) => {
      const abs = resolvePath(cwd, filePath)
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) throw new Error(`${filePath} is a directory — use ls`)
      if (stat.size > 10_000_000) throw new Error(`${filePath} is ${stat.size} bytes — too large to read`)
      const lines = fs.readFileSync(abs, "utf8").split("\n")
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      if (slice.length === 0) return `[file has ${lines.length} lines — offset ${offset} is past the end]`
      const body = numberLines(slice.join("\n"), offset)
      const remaining = lines.length - (offset - 1 + slice.length)
      return remaining > 0 ? `${body}\n[… ${remaining} more lines — continue with offset=${offset + slice.length}]` : body
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
        detail: truncateMiddle(content, 2000),
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
        detail: `- ${truncateMiddle(oldString, 600)}\n+ ${truncateMiddle(newString, 600)}`,
      })
      if (!ok) return DENIED
      fs.writeFileSync(abs, updated)
      return `Edited ${relative(cwd, abs)}`
    },
  })

  const bash = tool({
    description:
      "Run a shell command in the project directory. Output is truncated in the middle when long.",
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
      "Search file contents with a regex (ripgrep). Use this to locate code before reading files.",
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression to search for"),
      path: z.string().optional().describe("Directory or file to search (default cwd)"),
      glob: z.string().optional().describe('Limit to files matching a glob, e.g. "*.ts"'),
    }),
    execute: async ({ pattern, path: searchPath, glob }) => {
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

  return { read, write, edit, bash, grep, glob, ls }
}
