import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { buildRequestMessages, contextBudget, estimateTokens } from "../src/context/budget"
import type { WorkingSetItem } from "../src/context/types"
import { ContextWorkingSet } from "../src/context/working-set"

const BODY = `line of real tool output ${"x".repeat(200)}`

function toolTurn(id: string, output = BODY): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: {} }],
    } as any,
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value: output } },
      ],
    } as any,
  ]
}

function echoItem(id: string, content = BODY): WorkingSetItem {
  return {
    kind: "tool-result",
    content,
    reason: "bash output",
    ttl: 2,
    estimatedTokens: estimateTokens(content),
    createdAt: Date.now(),
    toolCallId: id,
  }
}

const build = (messages: ModelMessage[], workingSet: WorkingSetItem[], budget = 8000, naive = false) =>
  buildRequestMessages({
    system: "sys",
    messages,
    workingSet,
    summaries: [],
    budget: contextBudget("balanced", budget),
    naive,
  })

const sentText = (r: ReturnType<typeof build>) =>
  r.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")

describe("working set holds one lease per tool result", () => {
  test("distinct tool results no longer evict each other", () => {
    const ws = new ContextWorkingSet()
    ws.add({ kind: "tool-result", content: "AAA", reason: "bash output", ttl: 2, toolCallId: "call-1" })
    ws.add({ kind: "tool-result", content: "BBB", reason: "grep output", ttl: 2, toolCallId: "call-2" })
    ws.add({ kind: "tool-result", content: "CCC", reason: "read output", ttl: 2, toolCallId: "call-3" })

    expect(ws.all().filter((i) => i.kind === "tool-result")).toHaveLength(3)
  })

  test("retention is capped so a many-tool turn cannot stack echoes", () => {
    const ws = new ContextWorkingSet()
    for (let i = 0; i < 10; i++) {
      ws.add({ kind: "tool-result", content: `out-${i}`, reason: "bash output", ttl: 2, toolCallId: `c${i}` })
    }
    const kept = ws.all().filter((i) => i.kind === "tool-result")

    expect(kept).toHaveLength(3)
    // Newest survive; oldest are dropped.
    expect(kept.map((i) => i.content)).toEqual(["out-7", "out-8", "out-9"])
  })

  test("the cap does not evict other kinds", () => {
    const ws = new ContextWorkingSet()
    ws.add({ kind: "summary", path: "a.ts", summary: "s", reason: "idx", ttl: 10 })
    ws.add({
      kind: "file-range",
      path: "b.ts",
      startLine: 1,
      endLine: 9,
      content: "x",
      reason: "read",
      ttl: 4,
    })
    for (let i = 0; i < 6; i++) {
      ws.add({ kind: "tool-result", content: `out-${i}`, reason: "bash output", ttl: 2, toolCallId: `c${i}` })
    }
    expect(ws.all().filter((i) => i.kind === "summary")).toHaveLength(1)
    expect(ws.all().filter((i) => i.kind === "file-range")).toHaveLength(1)
  })

  test("re-adding the same call id still replaces, not duplicates", () => {
    const ws = new ContextWorkingSet()
    ws.add({ kind: "tool-result", content: "first", reason: "bash output", ttl: 2, toolCallId: "call-1" })
    ws.add({ kind: "tool-result", content: "second", reason: "bash output", ttl: 2, toolCallId: "call-1" })

    const items = ws.all().filter((i) => i.kind === "tool-result")
    expect(items).toHaveLength(1)
    expect(items[0]?.content).toBe("second")
  })
})

describe("single-carrier dedup", () => {
  test("echo is dropped while the authoritative result is in the sent history", () => {
    const messages = [{ role: "user", content: "run it" } as ModelMessage, ...toolTurn("call-1")]
    const withEcho = build(messages, [echoItem("call-1")])
    const withoutEcho = build(messages, [])

    // The body is still sent exactly once (via history) — nothing was lost.
    expect(sentText(withEcho)).toContain("real tool output")
    expect(withEcho.plan.toolResultTokens).toBe(0)
    // And carrying the echo costs no more than not having it at all.
    expect(withEcho.plan.totalEstimatedTokens).toBe(withoutEcho.plan.totalEstimatedTokens)
  })

  test("echo survives and carries the output once history no longer holds it", () => {
    // Realistic shape: history holds the full output, the working set a truncated echo.
    // A budget between the two forces history to drop the turn while the echo still fits.
    const fullOutput = `real tool output ${"x".repeat(8000)}`
    const echo = `real tool output ${"x".repeat(200)}`
    const messages = [
      { role: "user", content: "run it" } as ModelMessage,
      ...toolTurn("call-1", fullOutput),
      { role: "user", content: "now what?" } as ModelMessage,
    ]
    const trimmed = build(messages, [echoItem("call-1", echo)], 600)

    const historyHasResult = trimmed.keptHistoryMessages.some(
      (m) => m.role === "tool" && JSON.stringify(m.content).includes("call-1"),
    )
    expect(historyHasResult).toBe(false)
    // The working set is now the only carrier, and it kept the output alive.
    expect(sentText(trimmed)).toContain("real tool output")
  })

  test("untagged working-set items are never dropped", () => {
    const messages = [{ role: "user", content: "run it" } as ModelMessage, ...toolTurn("call-1")]
    const legacy = { ...echoItem("call-1"), toolCallId: undefined }
    expect(build(messages, [legacy]).plan.toolResultTokens).toBeGreaterThan(0)
  })

  test("naive mode keeps both copies — the baseline must stay un-optimized", () => {
    const messages = [{ role: "user", content: "run it" } as ModelMessage, ...toolTurn("call-1")]
    const naive = build(messages, [echoItem("call-1")], 8000, true)

    expect(naive.plan.toolResultTokens).toBeGreaterThan(0)
    expect(naive.plan.savingsEstimate).toBe(0)
  })
})
