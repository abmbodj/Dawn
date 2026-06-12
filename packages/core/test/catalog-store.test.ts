import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  FALLBACK_CATALOG,
  getModelInfo,
  loadCatalog,
  normalizeModelRef,
  parseModelRef,
} from "../src/provider/catalog"
import { resolveModel } from "../src/provider/provider"
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

  test("keeps Groq namespaced model ids intact", () => {
    expect(parseModelRef("groq/meta-llama/llama-4-scout-17b-16e-instruct")).toEqual({
      providerId: "groq",
      modelId: "meta-llama/llama-4-scout-17b-16e-instruct",
    })
  })

  test("rejects refs without a slash", () => {
    expect(() => parseModelRef("claude")).toThrow("provider/model")
  })
})

describe("normalizeModelRef", () => {
  test("maps legacy Groq Scout and Maverick refs to canonical namespaced ids", () => {
    expect(normalizeModelRef("groq/llama-4-scout-17b-16e-instruct")).toBe(
      "groq/meta-llama/llama-4-scout-17b-16e-instruct",
    )
    expect(normalizeModelRef("groq/llama-4-maverick-17b-128e-instruct")).toBe(
      "groq/meta-llama/llama-4-maverick-17b-128e-instruct",
    )
  })

  test("leaves canonical and unrelated refs unchanged", () => {
    expect(normalizeModelRef("groq/meta-llama/llama-4-scout-17b-16e-instruct")).toBe(
      "groq/meta-llama/llama-4-scout-17b-16e-instruct",
    )
    expect(normalizeModelRef("anthropic/claude-opus-4-8")).toBe("anthropic/claude-opus-4-8")
  })
})

describe("fallback catalog", () => {
  test("contains a priced default anthropic model", () => {
    const info = getModelInfo(FALLBACK_CATALOG, "anthropic/claude-opus-4-8")
    expect(info?.cost?.input).toBe(5)
    expect(info?.cost?.cache_read).toBe(0.5)
  })

  test("contains canonical Groq Scout and omits the legacy bare key", () => {
    const models = FALLBACK_CATALOG.groq?.models ?? {}
    expect(models["meta-llama/llama-4-scout-17b-16e-instruct"]).toBeDefined()
    expect(models["llama-4-scout-17b-16e-instruct"]).toBeUndefined()
  })

  test("normalizes stale cached Groq model ids", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-cache-"))
    const previous = process.env.DAWN_CACHE_DIR
    process.env.DAWN_CACHE_DIR = tmp

    try {
      fs.writeFileSync(
        path.join(tmp, "models.json"),
        JSON.stringify({
          groq: {
            id: "groq",
            name: "Groq",
            env: ["GROQ_API_KEY"],
            api: "https://api.groq.com/openai/v1",
            models: {
              "llama-4-scout-17b-16e-instruct": {
                id: "llama-4-scout-17b-16e-instruct",
                name: "Legacy Scout",
                tool_call: true,
              },
            },
          },
        }),
      )

      const catalog = await loadCatalog()
      expect(catalog.groq?.models["llama-4-scout-17b-16e-instruct"]).toBeUndefined()
      expect(catalog.groq?.models["meta-llama/llama-4-scout-17b-16e-instruct"]).toBeDefined()
    } finally {
      if (previous === undefined) delete process.env.DAWN_CACHE_DIR
      else process.env.DAWN_CACHE_DIR = previous
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("resolveModel", () => {
  test("resolves a legacy Groq ref to the canonical model id", () => {
    const resolved = resolveModel(
      "groq/llama-4-scout-17b-16e-instruct",
      {
        groq: {
          id: "groq",
          name: "Groq",
          env: [],
          api: "https://api.groq.com/openai/v1",
          models: {
            "meta-llama/llama-4-scout-17b-16e-instruct": {
              id: "meta-llama/llama-4-scout-17b-16e-instruct",
              name: "Llama 4 Scout",
            },
          },
        },
      },
      { providers: {} },
    )

    expect(resolved.providerId).toBe("groq")
    expect(resolved.modelId).toBe("meta-llama/llama-4-scout-17b-16e-instruct")
    expect(resolved.info?.name).toBe("Llama 4 Scout")
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

  test("usage rolls up by project and lifetime", () => {
    const first = store.createSession("/p")
    const second = store.createSession("/p")
    const other = store.createSession("/other")
    const step = {
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
      cacheWriteTokens: 5,
      cost: 0.001,
    }

    store.recordUsage(first.id, step)
    store.recordUsage(second.id, { ...step, inputTokens: 200, cost: 0.002 })
    store.recordUsage(other.id, { ...step, inputTokens: 300, cost: 0.003 })

    expect(
      store
        .sessionsForCwd("/p")
        .map((session) => session.id)
        .sort(),
    ).toEqual([first.id, second.id].sort())
    expect(store.allSessions()).toHaveLength(3)
    expect(store.usageTotalsForCwd("/p").inputTokens).toBe(300)
    expect(store.usageTotalsForCwd("/p").steps).toBe(2)
    expect(store.usageTotalsAll().inputTokens).toBe(600)
    expect(store.usageTotalsAll().cost).toBeCloseTo(0.006, 10)
  })
})
