import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Catalog, setApiKey } from "@dawn/core"
import { buildModelEntries, buildPickerRows, buildRecommendedEntries } from "../src/components/ModelPicker"

const catalog: Catalog = {
  test: {
    id: "test",
    name: "Test",
    models: {
      "free-a": { id: "free-a", name: "Free Model A", cost: { input: 0, output: 0 } },
      "free-b": { id: "free-b", name: "Free Model B", cost: { input: 0, output: 0 } },
      "paid-cheap": { id: "paid-cheap", name: "Paid Cheap", cost: { input: 1, output: 2 } },
      "paid-expensive": { id: "paid-expensive", name: "Paid Expensive", cost: { input: 10, output: 20 } },
      "no-price": { id: "no-price", name: "No Price" },
      "no-tool": { id: "no-tool", name: "No Tool", tool_call: false },
      reasoning: { id: "reasoning", name: "Reasoner", cost: { input: 5, output: 15 }, reasoning: true },
    },
  },
}

describe("buildModelEntries", () => {
  test("excludes models with tool_call === false", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    expect(entries.find((e) => e.id === "no-tool")).toBeUndefined()
  })

  test("places current model first", () => {
    const entries = buildModelEntries("test", catalog, "test/paid-expensive")
    expect(entries[0]?.id).toBe("paid-expensive")
    expect(entries[0]?.isCurrent).toBe(true)
  })

  test("sorts free models before paid, paid by ascending input price, unpriced last", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    const ids = entries.map((e) => e.id)

    // current first
    expect(ids[0]).toBe("free-a")
    // remaining free before paid
    expect(ids[1]).toBe("free-b")
    // paid in price order
    const paidCheapIdx = ids.indexOf("paid-cheap")
    const paidExpIdx = ids.indexOf("paid-expensive")
    const reasonerIdx = ids.indexOf("reasoning")
    expect(paidCheapIdx).toBeLessThan(paidExpIdx)
    expect(paidCheapIdx).toBeLessThan(reasonerIdx)
    // unpriced last
    expect(ids[ids.length - 1]).toBe("no-price")
  })

  test("marks current model with isCurrent = true", () => {
    const entries = buildModelEntries("test", catalog, "test/paid-cheap")
    const current = entries.find((e) => e.id === "paid-cheap")
    expect(current?.isCurrent).toBe(true)
  })

  test("marks reasoning model with reasoning = true", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    const reasoner = entries.find((e) => e.id === "reasoning")
    expect(reasoner?.reasoning).toBe(true)
  })

  test("marks free models with price.kind = 'free'", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    const freeEntry = entries.find((e) => e.id === "free-b")
    expect(freeEntry?.price).toEqual({ kind: "free" })
  })

  test("marks models without cost as price.kind = 'unknown'", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    const noPriceEntry = entries.find((e) => e.id === "no-price")
    expect(noPriceEntry?.price).toEqual({ kind: "unknown" })
  })

  test("marks paid models with per-tok price", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    const paid = entries.find((e) => e.id === "paid-cheap")
    expect(paid?.price).toEqual({ kind: "per-tok", in: 1, out: 2 })
  })

  test("returns empty list for unknown provider", () => {
    const entries = buildModelEntries("nonexistent", catalog, "nonexistent/x")
    expect(entries).toEqual([])
  })

  test("marks below-floor models experimental and sorts them after viable ones", () => {
    const tierCatalog: Catalog = {
      test: {
        id: "test",
        name: "Test",
        models: {
          viable: { id: "viable", name: "Viable", cost: { input: 9 }, limit: { context: 200_000 } },
          tiny: { id: "tiny", name: "Tiny", cost: { input: 1 }, limit: { context: 4_000 } },
        },
      },
    }
    const entries = buildModelEntries("test", tierCatalog, "test/none")
    const tiny = entries.find((e) => e.id === "tiny")
    expect(tiny?.tier).toBe("experimental")
    // Despite being cheaper, the experimental model sorts after the standard one.
    expect(entries.map((e) => e.id)).toEqual(["viable", "tiny"])
  })
})

// ─── Shared hermetic env setup for tests that read auth.json ─────────────────

const NEUTRALIZED = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"]
let tmp: string
let savedEnv: Record<string, string | undefined>

function setupHermetic() {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-picker-"))
    process.env.DAWN_DATA_DIR = path.join(tmp, "data")
    process.env.DAWN_CONFIG_DIR = path.join(tmp, "config")
    process.env.DAWN_CACHE_DIR = path.join(tmp, "cache")
    savedEnv = {}
    for (const k of NEUTRALIZED) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    delete process.env.DAWN_DATA_DIR
    delete process.env.DAWN_CONFIG_DIR
    delete process.env.DAWN_CACHE_DIR
    for (const k of NEUTRALIZED) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })
}

