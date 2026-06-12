import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ModelMessage } from "ai"
import { buildContextPlan, buildRequestMessages, groupHistory, trimHistory } from "../src/context/budget"
import { buildRepoIndex } from "../src/context/indexer"
import { ContextStore } from "../src/context/store"
import { getFileSummary } from "../src/context/summarize"
import { ContextWorkingSet } from "../src/context/working-set"

describe("repo index", () => {
  let tmp: string
  let repo: string
  let store: ContextStore

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-context-"))
    repo = path.join(tmp, "repo")
    fs.mkdirSync(repo)
    store = new ContextStore(path.join(tmp, "test.db"))
  })

  afterEach(() => {
    store.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("ignores node_modules and .git", async () => {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true })
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true })
    fs.mkdirSync(path.join(repo, ".git", "objects"), { recursive: true })
    fs.writeFileSync(path.join(repo, "src", "main.ts"), "export function main() { return 1 }\n")
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.ts"), "export const ignored = true\n")
    fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n")

    const result = await buildRepoIndex(repo, store)

    expect(result.indexed).toBe(1)
    expect(store.indexStatus(repo).indexedFiles).toBe(1)
    expect(store.getIndexEntry(repo, path.join("src", "main.ts"))?.symbols).toContain("main")
    expect(store.getIndexEntry(repo, path.join("node_modules", "pkg", "index.ts"))).toBeUndefined()
  })

  test("file hash invalidates summary", () => {
    fs.writeFileSync(path.join(tmp, "auth.ts"), "export function login() { return true }\n")
    const first = getFileSummary({ cwd: tmp, path: "auth.ts", store })

    fs.writeFileSync(path.join(tmp, "auth.ts"), "export function login() { return false }\n")
    const second = getFileSummary({ cwd: tmp, path: "auth.ts", store })

    expect(second.hash).not.toBe(first.hash)
    expect(second.summary).toContain("login")
  })
})

describe("groupHistory", () => {
  test("singleton groups for plain messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "thanks" },
    ]
    const groups = groupHistory(messages)
    expect(groups).toHaveLength(3)
    expect(groups.every((g) => g.length === 1)).toBe(true)
  })

  test("assistant with tool-calls + tool messages form one atomic group", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "ok" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c2", toolName: "grep", output: { type: "text", value: "ok2" } },
        ],
      },
      { role: "assistant", content: "done" },
      { role: "user", content: "q2" },
    ]
    const groups = groupHistory(messages)
    // user, [assistant+2xtools], assistant, user
    expect(groups).toHaveLength(4)
    expect(groups[1]).toHaveLength(3) // the tool-call group
  })

  test("drops leading orphaned tool messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read",
            output: { type: "text", value: "stale" },
          },
        ],
      },
      { role: "user", content: "hello" },
    ]
    const groups = groupHistory(messages)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.[0]?.role).toBe("user")
  })
})

describe("trimHistory", () => {
  test("never orphans a tool-result without its assistant tool-call group", () => {
    // Construct a history where keeping only the tail would leave tool messages
    // without their parent assistant message
    const messages: ModelMessage[] = [
      { role: "user", content: "a" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read",
            output: { type: "text", value: "x".repeat(200) },
          },
        ],
      },
      { role: "assistant", content: "summary" },
      { role: "user", content: "final question" },
    ]
    // Tight budget: only fits the last group, not the tool-call pair
    const result = trimHistory(messages, 50)

    const roles = result.kept.map((m) => m.role)
    // Ensure no tool message appears without a preceding assistant tool-call message
    for (let i = 0; i < roles.length; i++) {
      if (roles[i] === "tool") {
        expect(roles[i - 1]).toBe("assistant")
        const prevContent = result.kept[i - 1]?.content
        const hasCalls =
          Array.isArray(prevContent) && (prevContent as any[]).some((p: any) => p.type === "tool-call")
        expect(hasCalls).toBe(true)
      }
    }
    // Latest user message must always be kept
    expect(JSON.stringify(result.kept.at(-1))).toContain("final question")
  })

  test("keeps latest message even when budget is tiny", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "x".repeat(500) },
      { role: "user", content: "tiny" },
    ]
    const result = trimHistory(messages, 1)
    expect(JSON.stringify(result.kept.at(-1))).toContain("tiny")
  })
})

