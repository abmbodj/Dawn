import fs from "node:fs"
import path from "node:path"
import type { ModelMessage } from "ai"
import { cacheDir } from "../paths"

export interface CheckpointMeta {
  index: number
  turnIndex: number
  timestamp: number
  label: string
  /** SHA of the shadow git commit */
  commitSha: string
  /** Snapshot of messages[] for conversation rollback */
  messagesPath: string
}

/**
 * Shadow checkpoint store — git-backed file snapshots in a separate GIT_DIR
 * that is completely isolated from the user's real repository history.
 *
 * A checkpoint is taken before each batch of agent-driven file changes, tagging
 * both the working-tree state and the conversation messages so both can be restored
 * together via /rewind.
 */
export class CheckpointStore {
  private readonly shadowGitDir: string
  private readonly workTree: string
  private readonly metaFile: string
  private checkpoints: CheckpointMeta[] = []
  private initialized = false

  constructor(workTree: string) {
    this.workTree = workTree
    const repoHash = String(Bun.hash(workTree))
    this.shadowGitDir = path.join(cacheDir(), "checkpoints", repoHash, "git")
    this.metaFile = path.join(cacheDir(), "checkpoints", repoHash, "checkpoints.json")
  }

  private git(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const proc = Bun.spawnSync(["git", ...args], {
      env: { ...process.env, GIT_DIR: this.shadowGitDir, GIT_WORK_TREE: this.workTree },
      cwd: this.workTree,
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      stdout: proc.stdout.toString().trim(),
      stderr: proc.stderr.toString().trim(),
      exitCode: proc.exitCode ?? 1,
    }
  }

  private loadMeta(): void {
    try {
      if (fs.existsSync(this.metaFile)) {
        this.checkpoints = JSON.parse(fs.readFileSync(this.metaFile, "utf8"))
      }
    } catch {
      this.checkpoints = []
    }
  }

  private saveMeta(): void {
    fs.mkdirSync(path.dirname(this.metaFile), { recursive: true })
    fs.writeFileSync(this.metaFile, JSON.stringify(this.checkpoints, null, 2))
  }

  /** Initialize the shadow git repo on first use (idempotent). */
  private ensureInit(): void {
    if (this.initialized) return
    fs.mkdirSync(this.shadowGitDir, { recursive: true })
    const isGit = fs.existsSync(path.join(this.shadowGitDir, "HEAD"))
    if (!isGit) {
      Bun.spawnSync(["git", "init", "--bare", this.shadowGitDir], { stdout: "pipe", stderr: "pipe" })
    }
    // Configure a dummy identity so commits work even with no global git config
    this.git("config", "user.email", "dawn-checkpoints@local")
    this.git("config", "user.name", "Dawn Checkpoints")
    this.loadMeta()
    this.initialized = true
  }

  /**
   * Take a checkpoint of the current working tree and messages.
   * Returns the new checkpoint meta, or undefined if git is unavailable.
   */
  snapshot(turnIndex: number, label: string, messages: ModelMessage[]): CheckpointMeta | undefined {
    try {
      this.ensureInit()
      // Stage all tracked + untracked files (excluding .git itself)
      this.git("add", "--all")
      const result = this.git(
        "commit",
        "--allow-empty",
        "-m",
        `dawn-checkpoint: turn ${turnIndex} — ${label}`,
      )
      if (result.exitCode !== 0) return undefined
      const shaResult = this.git("rev-parse", "HEAD")
      if (shaResult.exitCode !== 0) return undefined
      const commitSha = shaResult.stdout

      // Persist messages snapshot alongside the git commit
      const msgDir = path.join(path.dirname(this.metaFile), "messages")
      fs.mkdirSync(msgDir, { recursive: true })
      const messagesPath = path.join(msgDir, `${commitSha.slice(0, 12)}.json`)
      fs.writeFileSync(messagesPath, JSON.stringify(messages))

      const meta: CheckpointMeta = {
        index: this.checkpoints.length,
        turnIndex,
        timestamp: Date.now(),
        label,
        commitSha,
        messagesPath,
      }
      this.checkpoints.push(meta)
      // Keep at most 50 checkpoints to avoid unbounded disk use
      if (this.checkpoints.length > 50) this.checkpoints = this.checkpoints.slice(-50)
      this.saveMeta()
      return meta
    } catch {
      return undefined
    }
  }

  /** List recent checkpoints (newest first, capped at 10). */
  list(limit = 10): CheckpointMeta[] {
    this.ensureInit()
    return [...this.checkpoints].reverse().slice(0, limit)
  }

  /**
   * Restore the working tree and messages to the state at `meta`.
   * Returns the messages array, or undefined on failure.
   */
  restore(meta: CheckpointMeta): { messages: ModelMessage[] } | undefined {
    try {
      this.ensureInit()
      // Restore working tree to the shadow commit
      const result = this.git("checkout", meta.commitSha, "--", ".")
      if (result.exitCode !== 0) return undefined
      // Restore messages
      const messages: ModelMessage[] = JSON.parse(fs.readFileSync(meta.messagesPath, "utf8"))
      return { messages }
    } catch {
      return undefined
    }
  }
}
