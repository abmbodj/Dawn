import { describe, expect, test } from "bun:test"
import { looksLikeInvestigation, summariesEarnKeep } from "../src/context/budget"
import type { WorkingSetItem } from "../src/context/types"

const fileItem: WorkingSetItem = {
  kind: "file",
  path: "src/a.ts",
  content: " const x = 1",
  reason: "read",
  ttl: 2,
  estimatedTokens: 10,
  createdAt: 1,
}

describe("looksLikeInvestigation", () => {
  test("detects paths and navigational language", () => {
    expect(looksLikeInvestigation("Where is request retry handled?")).toBe(true)
    expect(looksLikeInvestigation("Read packages/core/src/agent/agent.ts")).toBe(true)
    expect(looksLikeInvestigation("hi")).toBe(false)
    expect(looksLikeInvestigation("thanks")).toBe(false)
  })
})

describe("summariesEarnKeep", () => {
  test("skips trivial first turns with an empty working set", () => {
    expect(
      summariesEarnKeep({
        messages: [{ role: "user", content: "hi" }],
        workingSet: [],
      }),
    ).toBe(false)
  })

  test("keeps summaries when the working set already has substance", () => {
    expect(
      summariesEarnKeep({
        messages: [{ role: "user", content: "hi" }],
        workingSet: [fileItem],
      }),
    ).toBe(true)
  })

  test("keeps summaries after the first user turn", () => {
    expect(
      summariesEarnKeep({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "ok" },
        ],
        workingSet: [],
      }),
    ).toBe(true)
  })

  test("keeps summaries for investigative first turns", () => {
    expect(
      summariesEarnKeep({
        messages: [{ role: "user", content: "Where is budgetFor defined?" }],
        workingSet: [],
      }),
    ).toBe(true)
  })

  test("naive mode never injects", () => {
    expect(
      summariesEarnKeep({
        messages: [{ role: "user", content: "Where is budgetFor defined?" }],
        workingSet: [fileItem],
        naive: true,
      }),
    ).toBe(false)
  })
})