describe("context budget", () => {
  test("trims expired working-set context before current context", () => {
    const built = buildRequestMessages({
      system: "system",
      messages: [{ role: "user", content: "latest request" }],
      summaries: [],
      budget: { mode: "balanced", budget: 40 },
      workingSet: [
        {
          kind: "file-range",
          path: "old.ts",
          startLine: 1,
          endLine: 80,
          content: "x".repeat(300),
          reason: "old",
          ttl: 0,
          estimatedTokens: 75,
          createdAt: 1,
        },
        {
          kind: "file-range",
          path: "current.ts",
          startLine: 1,
          endLine: 5,
          content: "const current = true",
          reason: "current",
          ttl: 2,
          estimatedTokens: 5,
          createdAt: 2,
        },
      ],
    })

    expect(built.plan.trimmedItems).toContain("old.ts lines 1-80")
    expect(built.plan.skippedItems).toContainEqual(
      expect.objectContaining({ label: "old.ts lines 1-80", reason: "expired" }),
    )
    expect(built.plan.includedItems).toContainEqual(
      expect.objectContaining({ label: "current.ts lines 1-5", reason: "current" }),
    )
    expect(JSON.stringify(built.messages)).toContain("current.ts")
    expect(JSON.stringify(built.messages)).toContain("latest request")
  })

  test("system is returned separately, not inside messages", () => {
    const built = buildRequestMessages({
      system: "stable system",
      messages: [
        { role: "user", content: `old ${"x".repeat(1000)}` },
        { role: "assistant", content: `old answer ${"y".repeat(1000)}` },
        { role: "user", content: "fix login bug" },
      ],
      summaries: [],
      workingSet: [],
      budget: { mode: "minimal", budget: 80 },
    })

    // System is a separate field, not inside messages
    expect(built.system.role).toBe("system")
    expect(built.system.content).toBe("stable system")
    expect(built.messages.every((m) => m.role !== "system")).toBe(true)
    // Latest user message preserved
    expect(JSON.stringify(built.messages.at(-1))).toContain("fix login bug")
  })

  test("context message sits immediately before latest user message", () => {
    const built = buildRequestMessages({
      system: "sys",
      messages: [
        { role: "user", content: "prev" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "current question" },
      ],
      summaries: [
        {
          path: "foo.ts",
          hash: "abc",
          summary: "does foo things",
          symbols: ["foo"],
          dependencies: [],
          lastSummarizedAt: 0,
          tokenEstimate: 10,
        },
      ],
      workingSet: [],
      budget: { mode: "balanced", budget: 2000 },
    })

    const msgs = built.messages
    const contextIdx = msgs.findIndex(
      (m) => typeof m.content === "string" && m.content.includes("compact repository context"),
    )
    const latestIdx = msgs.findIndex(
      (m) => typeof m.content === "string" && m.content.includes("current question"),
    )
    // Context message (if present) must be right before latest user message
    if (contextIdx !== -1) {
      expect(latestIdx).toBe(contextIdx + 1)
    }
  })

  test("answer guidance sits immediately before latest user message", () => {
    const built = buildRequestMessages({
      system: "sys",
      messages: [
        { role: "user", content: "prev" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "current question" },
      ],
      summaries: [],
      workingSet: [],
      budget: { mode: "balanced", budget: 2000 },
      answerGuidance: "First sentence: answer directly.",
    })

    const msgs = built.messages
    const guidanceIdx = msgs.findIndex(
      (m) => typeof m.content === "string" && m.content.includes("Answer guidance for this turn"),
    )
    const latestIdx = msgs.findIndex(
      (m) => typeof m.content === "string" && m.content.includes("current question"),
    )

    expect(guidanceIdx).not.toBe(-1)
    expect(latestIdx).toBe(guidanceIdx + 1)
    expect(
      msgs.filter(
        (m) => typeof m.content === "string" && m.content.includes("Answer guidance for this turn"),
      ),
    ).toHaveLength(1)
  })

  test("answer guidance does not replace the compact repo context message", () => {
    const built = buildRequestMessages({
      system: "sys",
      messages: [
        { role: "user", content: "prev" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "current question" },
      ],
      summaries: [
        {
          path: "foo.ts",
          hash: "abc",
          summary: "does foo things",
          symbols: ["foo"],
          dependencies: [],
          lastSummarizedAt: 0,
          tokenEstimate: 10,
        },
      ],
      workingSet: [],
      budget: { mode: "balanced", budget: 2000 },
      answerGuidance: "First sentence: answer directly.",
    })

    expect(
      built.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("compact repository context"),
      ),
    ).toBe(true)
    expect(
      built.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("Answer guidance for this turn"),
      ),
    ).toBe(true)
  })

  test("Anthropic: system carries providerOptions, last message carries cache breakpoint", () => {
    const built = buildRequestMessages({
      system: "sys",
      messages: [{ role: "user", content: "q" }],
      summaries: [],
      workingSet: [],
      budget: { mode: "balanced", budget: 2000 },
      isAnthropic: true,
    })

    expect((built.system as any).providerOptions?.anthropic?.cacheControl?.type).toBe("ephemeral")
    const last = built.messages.at(-1)
    expect((last as any)?.providerOptions?.anthropic?.cacheControl?.type).toBe("ephemeral")
  })
})

