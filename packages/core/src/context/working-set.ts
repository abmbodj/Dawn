import { estimateTokens } from "./budget"
import type { WorkingSetItem } from "./types"

/**
 * How many tool-result echoes to keep, newest first.
 *
 * TTL alone bounds them by *turns*, not by count — and a single investigate turn can
 * fire a dozen tools, so a per-call lease with no cap retains every one of them. Measured
 * on the bench: uncapped, `probe-multifile-rename` (grep + several reads + several edits)
 * cost +112% input, while recall-heavy tasks gained. Three keeps "the last few outputs"
 * — the behaviour the TTLs were written for — without paying for a whole turn's worth.
 */
const MAX_TOOL_RESULT_ITEMS = 3

export class ContextWorkingSet {
  private items: WorkingSetItem[] = []

  add(item: Omit<WorkingSetItem, "createdAt" | "estimatedTokens"> & { estimatedTokens?: number }): void {
    const estimatedTokens = item.estimatedTokens ?? estimateTokens(item.content ?? item.summary ?? "")
    const next: WorkingSetItem = { ...item, estimatedTokens, createdAt: Date.now() }
    const key = keyFor(next)
    this.items = this.items.filter((existing) => keyFor(existing) !== key)
    this.items.push(next)

    if (next.kind === "tool-result") {
      let seen = 0
      this.items = this.items
        .slice()
        .reverse()
        .filter((existing) => existing.kind !== "tool-result" || ++seen <= MAX_TOOL_RESULT_ITEMS)
        .reverse()
    }
  }

  all(): WorkingSetItem[] {
    return [...this.items]
  }

  hasFileRange(path: string, startLine: number, endLine: number): boolean {
    const key = ["file-range", path, String(startLine), String(endLine)].join(":")
    return this.items.some((item) => keyFor(item) === key)
  }

  tokens(): number {
    return this.items.reduce((sum, item) => sum + item.estimatedTokens, 0)
  }

  decrementLeases(): void {
    this.items = this.items
      .map((item) => ({ ...item, ttl: item.ttl - 1 }))
      .filter((item) => item.ttl > 0 || item.kind === "summary")
  }

  clear(): void {
    this.items = []
  }
}

function keyFor(item: WorkingSetItem): string {
  // Tool results have no path, so without the call id they would all collapse onto the
  // key "tool-result:::" and each new one would evict the last — leaving the working set
  // holding a single output instead of the leased window its TTLs describe.
  // File-ranges deliberately key on path+lines so re-reading the same range replaces it.
  const identity = item.kind === "tool-result" ? (item.toolCallId ?? "") : ""
  return [item.kind, item.path ?? "", item.startLine ?? "", item.endLine ?? "", identity].join(":")
}
