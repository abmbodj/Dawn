import { createHash } from "node:crypto"
import { estimateTokens } from "../budget"
import type { ContextStore } from "../store"
import type { CompactBudget } from "../types"
import { type CompactKind, detectKind } from "./detect"
import { compactJson } from "./json"
import { compactLogs } from "./logs"
import { compactSearch } from "./search"
import { compactText } from "./text"
import type { CompactorResult } from "./types"

export interface CompactToolContext {
  tool: string
  budget: CompactBudget
  /** When present, the original is stashed so the `expand` tool can retrieve it. */
  store?: ContextStore
  sessionId?: string
}

export interface CompactOutcome {
  text: string
  kind: CompactKind
  beforeTokens: number
  afterTokens: number
  /** True when the output was actually shrunk (and an original stashed, if a store was given). */
  compacted: boolean
}

/**
 * Detect the content type of a tool output, route it to the right compactor, guard
 * against inflation, and — if lossy — stash the original and append an «expand:HASH»
 * sentinel. The returned text is a deterministic function of `raw` (no timestamps),
 * so already-sent tool outputs stay byte-stable and the prompt-cache prefix holds.
 */
export function compactToolOutput(raw: string, ctx: CompactToolContext): CompactOutcome {
  const beforeTokens = estimateTokens(raw)
  if (beforeTokens < ctx.budget.threshold) {
    return { text: raw, kind: "text", beforeTokens, afterTokens: beforeTokens, compacted: false }
  }

  const kind = detectKind(raw, ctx.tool)
  const result = route(kind, raw, ctx.budget)
  if (!result.lossy) return { text: raw, kind, beforeTokens, afterTokens: beforeTokens, compacted: false }

  // Inflation guard (headroom's safety valve): never hand back something larger.
  const bodyTokens = estimateTokens(result.text)
  if (bodyTokens >= beforeTokens) {
    return { text: raw, kind, beforeTokens, afterTokens: beforeTokens, compacted: false }
  }

  const hash = hashContent(raw)
  ctx.store?.putBlob({
    hash,
    sessionId: ctx.sessionId,
    tool: ctx.tool,
    content: raw,
    sourceTokens: beforeTokens,
    createdAt: Date.now(),
  })
  const sentinel = buildSentinel(hash, result.dropped, beforeTokens - bodyTokens, Boolean(ctx.store))
  const text = `${result.text}\n${sentinel}`
  return { text, kind, beforeTokens, afterTokens: estimateTokens(text), compacted: true }
}

function route(kind: CompactKind, raw: string, b: CompactBudget): CompactorResult {
  switch (kind) {
    case "json":
      return compactJson(raw, b.keepItems)
    case "search":
      return compactSearch(raw, b.keepItems)
    case "log":
      return compactLogs(raw, b.keepLines)
    default:
      return compactText(raw, b.keepLines)
  }
}

/** Short, content-derived id — stable across runs for the same output. */
export function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 10)
}

function buildSentinel(
  hash: string,
  dropped: string | undefined,
  elidedTokens: number,
  hasStore: boolean,
): string {
  const tok = elidedTokens >= 1000 ? `${(elidedTokens / 1000).toFixed(1)}k` : String(elidedTokens)
  const what = dropped ? `${dropped} / ~${tok} tokens` : `~${tok} tokens`
  return hasStore
    ? `«expand:${hash} — ${what} elided; call expand("${hash}") for the full output»`
    : `«${what} elided»`
}

export type { CompactKind } from "./detect"
export { detectKind } from "./detect"
export { compactJson } from "./json"
export { compactLogs } from "./logs"
export { compactSearch } from "./search"
export { compactText } from "./text"
