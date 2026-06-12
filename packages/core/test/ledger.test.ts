import { describe, expect, test } from "bun:test"
import type { ModelInfo } from "../src/provider/catalog"
import { computeCost, UsageLedger } from "../src/usage/ledger"

// Claude Opus 4.8 pricing fixture (USD per 1M tokens)
const opus: ModelInfo = {
  id: "claude-opus-4-8",
  name: "Claude Opus 4.8",
  cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
}

describe("computeCost", () => {
  test("plain input/output with no caching", () => {
    const cost = computeCost(opus, {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(cost).toBeCloseTo(5 + 2.5, 10)
  })

  test("cache reads bill at the cache_read rate", () => {
    const cost = computeCost(opus, {
      inputTokens: 1_000_000, // includes the cached portion
      outputTokens: 0,
      cachedInputTokens: 800_000,
      cacheWriteTokens: 0,
    })
    // 200k uncached @ $5 + 800k cached @ $0.5 = 1.0 + 0.4
    expect(cost).toBeCloseTo(1.4, 10)
  })

  test("cache writes bill at the cache_write rate", () => {
    const cost = computeCost(opus, {
      inputTokens: 400_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 400_000,
    })
    expect(cost).toBeCloseTo(2.5, 10)
  })

  test("unknown pricing yields zero, never NaN", () => {
    const cost = computeCost(undefined, {
      inputTokens: 1000,
      outputTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(cost).toBe(0)
  })
})

describe("UsageLedger", () => {
  test("aggregates per model and overall", () => {
    const ledger = new UsageLedger()
    ledger.record({
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 500,
      cacheWriteTokens: 100,
      cost: 0.01,
    })
    ledger.record({
      providerId: "openai",
      modelId: "gpt-5.5",
      inputTokens: 2000,
      outputTokens: 300,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.02,
    })
    const totals = ledger.totals()
    expect(totals.inputTokens).toBe(3000)
    expect(totals.outputTokens).toBe(500)
    expect(totals.cost).toBeCloseTo(0.03, 10)
    expect(totals.steps).toBe(2)
    expect(ledger.perModel().size).toBe(2)
    expect(ledger.perModel().get("anthropic/claude-opus-4-8")?.cachedInputTokens).toBe(500)
  })

  test("reset clears per-model and overall totals", () => {
    const ledger = new UsageLedger()
    ledger.record({
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 500,
      cacheWriteTokens: 100,
      cost: 0.01,
    })

    ledger.reset()

    expect(ledger.totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      steps: 0,
    })
    expect(ledger.perModel().size).toBe(0)
  })
})
