import { describe, expect, test } from "bun:test"
import type { Catalog } from "@dawn/core"
import { buildModelEntries } from "../src/components/ModelPicker"

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
})
