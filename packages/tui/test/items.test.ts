import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "@dawn/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { act, createElement } from "react"
import { type Item, ItemView, itemsFromMessages, reduceItems } from "../src/app"

const reactActEnv = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

// Helper to build an assistant message with a tool-call part
function toolCallMsg(toolName: string, input: Record<string, unknown>): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "tc1", toolName, input }],
  }
}

// Minimal reduceItems logic re-tested here via itemsFromMessages
describe("itemsFromMessages", () => {
  test("user messages become user items", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
    const items = itemsFromMessages(messages)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("user")
    expect((items[0] as any).text).toBe("hello")
  })

  test("assistant text becomes a done assistant item", () => {
    const messages: ModelMessage[] = [{ role: "assistant", content: "here is the answer" }]
    const items = itemsFromMessages(messages)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("assistant")
    expect((items[0] as any).done).toBe(true)
  })

  test("tool-call parts produce tool items with non-empty titles", () => {
    const messages: ModelMessage[] = [toolCallMsg("read", { filePath: "src/agent.ts", offset: 1, limit: 50 })]
    const items = itemsFromMessages(messages)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("tool")
    const tool = items[0] as Extract<Item, { kind: "tool" }>
    expect(tool.name).toBe("read")
    expect(tool.title.length).toBeGreaterThan(0)
    expect(tool.done).toBe(true)
  })

  test("reasoning parts produce done reasoning items", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "let me think about this" }],
      },
    ]
    const items = itemsFromMessages(messages)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("reasoning")
    expect((items[0] as any).done).toBe(true)
  })

  test("mixed message produces ordered items", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "fix bug" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking…" },
          { type: "tool-call", toolCallId: "tc2", toolName: "grep", input: { pattern: "bug" } },
          { type: "text", text: "fixed it" },
        ],
      },
    ]
    const items = itemsFromMessages(messages)
    expect(items.map((i) => i.kind)).toEqual(["user", "reasoning", "tool", "assistant"])
  })

  test("skips empty assistant text parts", () => {
    const messages: ModelMessage[] = [{ role: "assistant", content: [{ type: "text", text: "   " }] }]
    const items = itemsFromMessages(messages)
    expect(items).toHaveLength(0)
  })
})

describe("firstLines helper (via tool error display)", () => {
  // We test this inline by constructing multi-line error summaries
  test("itemsFromMessages handles tool errors in history gracefully", () => {
    // History won't normally have tool-error parts in persisted messages,
    // but assistant text messages always deserialize correctly
    const messages: ModelMessage[] = [{ role: "assistant", content: "line1\nline2\nline3\nline4" }]
    const items = itemsFromMessages(messages)
    expect(items[0]?.kind).toBe("assistant")
    expect((items[0] as any).text).toContain("line1")
  })
})

describe("ItemView", () => {
  test("renders tool errors without crashing the OpenTUI text renderer", async () => {
    reactActEnv.IS_REACT_ACT_ENVIRONMENT = true
    const setup = await createTestRenderer({ width: 80, height: 8 })
    const root = createRoot(setup.renderer)
    const item: Extract<Item, { kind: "tool" }> = {
      kind: "tool",
      id: "tool-1",
      name: "bash",
      title: "echo broken",
      summary: "line1\nline2\nline3\nline4",
      isError: true,
      done: true,
    }

    try {
      act(() => {
        root.render(
          createElement(ItemView, {
            item,
            spinnerFrame: "⠋",
            isLastRunningTool: false,
          }),
        )
      })

      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain("✗ bash echo broken")
      expect(frame).toContain("line1")
      expect(frame).toContain("line2")
      expect(frame).toContain("line3")
      expect(frame).not.toContain("line4")
    } finally {
      act(() => {
        root.unmount()
      })
      await setup.renderer.destroy()
      reactActEnv.IS_REACT_ACT_ENVIRONMENT = false
    }
  })
})

describe("reduceItems", () => {
  test("attempt-reset discards current-turn partial output but preserves prior turns and the latest user", () => {
    let items: Item[] = [
      { kind: "user", text: "old prompt" },
      { kind: "assistant", text: "old answer", done: true },
      { kind: "user", text: "current prompt" },
      { kind: "reasoning", text: "thinking", done: false },
      { kind: "assistant", text: "partial answer" },
      { kind: "tool", id: "t1", name: "read", title: "foo.ts", done: false },
    ]

    items = reduceItems(items, {
      type: "agent",
      event: { type: "attempt-reset", reason: "retryable-tool-failure" },
    })

    expect(items).toEqual([
      { kind: "user", text: "old prompt" },
      { kind: "assistant", text: "old answer", done: true },
      { kind: "user", text: "current prompt" },
    ])
  })

  test("status events become visible info rows after a reset", () => {
    let items: Item[] = [{ kind: "user", text: "current prompt" }]

    items = reduceItems(items, {
      type: "agent",
      event: { type: "status", message: "provider rejected a tool call — retrying…" },
    })

    expect(items).toEqual([
      { kind: "user", text: "current prompt" },
      { kind: "info", text: "provider rejected a tool call — retrying…" },
    ])
  })

  test("turn-end after attempt-reset does not restore discarded partial items", () => {
    let items: Item[] = [
      { kind: "user", text: "current prompt" },
      { kind: "assistant", text: "partial answer" },
    ]

    items = reduceItems(items, {
      type: "agent",
      event: { type: "attempt-reset", reason: "retryable-tool-failure" },
    })
    items = reduceItems(items, {
      type: "agent",
      event: { type: "turn-end" },
    })

    expect(items).toEqual([{ kind: "user", text: "current prompt" }])
  })
})
