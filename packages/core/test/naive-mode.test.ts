import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { buildRequestMessages, compactBudget } from "../src/context/budget"
import { compactToolOutput } from "../src/context/compact"
import type { FileSummary, WorkingSetItem } from "../src/context/types"

// A working-set file the naive baseline must send in full, plus a large old history
// that the balanced planner would trim under a tight budget.
function workingSetFile(): WorkingSetItem {
  return {
    kind: "file-range",
    path: "src/app.ts",
    startLine: 1,
    endLine: 40,
    content: `FILE_MARKER\n${"relevant code\n".repeat(30)}`,
    reason: "task-relevant context",
    ttl: 2,
    estimatedTokens: 80,
    createdAt: 2,
  }
}

function bigSummary(): FileSummary {
  const summary = "SUMMARY_MARKER — condensed stand-in for a large file"
  return {
    path: "src/other.ts",
    hash: "abc",
    summary,
    symbols: ["foo", "bar"],
    dependencies: [],
    lastSummarizedAt: Date.now(),
    tokenEstimate: Math.ceil(summary.length / 4),
    sourceTokens: 2000,
  }
}

const tightBudget = { mode: "balanced" as const, budget: 260 }

function messagesWithBigHistory(): ModelMessage[] {
  return [
    { role: "user", content: `OLD_USER ${"x".repeat(4000)}` },
    { role: "assistant", content: `OLD_ASSISTANT ${"y".repeat(4000)}` },
    { role: "user", content: "the current request" },
  ]
}

describe("naive mode disables context planning", () => {
  test("sends full working set and history, with zero modeled savings", () => {
    const built = buildRequestMessages({
      system: "You are Dawn.",
      messages: messagesWithBigHistory(),
      summaries: [bigSummary()],
      workingSet: [workingSetFile()],
      budget: tightBudget,
      naive: true,
    })
    const serialized = JSON.stringify(built.messages)

    // Full file content is present; the summary stand-in is never emitted.
    expect(serialized).toContain("FILE_MARKER")
    expect(serialized).not.toContain("SUMMARY_MARKER")
    expect(serialized).not.toContain("Repository summaries:")

    // History is kept in full despite the tiny budget.
    expect(serialized).toContain("OLD_USER")
    expect(serialized).toContain("OLD_ASSISTANT")
    expect(serialized).toContain("the current request")

    // Nothing was trimmed or substituted, so every "saved" figure is zero.
    expect(built.plan.savingsEstimate).toBe(0)
    expect(built.plan.substitutionSavings).toBe(0)
    expect(built.plan.trimmedItems).toEqual([])
    expect(built.plan.skippedItems).toEqual([])
  })

  test("does not attach Anthropic cache control", () => {
    const built = buildRequestMessages({
      system: "You are Dawn.",
      messages: messagesWithBigHistory(),
      summaries: [],
      workingSet: [workingSetFile()],
      budget: tightBudget,
      isAnthropic: true,
      naive: true,
    })
    expect(built.system.providerOptions).toBeUndefined()
    for (const message of built.messages) {
      expect((message as { providerOptions?: unknown }).providerOptions).toBeUndefined()
    }
  })
})

describe("balanced mode (regression) still optimizes", () => {
  test("trims history and substitutes summaries under the same tight budget", () => {
    const built = buildRequestMessages({
      system: "You are Dawn.",
      messages: messagesWithBigHistory(),
      summaries: [bigSummary()],
      workingSet: [workingSetFile()],
      budget: tightBudget,
    })
    expect(built.plan.savingsEstimate).toBeGreaterThan(0)
    expect(built.plan.skippedItems.length).toBeGreaterThan(0)
  })

  test("anthropic cache control is applied when not naive", () => {
    const built = buildRequestMessages({
      system: "You are Dawn.",
      messages: messagesWithBigHistory(),
      summaries: [],
      workingSet: [workingSetFile()],
      budget: { mode: "balanced", budget: 8000 },
      isAnthropic: true,
    })
    expect(built.system.providerOptions).toBeDefined()
  })
})

describe("naive mode disables tool-output compaction", () => {
  const budget = compactBudget("balanced")
  // ~1500 tokens of plain text — well over the 800-token threshold and far more
  // lines than keepLines, so the balanced compactor would shrink it.
  const heavyOutput = `${"a line of tool output\n".repeat(300)}`

  test("naive returns the raw output unchanged", () => {
    const outcome = compactToolOutput(heavyOutput, { tool: "bash", budget, naive: true })
    expect(outcome.compacted).toBe(false)
    expect(outcome.text).toBe(heavyOutput)
  })

  test("balanced compacts the same output", () => {
    const outcome = compactToolOutput(heavyOutput, { tool: "bash", budget })
    expect(outcome.compacted).toBe(true)
    expect(outcome.afterTokens).toBeLessThan(outcome.beforeTokens)
  })
})
