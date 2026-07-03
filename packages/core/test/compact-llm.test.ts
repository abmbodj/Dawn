import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import type { DawnConfig } from "../src/config/config"
import { compactViaLlm } from "../src/context/compact-llm"
import type { Catalog } from "../src/provider/catalog"

// Minimal catalog that satisfies resolveRoleModel / resolveModel for a local/fake provider.
// compactViaLlm will try to call generateText and fail; we test that it falls back gracefully.
const fakeCatalog: Catalog = {}
const fakeConfig: DawnConfig = {}

function makeMessages(turns: number): ModelMessage[] {
  const msgs: ModelMessage[] = []
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "user", content: `Question ${i + 1}` })
    msgs.push({ role: "assistant", content: `Answer ${i + 1}` })
  }
  return msgs
}

describe("compactViaLlm", () => {
  test("returns original messages unchanged when fewer than 2 groups", async () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hi" }]
    const { messages, summary } = await compactViaLlm(
      msgs,
      "anthropic/claude-haiku-4-5",
      fakeCatalog,
      fakeConfig,
    )
    // Can't compact 1 group — original returned
    expect(messages).toEqual(msgs)
    expect(summary).toBe("")
  })

  test("returns fewer messages after compaction (or fallback template)", async () => {
    // 6 turns = 12 messages; oldest half (3 turns = 6 msgs) get summarized, 3 remain
    const msgs = makeMessages(6)
    // The LLM call will fail (no real provider), triggering template fallback
    const { messages: compacted, summary } = await compactViaLlm(
      msgs,
      "anthropic/claude-haiku-4-5",
      fakeCatalog,
      fakeConfig,
    )
    // Should keep only the newest half
    expect(compacted.length).toBeLessThan(msgs.length)
    // Summary should be non-empty (from template fallback)
    expect(summary.length).toBeGreaterThan(0)
  })

  test("keeps the newest half of turns verbatim", async () => {
    const msgs = makeMessages(4) // 4 turns; newest 2 kept
    const { messages: compacted } = await compactViaLlm(
      msgs,
      "anthropic/claude-haiku-4-5",
      fakeCatalog,
      fakeConfig,
    )
    // The newest turns' content should appear in compacted
    const lastUserMsg = msgs[msgs.length - 2] as { role: string; content: string }
    const lastAsstMsg = msgs[msgs.length - 1] as { role: string; content: string }
    expect(compacted.some((m) => m.role === "user" && m.content === lastUserMsg.content)).toBe(true)
    expect(compacted.some((m) => m.role === "assistant" && m.content === lastAsstMsg.content)).toBe(true)
  })
})
