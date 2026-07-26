import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { ModelMessage } from "ai"
import type { DawnConfig } from "../src/config/config"
import type { Catalog } from "../src/provider/catalog"

// generateText is mocked: with real credentials on disk the un-mocked call reaches the
// provider, which made this suite slow, flaky (5s timeout races), and cost actual money.
const actualAi = await import("ai")
const generateTextMock = mock((() => {
  throw new Error("generateText mock not configured")
}) as (...args: any[]) => any)

mock.module("ai", () => ({ ...actualAi, generateText: generateTextMock }))

const { compactViaLlm } = await import("../src/context/compact-llm")

const fakeConfig: DawnConfig = {}
const fakeCatalog: Catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Haiku",
        tool_call: true,
        cost: { input: 1, output: 5, cache_read: 0.1 },
        limit: { context: 200_000 },
      },
    },
  },
} as unknown as Catalog

function makeMessages(turns: number): ModelMessage[] {
  const msgs: ModelMessage[] = []
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "user", content: `Question ${i + 1}` })
    msgs.push({ role: "assistant", content: `Answer ${i + 1}` })
  }
  return msgs
}

const compact = (msgs: ModelMessage[]) =>
  compactViaLlm(msgs, "anthropic/claude-haiku-4-5", fakeCatalog, fakeConfig)

beforeEach(() => {
  generateTextMock.mockReset()
})

describe("compactViaLlm", () => {
  test("returns original messages unchanged when fewer than 2 groups", async () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hi" }]
    const { messages, summary } = await compact(msgs)
    // Can't compact 1 group — original returned
    expect(messages).toEqual(msgs)
    expect(summary).toBe("")
    expect(generateTextMock).not.toHaveBeenCalled()
  })

  test("falls back to the template summary when the LLM call fails", async () => {
    generateTextMock.mockImplementation(() => {
      throw new Error("provider unreachable")
    })
    // 6 turns = 12 messages; oldest half (3 turns) summarized, newest half kept
    const msgs = makeMessages(6)
    const { messages: compacted, summary, usage } = await compact(msgs)

    expect(compacted.length).toBeLessThan(msgs.length)
    expect(summary.length).toBeGreaterThan(0)
    expect(usage).toBeUndefined() // nothing was spent, so nothing to bill
  })

  test("keeps the newest half of turns verbatim", async () => {
    generateTextMock.mockImplementation(() => {
      throw new Error("provider unreachable")
    })
    const msgs = makeMessages(4) // 4 turns; newest 2 kept
    const { messages: compacted } = await compact(msgs)

    const lastUserMsg = msgs[msgs.length - 2] as { role: string; content: string }
    const lastAsstMsg = msgs[msgs.length - 1] as { role: string; content: string }
    expect(compacted.some((m) => m.role === "user" && m.content === lastUserMsg.content)).toBe(true)
    expect(compacted.some((m) => m.role === "assistant" && m.content === lastAsstMsg.content)).toBe(true)
  })

  test("reports the utility model's usage so the caller can bill it", async () => {
    generateTextMock.mockImplementation(() => ({
      text: "the user asked things; files were edited",
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        inputTokenDetails: { cacheReadTokens: 400, cacheWriteTokens: 0 },
      },
    }))
    const { summary, usage } = await compact(makeMessages(6))

    expect(summary).toContain("files were edited")
    expect(usage?.modelId).toBe("claude-haiku-4-5")
    expect(usage?.inputTokens).toBe(1000)
    expect(usage?.outputTokens).toBe(200)
    expect(usage?.cachedInputTokens).toBe(400)
    // 600 uncached @ $1/M + 400 cached @ $0.1/M + 200 out @ $5/M
    expect(usage?.cost).toBeCloseTo((600 * 1 + 400 * 0.1 + 200 * 5) / 1_000_000, 10)
  })
})
