import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { buildRequestMessages } from "../src/context/budget"
import type { FileSummary } from "../src/context/types"

// A summary roughly `approxTokens` long (summaryText ≈ chars/4).
function paddedSummary(path: string, approxTokens: number): FileSummary {
  const body = "x".repeat(approxTokens * 4)
  return {
    path,
    hash: path,
    summary: body,
    symbols: [],
    dependencies: [],
    lastSummarizedAt: Date.now(),
    tokenEstimate: approxTokens,
    sourceTokens: approxTokens * 4,
  }
}

describe("caching-aware summary injection", () => {
  const summaries = Array.from({ length: 12 }, (_, i) => paddedSummary(`src/f${i}.ts`, 250))
  const messages: ModelMessage[] = [{ role: "user", content: "explain how the codebase fits together" }]
  const budget = { mode: "balanced" as const, budget: 9000 }

  test("a non-caching provider keeps fewer summary tokens than a caching one", () => {
    const cached = buildRequestMessages({
      system: "You are Dawn.",
      messages,
      summaries,
      workingSet: [],
      budget,
      caches: true,
    })
    const uncached = buildRequestMessages({
      system: "You are Dawn.",
      messages,
      summaries,
      workingSet: [],
      budget,
      caches: false,
    })
    // Caching amortizes the per-turn re-send, so a caching provider spends more on summaries.
    expect(cached.plan.summaryTokens).toBeGreaterThan(uncached.plan.summaryTokens)
    // But the leaner provider still injects *some* summary context (not zero — that's naive mode).
    expect(uncached.plan.summaryTokens).toBeGreaterThan(0)
  })
})
