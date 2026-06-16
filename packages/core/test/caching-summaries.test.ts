import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { buildRequestMessages } from "../src/context/budget"
import type { FileSummary, WorkingSetItem } from "../src/context/types"
import { modelCaches } from "../src/provider/catalog"

function summary(path: string): FileSummary {
  const body = `summary body for ${path} ${"x".repeat(200)}`
  return {
    path,
    hash: path,
    summary: body,
    symbols: [],
    dependencies: [],
    lastSummarizedAt: Date.now(),
    tokenEstimate: Math.ceil(body.length / 4),
    sourceTokens: 4000,
  }
}

function workingFile(marker: string): WorkingSetItem {
  return {
    kind: "file-range",
    path: `${marker}.ts`,
    startLine: 1,
    endLine: 40,
    content: `${marker}\n${"code\n".repeat(20)}`,
    reason: "loaded this turn",
    ttl: 2,
    estimatedTokens: 80,
    createdAt: 1,
  }
}

const SUMMARY_HEADER = "Repository summaries (stable for this session)"
const WORKING_HEADER = "Use this compact repository context for the current turn"
const textOf = (m: ModelMessage) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))
const findText = (msgs: ModelMessage[], needle: string) => msgs.findIndex((m) => textOf(m).includes(needle))

describe("modelCaches", () => {
  test("true when the model has a cache_read price, false otherwise", () => {
    expect(modelCaches({ id: "m", name: "m", cost: { input: 3, output: 15, cache_read: 0.3 } })).toBe(true)
    expect(modelCaches({ id: "m", name: "m", cost: { input: 3, output: 15 } })).toBe(false)
    expect(modelCaches({ id: "m", name: "m" })).toBe(false)
    expect(modelCaches(undefined)).toBe(false)
  })
})

describe("summary block is cacheable", () => {
  const summaries = [summary("src/a.ts"), summary("src/b.ts"), summary("src/c.ts")]
  const budget = { mode: "balanced" as const, budget: 9000 }

  test("rendered summary block is byte-identical regardless of volatile working set / query", () => {
    const turn1 = buildRequestMessages({
      system: "You are Dawn.",
      messages: [{ role: "user", content: "first question" }],
      summaries,
      workingSet: [workingFile("ALPHA")],
      budget,
      caches: true,
    })
    const turn2 = buildRequestMessages({
      system: "You are Dawn.",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "a totally different second question" },
      ],
      summaries,
      workingSet: [workingFile("BRAVO"), workingFile("CHARLIE")],
      budget,
      caches: true,
    })
    const s1 = turn1.messages.map(textOf).find((c) => c.includes(SUMMARY_HEADER))
    const s2 = turn2.messages.map(textOf).find((c) => c.includes(SUMMARY_HEADER))
    expect(s1).toBeDefined()
    expect(s1).toBe(s2)
  })

  test("summaries sit before history and the volatile working-set block", () => {
    const built = buildRequestMessages({
      system: "You are Dawn.",
      messages: [
        { role: "user", content: "old turn" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "current question" },
      ],
      summaries,
      workingSet: [workingFile("ALPHA")],
      budget,
      caches: true,
    })
    const summaryIdx = findText(built.messages, SUMMARY_HEADER)
    const workingIdx = findText(built.messages, WORKING_HEADER)
    expect(summaryIdx).toBe(0) // first message, in the cacheable prefix
    expect(workingIdx).toBeGreaterThan(summaryIdx)
  })

  test("Anthropic marks a cache breakpoint on the summary block; other providers don't", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "q" }]
    const anthropic = buildRequestMessages({
      system: "You are Dawn.",
      messages,
      summaries,
      workingSet: [],
      budget,
      isAnthropic: true,
      caches: true,
    })
    const other = buildRequestMessages({
      system: "You are Dawn.",
      messages,
      summaries,
      workingSet: [],
      budget,
      caches: true,
    })
    const aSummary = anthropic.messages[findText(anthropic.messages, SUMMARY_HEADER)]
    const oSummary = other.messages[findText(other.messages, SUMMARY_HEADER)]
    expect((aSummary as { providerOptions?: unknown }).providerOptions).toBeDefined()
    expect((oSummary as { providerOptions?: unknown }).providerOptions).toBeUndefined()
  })
})
