import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Catalog, setApiKey } from "@dawn/core"
import { buildModelEntries, buildRecommendedEntries } from "../src/components/ModelPicker"

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

  test("marks current model with ✓ in name", () => {
    const entries = buildModelEntries("test", catalog, "test/paid-cheap")
    const current = entries.find((e) => e.id === "paid-cheap")
    expect(current?.name).toContain("✓")
  })

  test("marks reasoning model with ✦ in name", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    const reasoner = entries.find((e) => e.id === "reasoning")
    expect(reasoner?.name).toContain("✦")
  })

  test("shows 'free' cost label for zero-price models", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    const freeEntry = entries.find((e) => e.id === "free-b")
    expect(freeEntry?.description).toContain("free")
  })

  test("shows 'price unknown' for models without cost", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    const noPriceEntry = entries.find((e) => e.id === "no-price")
    expect(noPriceEntry?.description).toContain("price unknown")
  })

  test("shows per-Mtok price for paid models", () => {
    const entries = buildModelEntries("test", catalog, "test/free-a")
    const paid = entries.find((e) => e.id === "paid-cheap")
    expect(paid?.description).toContain("$1/$2 per Mtok")
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
    expect(tiny?.description).toContain("experimental")
    // Despite being cheaper, the experimental model sorts after the standard one.
    expect(entries.map((e) => e.id)).toEqual(["viable", "tiny"])
  })
})

describe("buildRecommendedEntries", () => {
  let tmp: string
  // Neutralize host provider keys so connectivity is controlled purely by setApiKey.
  const NEUTRALIZED = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"]
  let savedEnv: Record<string, string | undefined>
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-picker-rec-"))
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
  }

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
