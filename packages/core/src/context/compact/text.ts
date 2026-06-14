import { capLine } from "../../tools/truncate"
import { type CompactorResult, ERROR_RE } from "./types"

/**
 * Anchor-aware head+tail. Keeps the first and last `keepLines` lines and force-keeps
 * error/warning lines from the elided middle so the signal survives compaction.
 * Complements `truncateMiddle` (the upstream char-level hard cap) with line + error awareness.
 */
export function compactText(text: string, keepLines: number): CompactorResult {
  const lines = text.split("\n")
  if (lines.length <= keepLines * 2 + 1) return { text, lossy: false }

  const head = lines.slice(0, keepLines).map((l) => capLine(l))
  const tail = lines.slice(lines.length - keepLines).map((l) => capLine(l))
  const middle = lines.slice(keepLines, lines.length - keepLines)
  const errors = middle
    .filter((l) => ERROR_RE.test(l))
    .slice(0, 20)
    .map((l) => capLine(l))
  const omitted = middle.length - errors.length
  if (omitted <= 0) return { text, lossy: false }

  const body = [
    ...head,
    ...errors,
    `[… ${omitted} middle line${omitted === 1 ? "" : "s"} omitted …]`,
    ...tail,
  ]
  return { text: body.join("\n"), lossy: true, dropped: `${omitted} lines` }
}
