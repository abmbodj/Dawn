import { capLine } from "../../tools/truncate"
import { compactText } from "./text"
import type { CompactorResult } from "./types"

/** Strip a leading ISO/bracketed timestamp and normalize digits so near-identical log lines collapse. */
const TS_PREFIX = /^\s*\[?\d{4}-\d{2}-\d{2}[T ][\d:.,Z+-]*\]?\s*/
function logKey(line: string): string {
  return line
    .replace(TS_PREFIX, "")
    .replace(/\b\d+\b/g, "#")
    .trim()
}

/**
 * Collapses runs of consecutive identical / near-identical lines into `line  (×N)`,
 * then anchor-trims the remainder if it's still long. Repetitive build and test logs
 * are where this pays off.
 */
export function compactLogs(text: string, keepLines: number): CompactorResult {
  const lines = text.split("\n")
  const collapsed: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    const key = logKey(line)
    let count = 1
    while (i + count < lines.length && key !== "" && logKey(lines[i + count] ?? "") === key) count++
    collapsed.push(count > 1 ? `${capLine(line)}  (×${count})` : capLine(line))
    i += count
  }

  const dedupedLines = lines.length - collapsed.length

  if (collapsed.length > keepLines * 2 + 1) {
    const trimmed = compactText(collapsed.join("\n"), keepLines)
    return {
      text: trimmed.text,
      lossy: true,
      dropped:
        dedupedLines > 0
          ? `${dedupedLines} duplicate + ${trimmed.dropped ?? "extra"} lines`
          : trimmed.dropped,
    }
  }
  if (dedupedLines <= 0) return { text, lossy: false }
  return { text: collapsed.join("\n"), lossy: true, dropped: `${dedupedLines} duplicate lines` }
}
