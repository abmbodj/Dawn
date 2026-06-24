import { tool } from "ai"
import { z } from "zod"
import type { PermissionGate } from "../permission/gate"
import { truncateMiddle } from "./truncate"

const DENIED = "Permission denied by user. Ask before retrying, or propose an alternative."

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode }
}

/** Check if `gh` CLI is available and authenticated. */
async function ghAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["gh", "auth", "status"], { stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

export function createGitTools(cwd: string, gate: PermissionGate) {
  const git_status = tool({
    description:
      "Show the git working tree status: current branch, staged files, unstaged changes, and untracked files. Call this before committing to confirm the right files are staged.",
    inputSchema: z.object({}),
    execute: async () => {
      const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
      if (branch.exitCode !== 0) return "Not a git repository"
      const status = await runGit(["status", "--short"], cwd)
      const log = await runGit(["log", "--oneline", "-5"], cwd)
      const parts: string[] = [`Branch: ${branch.stdout}`]
      parts.push(status.stdout || "(clean — nothing to commit)")
      if (log.stdout) parts.push(`\nRecent commits:\n${log.stdout}`)
      return parts.join("\n")
    },
  })

  const git_diff = tool({
    description:
      "Show git diffs. staged=true shows staged (--cached) changes, staged=false shows unstaged. Optionally filter to a specific file path.",
    inputSchema: z.object({
      staged: z.boolean().optional().describe("Show staged (cached) diff. Default: false (unstaged)"),
      path: z.string().optional().describe("Limit diff to this file or directory"),
    }),
    execute: async ({ staged = false, path: filePath }) => {
      const args = ["diff", "--stat", staged ? "--cached" : "", filePath ?? ""].filter(Boolean)
      const stat = await runGit(args, cwd)
      const diffArgs = ["diff", staged ? "--cached" : "", filePath ?? ""].filter(Boolean)
      const diff = await runGit(diffArgs, cwd)
      if (!diff.stdout && !stat.stdout) return staged ? "Nothing staged" : "No unstaged changes"
      return truncateMiddle(`${stat.stdout}\n\n${diff.stdout}`.trim(), 20_000)
    },
  })

  const git_log = tool({
    description: "Show recent git commit history with SHA, author, date, and message.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional().describe("Number of commits to show. Default: 10"),
      path: z.string().optional().describe("Limit to commits that touched this file or directory"),
    }),
    execute: async ({ limit = 10, path: filePath }) => {
      const args = ["log", `--oneline`, `--decorate`, `-${limit}`]
      if (filePath) args.push("--", filePath)
      const result = await runGit(args, cwd)
      return result.stdout || "No commits yet"
    },
  })

  const git_commit = tool({
    description:
      "Stage files and create a git commit. Always run git_status first to confirm what you're committing. Requires explicit user approval — never auto-commit without direction.",
    inputSchema: z.object({
      message: z.string().describe("Commit message"),
      files: z
        .union([z.array(z.string()), z.literal("all")])
        .describe('Files to stage, or "all" to stage all tracked changes (git add -u)'),
    }),
    execute: async ({ message, files }) => {
      const preview = `commit "${message.slice(0, 60)}${message.length > 60 ? "…" : ""}" (${files === "all" ? "all changes" : `${files.length} file${files.length === 1 ? "" : "s"}`})`
      const ok = await gate.ask({ tool: "git_commit", title: preview })
      if (!ok) return DENIED

      // Stage
      const addArgs = files === "all" ? ["add", "-u"] : ["add", "--", ...files]
      const addResult = await runGit(addArgs, cwd)
      if (addResult.exitCode !== 0) return `git add failed:\n${addResult.stderr}`

      // Check there's something to commit
      const staged = await runGit(["diff", "--cached", "--stat"], cwd)
      if (!staged.stdout) return "Nothing staged after git add — nothing to commit"

      // Commit
      const commitResult = await runGit(["commit", "-m", message], cwd)
      if (commitResult.exitCode !== 0) return `git commit failed:\n${commitResult.stderr}`
      return commitResult.stdout
    },
  })

  const git_push = tool({
    description: "Push the current branch to the remote. Requires explicit user direction.",
    inputSchema: z.object({
      remote: z.string().optional().describe("Remote name. Default: origin"),
      branch: z.string().optional().describe("Branch to push. Default: current branch"),
      force: z
        .boolean()
        .optional()
        .describe("Force push with --force-with-lease. Only use when you understand the consequences"),
    }),
    execute: async ({ remote = "origin", branch, force = false }) => {
      const branchResult = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
      const currentBranch = branchResult.stdout || "HEAD"
      const targetBranch = branch ?? currentBranch
      const preview = `push ${remote}/${targetBranch}${force ? " (force-with-lease)" : ""}`
      const ok = await gate.ask({ tool: "git_push", title: preview })
      if (!ok) return DENIED

      const args = ["push", remote, `${targetBranch}:${targetBranch}`]
      if (force) args.push("--force-with-lease")
      const result = await runGit(args, cwd)
      if (result.exitCode !== 0) {
        const msg = result.stderr || result.stdout
        return `git push failed:\n${msg}`
      }
      return result.stderr || result.stdout || "Pushed successfully"
    },
  })

  const gh_pr_create = tool({
    description:
      "Create a GitHub pull request using the gh CLI. Requires gh to be installed and authenticated (run `gh auth login` if needed). Always push the branch first.",
    inputSchema: z.object({
      title: z.string().describe("PR title"),
      body: z.string().describe("PR description (markdown)"),
      base: z.string().optional().describe("Base branch. Default: the repo default branch"),
      draft: z.boolean().optional().describe("Open as draft PR. Default: false"),
    }),
    execute: async ({ title, body, base, draft = false }) => {
      if (!(await ghAvailable())) {
        return "gh CLI not available or not authenticated. Install gh (https://cli.github.com) and run `gh auth login`."
      }
      const preview = `PR "${title.slice(0, 60)}${title.length > 60 ? "…" : ""}"${base ? ` → ${base}` : ""}${draft ? " (draft)" : ""}`
      const ok = await gate.ask({ tool: "gh_pr_create", title: preview })
      if (!ok) return DENIED

      const args = ["pr", "create", "--title", title, "--body", body]
      if (base) args.push("--base", base)
      if (draft) args.push("--draft")

      const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (exitCode !== 0) return `gh pr create failed:\n${stderr.trim() || stdout.trim()}`
      return stdout.trim()
    },
  })

  return { git_status, git_diff, git_log, git_commit, git_push, gh_pr_create }
}
