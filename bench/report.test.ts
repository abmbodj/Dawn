import { describe, expect, test } from "bun:test"
import { costPerSuccess, headline, type RunMetrics, type TaskResult } from "./report"

function rep(cost: number, success: boolean): RunMetrics {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cost,
    steps: 1,
    ms: 1,
    success,
    errored: false,
  }
}

function task(name: string, modes: TaskResult["modes"]): TaskResult {
  return { task: name, category: "test", slice: "edit", modes }
}

describe("costPerSuccess", () => {
  test("charges failed reps instead of excluding them", () => {
    const results = [
      task("a", { dawn: [rep(0.1, true), rep(0.2, false)] }),
      task("b", { dawn: [rep(0.3, true)] }),
    ]
    const t = costPerSuccess(results, "dawn")
    expect(t.cost).toBeCloseTo(0.6)
    expect(t.ok).toBe(2)
    expect(t.total).toBe(3)
    expect(t.perSuccess).toBeCloseTo(0.3) // 0.6 / 2 — the 0.2 failure is paid for
  })

  test("no passes yields Infinity, not a division crash", () => {
    const t = costPerSuccess([task("a", { dawn: [rep(0.5, false)] })], "dawn")
    expect(t.perSuccess).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("headline gate", () => {
  test("fails on pass-rate parity even when dawn is cheaper", () => {
    const results = [
      task("a", { dawn: [rep(0.1, true), rep(0.1, false)], naive: [rep(0.4, true), rep(0.4, true)] }),
    ]
    expect(headline(results)).toContain("**Headline gate: fail**")
    expect(headline(results)).toContain("parity")
  })

  test("passes when dawn holds parity and is cheaper per success", () => {
    const results = [
      task("a", { dawn: [rep(0.1, true)], naive: [rep(0.4, true)] }),
      task("b", { dawn: [rep(0.2, true)], naive: [rep(0.3, true)] }),
    ]
    expect(headline(results)).toContain("**Headline gate: pass**")
  })

  test("claude column compares dawn on the same task subset", () => {
    const results = [
      task("a", { dawn: [rep(0.1, true)], naive: [rep(0.2, true)], claude: [rep(0.5, true)] }),
      task("b", { dawn: [rep(9.9, true)], naive: [rep(0.2, true)] }), // no claude rep — excluded from subset
    ]
    const out = headline(results)
    expect(out).toContain("Claude Code (1-task subset)")
    expect(out).toContain("| Dawn (same subset) | 1/1 | $0.1000 | $0.1000 |")
  })
})