// Minimal catalog with anthropic blessed models for connectivity-aware tests.
const recCatalog: Catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-opus-4-8": { id: "claude-opus-4-8", name: "Opus", cost: { input: 15 } },
      "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Haiku", cost: { input: 1 } },
      "some-other": { id: "some-other", name: "Other", cost: { input: 2 } },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", cost: { input: 20 } },
    },
  },
  google: {
    id: "google",
    name: "Google",
    env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    models: {
      "gemini-3.5-pro": { id: "gemini-3.5-pro", name: "Gemini 3.5 Pro", cost: { input: 5 } },
    },
  },
}

describe("buildRecommendedEntries", () => {
  setupHermetic()

  test("lists only blessed models from connected providers, cheapest first", () => {
    setApiKey("anthropic", "sk-test")
    const entries = buildRecommendedEntries(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8")
    const ids = entries.map((e) => e.id)
    expect(ids).toContain("claude-opus-4-8")
    expect(ids).toContain("claude-haiku-4-5")
    expect(ids).not.toContain("some-other") // not blessed
    expect(entries.every((e) => e.tier === "blessed")).toBe(true)
    // current (opus) first, then by price
    expect(ids[0]).toBe("claude-opus-4-8")
  })

  test("is empty when the blessed providers are not connected", () => {
    const entries = buildRecommendedEntries(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8")
    expect(entries).toEqual([])
  })
})

describe("buildPickerRows", () => {
  setupHermetic()

  test("section order: RECOMMENDED → provider → MORE PROVIDERS", () => {
    setApiKey("anthropic", "sk-test")
    const rows = buildPickerRows(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8", "")
    const headers = rows
      .filter((r): r is { kind: "header"; label: string; count: number } => r.kind === "header")
      .map((r) => r.label)
    expect(headers[0]).toBe("RECOMMENDED")
    expect(headers[1]).toBe("ANTHROPIC")
    expect(headers[headers.length - 1]).toBe("MORE PROVIDERS")
  })

  test("headers carry correct model counts", () => {
    setApiKey("anthropic", "sk-test")
    const rows = buildPickerRows(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8", "")
    const recHeader = rows.find(
      (r): r is { kind: "header"; label: string; count: number } =>
        r.kind === "header" && r.label === "RECOMMENDED",
    )
    expect(recHeader).toBeDefined()
    expect(recHeader?.count).toBeGreaterThan(0)
  })

  test("connect rows appear after model rows", () => {
    setApiKey("anthropic", "sk-test")
    const rows = buildPickerRows(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8", "")
    const connectIndices = rows.map((r, i) => (r.kind === "connect" ? i : -1)).filter((i) => i >= 0)
    const modelIndices = rows.map((r, i) => (r.kind === "model" ? i : -1)).filter((i) => i >= 0)
    if (connectIndices.length > 0 && modelIndices.length > 0) {
      expect(Math.min(...connectIndices)).toBeGreaterThan(Math.max(...modelIndices))
    }
  })

  test("query filters model rows to matching entries only", () => {
    setApiKey("anthropic", "sk-test")
    const rows = buildPickerRows(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8", "opus")
    const modelRows = rows.filter((r): r is { kind: "model"; entry: any } => r.kind === "model")
    expect(modelRows.length).toBeGreaterThan(0)
    for (const r of modelRows) {
      const matched =
        r.entry.name.toLowerCase().includes("opus") ||
        r.entry.id.toLowerCase().includes("opus") ||
        r.entry.providerId.toLowerCase().includes("opus")
      expect(matched).toBe(true)
    }
  })

  test("query hides connect section", () => {
    setApiKey("anthropic", "sk-test")
    const rows = buildPickerRows(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8", "opus")
    expect(rows.filter((r) => r.kind === "connect")).toHaveLength(0)
  })

  test("query drops sections with no matching models", () => {
    setApiKey("anthropic", "sk-test")
    const rows = buildPickerRows(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8", "zzznomatch")
    const modelRows = rows.filter((r) => r.kind === "model")
    const headerRows = rows.filter((r) => r.kind === "header")
    expect(modelRows).toHaveLength(0)
    expect(headerRows).toHaveLength(0)
  })

  test("shows no RECOMMENDED section when no providers connected", () => {
    const rows = buildPickerRows(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8", "")
    const headers = rows
      .filter((r): r is { kind: "header"; label: string; count: number } => r.kind === "header")
      .map((r) => r.label)
    expect(headers).not.toContain("RECOMMENDED")
  })

  test("shows multiple provider sections when multiple providers connected", () => {
    setApiKey("anthropic", "sk-test")
    setApiKey("openai", "sk-oai")
    const rows = buildPickerRows(recCatalog, { providers: {} }, "anthropic/claude-opus-4-8", "")
    const headers = rows
      .filter((r): r is { kind: "header"; label: string; count: number } => r.kind === "header")
      .map((r) => r.label)
    expect(headers).toContain("ANTHROPIC")
    expect(headers).toContain("OPENAI")
  })
})
