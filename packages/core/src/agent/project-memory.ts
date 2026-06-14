import fs from "node:fs"
import path from "node:path"
import { estimateTokens } from "../context/budget"
import { configDir } from "../paths"
import { truncateMiddle } from "../tools/truncate"

const MEMORY_FILES = ["AGENTS.md", "DAWN.md"]
const MAX_MEMORY_CHARS = 8000 // ~2000 tokens; hard cap to stay frugal

function gitRoot(cwd: string): string | undefined {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd })
    const out = result.stdout.toString().trim()
    return out || undefined
  } catch {
    return undefined
  }
}

/** Walk directories from least-specific to most-specific and collect memory files. */
function collectMemoryPaths(cwd: string): string[] {
  const paths: string[] = []

  // Global: ~/.config/dawn/AGENTS.md
  const global = path.join(configDir(), "AGENTS.md")
  if (fs.existsSync(global)) paths.push(global)

  // Repo: walk from git root → cwd, picking up AGENTS.md and DAWN.md at each level.
  const root = gitRoot(cwd)
  const start = root ?? cwd

  // Build the list of directories from start → cwd (inclusive, no duplicates).
  const dirs: string[] = []
  let cur = path.resolve(cwd)
  const startAbs = path.resolve(start)
  while (true) {
    dirs.unshift(cur)
    if (cur === startAbs || cur === path.dirname(cur)) break
    cur = path.dirname(cur)
  }

  for (const dir of dirs) {
    for (const name of MEMORY_FILES) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate) && !paths.includes(candidate)) {
        paths.push(candidate)
      }
    }
  }

  return paths
}

export interface ProjectMemory {
  text: string
  sources: string[]
}

export function loadProjectMemory(cwd: string): ProjectMemory {
  const filePaths = collectMemoryPaths(cwd)
  const sources: string[] = []
  const parts: string[] = []
  let totalChars = 0

  for (const filePath of filePaths) {
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim()
      if (!raw) continue
      const label = path.relative(cwd, filePath)
      const header = `<!-- ${label} -->`
      const block = `${header}\n${raw}`
      const blockChars = block.length + 2 // +2 for surrounding newlines

      if (totalChars + blockChars > MAX_MEMORY_CHARS) {
        // Truncate this block to fit within budget
        const remaining = MAX_MEMORY_CHARS - totalChars - header.length - 4
        if (remaining < 50) break
        const truncated = `${header}\n${truncateMiddle(raw, remaining)}`
        parts.push(truncated)
        sources.push(label)
        break
      }

      parts.push(block)
      sources.push(label)
      totalChars += blockChars
    } catch {
      // skip unreadable files
    }
  }

  return {
    text: parts.join("\n\n"),
    sources,
  }
}

export function estimateMemoryTokens(memory: ProjectMemory): number {
  return estimateTokens(memory.text)
}
