/** Shared types and helpers for the tool-output compaction engine. */

export interface CompactorResult {
  /** Compacted body, without the retrieval sentinel (the orchestrator appends it). */
  text: string
  /** True when content was dropped and the original should be stashed for `expand`. */
  lossy: boolean
  /** Short human label of what was dropped, e.g. "318 items" or "412 lines". */
  dropped?: string
}

/** Lines worth never eliding from logs/text — they carry the signal. */
export const ERROR_RE = /\b(error|exception|fail(?:ed|ure)?|panic|fatal|warn(?:ing)?|traceback)\b/i
