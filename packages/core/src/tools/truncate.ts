/**
 * Cap tool output by keeping head and tail lines — the M1 seed of output
 * compaction. The marker tells the model exactly what was elided.
 */
export function truncateMiddle(text: string, maxChars = 30_000): string {
  if (text.length <= maxChars) return text
  const lines = text.split("\n")
  const budget = Math.floor(maxChars / 2)
  let head = ""
  let headEnd = 0
  for (; headEnd < lines.length; headEnd++) {
    const next = head + (headEnd ? "\n" : "") + lines[headEnd]
    if (next.length > budget) break
    head = next
  }
  let tail = ""
  let tailStart = lines.length
  for (; tailStart > headEnd; tailStart--) {
    const next = lines[tailStart - 1] + (tail ? "\n" : "") + tail
    if (next.length > budget) break
    tail = next
  }
  const omitted = tailStart - headEnd
  if (omitted <= 0) return text
  return `${head}\n[… ${omitted} lines omitted …]\n${tail}`
}

/** Hard cap on a single line so minified files can't blow up context. */
export function capLine(line: string, max = 2000): string {
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * Keep at most `maxLines` lines from `text`, each capped at `maxWidth` chars.
 * Appends a summary if lines were omitted. Used for permission-dialog previews.
 */
export function capLines(text: string, maxLines = 6, maxWidth = 80): string {
  const lines = text.split("\n")
  const kept = lines.slice(0, maxLines).map((l) => (l.length > maxWidth ? `${l.slice(0, maxWidth)}…` : l))
  if (lines.length > maxLines) kept.push(`[… ${lines.length - maxLines} more lines]`)
  return kept.join("\n")
}
