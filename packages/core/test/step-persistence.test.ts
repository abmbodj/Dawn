import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"

/**
 * Tests that the onStepFinish callback contract is sound:
 * messages accumulated per-step must produce a valid transcript (no orphan tool-calls).
 *
 * We test this by simulating what onStepFinish does — pushing step response messages
 * to a growing messages array — and verifying the result is a valid transcript.
 */
describe("step-by-step persistence", () => {
  test("accumulating step messages produces a valid transcript", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Do something" }]

    // Simulate step 1: text-only response
    const step1Messages: ModelMessage[] = [{ role: "assistant", content: "I will help." }]
    messages.push(...step1Messages)

    // No orphan tool-call: last assistant message has no pending tool-calls
    const lastMsg = messages.at(-1)!
    expect(lastMsg.role).toBe("assistant")
    expect(typeof lastMsg.content === "string" || Array.isArray(lastMsg.content)).toBe(true)
    if (Array.isArray(lastMsg.content)) {
      const pendingCalls = (lastMsg.content as Array<{ type: string; state?: string }>).filter(
        (p) => p.type === "tool-call" && p.state !== "result",
      )
      expect(pendingCalls.length).toBe(0)
    }

    // Simulate step 2: tool-call + tool-result pair (a complete step)
    const step2Messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading the file." },
          { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { filePath: "foo.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "read",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ]
    messages.push(...step2Messages)

    // The transcript is valid: every tool-call has a matching tool-result
    const allCalls = new Set<string>()
    const allResults = new Set<string>()
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content as Array<{ type: string; toolCallId?: string }>) {
          if (part.type === "tool-call" && part.toolCallId) allCalls.add(part.toolCallId)
        }
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const part of msg.content as Array<{ type: string; toolCallId?: string }>) {
          if (part.type === "tool-result" && part.toolCallId) allResults.add(part.toolCallId)
        }
      }
    }
    for (const id of allCalls) {
      expect(allResults.has(id)).toBe(true)
    }

    // Final turn count is correct
    expect(messages.filter((m) => m.role === "user").length).toBe(1)
    expect(messages.filter((m) => m.role === "assistant").length).toBe(2)
  })

  test("abort after completed step: prior steps are in messages array", () => {
    // Simulates: user sends a turn -> step 1 finishes (onStepFinish called) -> abort
    // The messages array should contain the user message + step-1 messages.
    const messages: ModelMessage[] = [{ role: "user", content: "Run something" }]

    // onStepFinish fires for step 1
    const step1: ModelMessage[] = [{ role: "assistant", content: "Step 1 done." }]
    messages.push(...step1) // what onStepFinish does

    // Then abort happens — no more steps. The messages array already has step 1.
    expect(messages.length).toBe(2)
    expect(messages[1]?.role).toBe("assistant")
    expect(messages[1]?.content).toBe("Step 1 done.")
  })

  test("compactViaLlm produces a smaller messages array", async () => {
    const { compactViaLlm } = await import("../src/context/compact-llm")

    // 6-turn history (12 messages)
    const history: ModelMessage[] = []
    for (let i = 1; i <= 6; i++) {
      history.push({ role: "user", content: `Turn ${i} question` })
      history.push({ role: "assistant", content: `Turn ${i} answer` })
    }

    const { messages: compacted } = await compactViaLlm(history, "test/model", {}, {})
    expect(compacted.length).toBeLessThan(history.length)
    // Newest 3 turns should be intact
    expect(compacted[compacted.length - 1]?.content).toBe("Turn 6 answer")
    expect(compacted[compacted.length - 2]?.content).toBe("Turn 6 question")
  })
})
