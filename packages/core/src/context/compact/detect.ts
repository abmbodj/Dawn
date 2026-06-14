/** Heuristic content-type detection — the pure-TS analogue of headroom's ContentRouter. */

export type CompactKind = "json" | "search" | "log" | "text"

/** ripgrep/grep `-n` lines look like `path/to/file.ts:42:matched text`. */
const MATCH_LINE = /^.+?:\d+:/
/** ISO timestamps, log levels, or stack-frame lines. */
const LOG_LINE = /^\[?\d{4}-\d{2}-\d{2}[T ]|^\s*(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL)\b|^\s+at\s+\S/i

export function detectKind(text: string, hint?: string): CompactKind {
  // The calling tool disambiguates where it can.
  if (hint === "grep") return "search"
  if (hint === "ls" || hint === "glob") return "text"

  const trimmed = text.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(text.trim())
      return "json"
    } catch {
      // Not valid JSON — fall through to line sniffing.
    }
  }

  const lines = text
    .split("\n")
    .filter((l) => l.length > 0)
    .slice(0, 200)
  if (lines.length >= 5) {
    // Logs first: timestamps contain `HH:MM:SS`, which would otherwise read as a `path:line:` match.
    const logish = lines.filter((l) => LOG_LINE.test(l)).length
    if (logish >= lines.length * 0.5) return "log"
    const matchish = lines.filter((l) => MATCH_LINE.test(l)).length
    if (matchish >= Math.max(5, lines.length * 0.5)) return "search"
  }
  return "text"
}
