import { compactText } from "./text"
import type { CompactorResult } from "./types"

/** `path/to/file.ts:42:match` from ripgrep/grep `-n`. */
const MATCH_RE = /^(.*?):\d+:/

/**
 * Ranking-aware grep compaction: groups matches by file (preserving first-seen order),
 * caps matches per file and the number of files, and leaves counts so the model knows
 * how much was elided. Falls back to text compaction when the output isn't grep-shaped.
 */
export function compactSearch(text: string, keepItems: number): CompactorResult {
  const lines = text.split("\n").filter((l) => l.length > 0)
  let parsed = 0
  const byFile = new Map<string, string[]>()
  for (const line of lines) {
    const m = MATCH_RE.exec(line)
    if (!m) continue
    parsed++
    const file = m[1] ?? ""
    const arr = byFile.get(file) ?? []
    arr.push(line)
    byFile.set(file, arr)
  }
  if (parsed < lines.length * 0.5) return compactText(text, Math.max(20, keepItems))

  const files = [...byFile.keys()]
  const maxFiles = keepItems
  const perFile = Math.max(2, Math.floor(keepItems / Math.max(1, Math.min(files.length, maxFiles))))
  const shown = files.slice(0, maxFiles)
  const hidden = files.slice(maxFiles)

  const out: string[] = []
  let dropped = 0
  for (const file of shown) {
    const matches = byFile.get(file) ?? []
    out.push(...matches.slice(0, perFile))
    if (matches.length > perFile) {
      const extra = matches.length - perFile
      out.push(`  [… +${extra} more match${extra === 1 ? "" : "es"} in ${file}]`)
      dropped += extra
    }
  }
  if (hidden.length) {
    let hiddenMatches = 0
    for (const f of hidden) hiddenMatches += byFile.get(f)?.length ?? 0
    out.push(
      `[… ${hiddenMatches} match${hiddenMatches === 1 ? "" : "es"} in ${hidden.length} more file${hidden.length === 1 ? "" : "s"} omitted …]`,
    )
    dropped += hiddenMatches
  }

  if (dropped <= 0) return { text, lossy: false }
  return { text: out.join("\n"), lossy: true, dropped: `${dropped} matches` }
}
