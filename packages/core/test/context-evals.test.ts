import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { buildRequestMessages } from "../src/context/budget"
import type { WorkingSetItem } from "../src/context/types"

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
      const fullContextBaseline = built.plan.totalEstimatedTokens + built.plan.savingsEstimate

      expect(JSON.stringify(built.messages)).toContain(item.query)
      expect(JSON.stringify(built.messages)).toContain(item.mustKeep)
      expect(built.plan.totalEstimatedTokens).toBeLessThan(fullContextBaseline)
      expect(built.plan.savingsEstimate).toBeGreaterThan(0)
      expect(built.plan.includedItems.length).toBeGreaterThan(0)
      expect(built.plan.skippedItems.length).toBeGreaterThan(0)
    })
  }
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
