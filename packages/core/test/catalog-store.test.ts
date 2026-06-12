import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FALLBACK_CATALOG, getModelInfo, parseModelRef } from "../src/provider/catalog"
import { SessionStore } from "../src/session/store"

describe("parseModelRef", () => {
  test("splits provider and model", () => {
    expect(parseModelRef("anthropic/claude-opus-4-8")).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
    })
  })

  test("keeps slashes inside model ids", () => {
    expect(parseModelRef("openrouter/meta/llama-4")).toEqual({
      providerId: "openrouter",
      modelId: "meta/llama-4",
    })
  })

  test("rejects refs without a slash", () => {
    expect(() => parseModelRef("claude")).toThrow("provider/model")
  })
})

describe("fallback catalog", () => {
  test("contains a priced default anthropic model", () => {
    const info = getModelInfo(FALLBACK_CATALOG, "anthropic/claude-opus-4-8")
    expect(info?.cost?.input).toBe(5)
    expect(info?.cost?.cache_read).toBe(0.5)
  })
})

describe("SessionStore", () => {
  let tmp: string
  let store: SessionStore

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-db-"))
    store = new SessionStore(path.join(tmp, "test.db"))
  })

  afterEach(() => {
    store.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("messages round-trip and sessions resume by cwd", () => {
    const session = store.createSession("/some/project", "first task")
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] },
    ]
    store.saveMessages(session.id, messages)
    expect(store.loadMessages(session.id)).toEqual(messages)
    expect(store.lastSession("/some/project")?.id).toBe(session.id)
    expect(store.lastSession("/other")).toBeUndefined()
  })

  test("usage accumulates", () => {
    const session = store.createSession("/p")
    const step = {
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 80,
      cacheWriteTokens: 10,
      cost: 0.001,
    }
    store.recordUsage(session.id, step)
    store.recordUsage(session.id, { ...step, cost: 0.002 })
    const totals = store.usageTotals(session.id)
    expect(totals.inputTokens).toBe(200)
    expect(totals.cachedInputTokens).toBe(160)
    expect(totals.cost).toBeCloseTo(0.003, 10)
    expect(totals.steps).toBe(2)
  })
})
