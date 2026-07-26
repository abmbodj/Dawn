import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { messageTokens, pruneToolResults } from "../src/context/budget"

const big = (marker: string, sentinel?: string) =>
  `${marker} ${"payload ".repeat(500)}${sentinel ? `\n${sentinel}` : ""}`

function turn(id: string, output: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: { command: `run ${id}` } }],
    } as any,
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value: output } },
      ],
    } as any,
  ]
}

/** Six tool turns — the shape of an investigate task that re-sends everything each step. */
function conversation(): ModelMessage[] {
  return [
    { role: "user", content: "investigate the repo" } as ModelMessage,
    ...turn(
      "c1",
      big("FIRST", '«expand:aaa111 — 900 lines elided; call expand("aaa111") for the full output»'),
    ),
    ...turn("c2", big("SECOND")),
    ...turn("c3", big("THIRD")),
    ...turn("c4", big("FOURTH")),
    ...turn("c5", big("FIFTH")),
    ...turn("c6", big("SIXTH")),
  ]
}

const totalTokens = (msgs: ModelMessage[]) => msgs.reduce((s, m) => s + messageTokens(m), 0)
const text = (msgs: ModelMessage[]) => JSON.stringify(msgs)

describe("pruneToolResults", () => {
  test("does nothing when the conversation fits the budget", () => {
    const msgs = conversation()
    const result = pruneToolResults(msgs, { budget: 1_000_000, protectTokens: 2000 })

    expect(result.prunedTokens).toBe(0)
    expect(result.messages).toBe(msgs) // same reference — no copying when idle
  })

  test("clears older outputs and keeps the newest ones whole", () => {
    const msgs = conversation()
    const result = pruneToolResults(msgs, { budget: 2000, protectTokens: 2000 })

    expect(result.prunedTokens).toBeGreaterThan(0)
    expect(totalTokens(result.messages)).toBeLessThan(totalTokens(msgs))

    const out = text(result.messages)
    // Newest survives intact; oldest is stubbed.
    expect(out).toContain("SIXTH payload")
    expect(out).not.toContain("FIRST payload")
    expect(out).toContain("Earlier tool output cleared")
  })

  test("keeps the expand sentinel so cleared output stays recoverable", () => {
    const result = pruneToolResults(conversation(), { budget: 2000, protectTokens: 2000 })
    expect(text(result.messages)).toContain("expand:aaa111")
  })

  test("never breaks tool-call/tool-result pairing", () => {
    const msgs = conversation()
    const result = pruneToolResults(msgs, { budget: 500, protectTokens: 500 })

    expect(result.messages).toHaveLength(msgs.length)
    for (const [i, m] of result.messages.entries()) {
      expect(m.role).toBe(msgs[i]?.role as any)
    }
    // Every tool-call still has its matching result id.
    const callIds = ["c1", "c2", "c3", "c4", "c5", "c6"]
    const serialized = text(result.messages)
    for (const id of callIds) {
      expect(serialized.split(`"toolCallId":"${id}"`).length - 1).toBe(2) // call + result
    }
  })

  test("preserves tool call inputs so the model still knows what it ran", () => {
    const result = pruneToolResults(conversation(), { budget: 500, protectTokens: 500 })
    expect(text(result.messages)).toContain("run c1")
  })

  test("leaves small outputs alone — stubbing them saves nothing", () => {
    const msgs = [
      { role: "user", content: "hi" } as ModelMessage,
      ...turn("s1", "ok"),
      ...turn("s2", big("BIG")),
    ]
    const result = pruneToolResults(msgs, { budget: 100, protectTokens: 0 })
    expect(text(result.messages)).toContain('"value":"ok"')
  })
})
