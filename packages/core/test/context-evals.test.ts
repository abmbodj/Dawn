import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { buildRequestMessages } from "../src/context/budget"
import type { FileSummary, WorkingSetItem } from "../src/context/types"

interface ContextEvalFixture {
  name: string
  query: string
  workingSet: WorkingSetItem[]
  mustKeep: string
}

const fixtures: ContextEvalFixture[] = [
  fixture("repo overview", "summarize this repository", "README excerpt"),
  fixture("bug fix", "fix the login validation bug", "auth.ts lines 20-60"),
  fixture("targeted edit", "rename the settings flag", "config.ts lines 5-40"),
  fixture("test failure", "diagnose the failing ledger test", "ledger.test.ts lines 1-80"),
  fixture("multi-file change", "wire savings into the TUI", "status.ts lines 120-180"),
]

describe("context planning eval fixtures", () => {
  for (const item of fixtures) {
    test(`${item.name} keeps useful context while saving tokens`, () => {
      const messages: ModelMessage[] = [
        { role: "user", content: `old request ${"x".repeat(4000)}` },
        { role: "assistant", content: `old answer ${"y".repeat(4000)}` },
        { role: "user", content: item.query },
      ]

      const built = buildRequestMessages({
        system: "You are Dawn.",
        messages,
        summaries: [],
        workingSet: item.workingSet,
        budget: { mode: "balanced", budget: 260 },
      })
      const wouldSendTokens = built.plan.totalEstimatedTokens + built.plan.savingsEstimate

      expect(JSON.stringify(built.messages)).toContain(item.query)
      expect(JSON.stringify(built.messages)).toContain(item.mustKeep)
      expect(built.plan.totalEstimatedTokens).toBeLessThan(wouldSendTokens)
      expect(built.plan.savingsEstimate).toBeGreaterThan(0)
      expect(built.plan.includedItems.length).toBeGreaterThan(0)
      expect(built.plan.skippedItems.length).toBeGreaterThan(0)
    })
  }
})

describe("substitution savings", () => {
  test("summary standing in for a large file produces positive substitutionSavings", () => {
    const largeFileContent = "x".repeat(8000) // ~2000 tokens
    const summaryText = "TypeScript file, 8000 bytes. Defines foo, bar. Imports baz." // ~20 tokens

    const summary: FileSummary = {
      path: "src/large.ts",
      hash: "abc123",
      summary: summaryText,
      symbols: ["foo", "bar"],
      dependencies: ["baz"],
      lastSummarizedAt: Date.now(),
      tokenEstimate: Math.ceil(summaryText.length / 4),
      sourceTokens: Math.ceil(largeFileContent.length / 4),
    }

    const messages: ModelMessage[] = [{ role: "user", content: "update the large file" }]

    const built = buildRequestMessages({
      system: "You are Dawn.",
      messages,
      summaries: [summary],
      workingSet: [],
      budget: { mode: "balanced", budget: 8000 },
    })

    expect(built.plan.substitutionSavings).toBeGreaterThan(0)
    expect(built.plan.substitutionSavings).toBe(summary.sourceTokens - summary.tokenEstimate)
    // would-send = sent + savings; summary makes sent much smaller than naive full-file send
    const wouldSendTokens = built.plan.totalEstimatedTokens + built.plan.savingsEstimate + built.plan.substitutionSavings
    expect(wouldSendTokens).toBeGreaterThan(built.plan.totalEstimatedTokens)
  })

  test("substitutionSavings is zero when no summaries are included", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
    const built = buildRequestMessages({
      system: "You are Dawn.",
      messages,
      summaries: [],
      workingSet: [],
      budget: { mode: "balanced", budget: 8000 },
    })
    expect(built.plan.substitutionSavings).toBe(0)
  })

  test("summary with sourceTokens <= tokenEstimate contributes zero substitutionSavings", () => {
    const tinyFile = "x".repeat(40)
    const summary: FileSummary = {
      path: "src/tiny.ts",
      hash: "xyz",
      summary: tinyFile,
      symbols: [],
      dependencies: [],
      lastSummarizedAt: Date.now(),
      tokenEstimate: Math.ceil(tinyFile.length / 4),
      sourceTokens: Math.ceil(tinyFile.length / 4), // same — no substitution benefit
    }
    const messages: ModelMessage[] = [{ role: "user", content: "check tiny" }]
    const built = buildRequestMessages({
      system: "You are Dawn.",
      messages,
      summaries: [summary],
      workingSet: [],
      budget: { mode: "balanced", budget: 8000 },
    })
    expect(built.plan.substitutionSavings).toBe(0)
  })
})

function fixture(name: string, query: string, mustKeep: string): ContextEvalFixture {
  return {
    name,
    query,
    mustKeep,
    workingSet: [
      {
        kind: "file-range",
        path: mustKeep.split(" lines ")[0],
        startLine: 1,
        endLine: 40,
        content: `${mustKeep}\n${"relevant code\n".repeat(30)}`,
        reason: "task-relevant context",
        ttl: 2,
        estimatedTokens: 80,
        createdAt: 2,
      },
      {
        kind: "file-range",
        path: "stale.ts",
        startLine: 1,
        endLine: 400,
        content: "stale context\n".repeat(1000),
        reason: "old context",
        ttl: 0,
        estimatedTokens: 1000,
        createdAt: 1,
      },
    ],
  }
}