describe("context plan persistence", () => {
  let tmp: string
  let store: ContextStore

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-context-plan-"))
    store = new ContextStore(path.join(tmp, "test.db"))
  })

  afterEach(() => {
    store.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("aggregates saved tokens and highest-saving turns by session", () => {
    const small = buildContextPlan({
      systemTokens: 10,
      historyTokens: 20,
      summaryTokens: 0,
      fileTokens: 0,
      toolResultTokens: 0,
      budget: { mode: "balanced", budget: 100 },
      trimmedItems: ["history message"],
      includedItems: [
        { kind: "history", label: "conversation history", tokens: 20, reason: "recent history" },
      ],
      skippedItems: [{ kind: "history", label: "history message", tokens: 50, reason: "history budget" }],
      savingsEstimate: 50,
    })
    const large = buildContextPlan({
      systemTokens: 10,
      historyTokens: 20,
      summaryTokens: 30,
      fileTokens: 40,
      toolResultTokens: 0,
      budget: { mode: "deep", budget: 500 },
      trimmedItems: ["summary old.ts"],
      includedItems: [{ kind: "summary", label: "summary app.ts", tokens: 30, reason: "relevant summary" }],
      skippedItems: [{ kind: "summary", label: "summary old.ts", tokens: 200, reason: "summary budget" }],
      savingsEstimate: 200,
    })

    store.recordContextPlan("session-a", small)
    store.recordContextPlan("session-a", large)
    store.recordContextPlan("session-b", { ...large, savingsEstimate: 1000 })

    const totals = store.contextPlanTotals(["session-a"])

    expect(totals.plans).toBe(2)
    expect(totals.estimatedSavedTokens).toBe(250)
    expect(totals.plannedInputTokens).toBe(130)
    expect(totals.includedItems).toBe(2)
    expect(totals.skippedItems).toBe(2)
    expect(totals.highestSavingsPlan).toEqual(
      expect.objectContaining({ sessionId: "session-a", savedTokens: 200, totalEstimatedTokens: 100 }),
    )
    expect(store.contextPlans(["session-a"], 1)).toHaveLength(1)
    expect(store.contextPlanTotals([]).plans).toBe(0)
  })
})

describe("ContextWorkingSet", () => {
  test("evicts expired raw ranges after ttl decrement", () => {
    const workingSet = new ContextWorkingSet()
    workingSet.add({
      kind: "file-range",
      path: "src/auth.ts",
      startLine: 40,
      endLine: 120,
      content: "code",
      reason: "login validation bug",
      ttl: 1,
    })

    workingSet.decrementLeases()

    expect(workingSet.all()).toEqual([])
  })
})
