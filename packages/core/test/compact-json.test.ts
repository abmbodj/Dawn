import { describe, expect, test } from "bun:test"
import { compactJson } from "../src/context/compact"

function bigArray(n: number): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, name: `item ${i}`, value: i })))
}

describe("compactJson", () => {
  test("leaves small arrays untouched", () => {
    const text = JSON.stringify([{ a: 1 }, { a: 2 }])
    expect(compactJson(text, 16)).toEqual({ text, lossy: false })
  })

  test("elides the middle of a large array but keeps head, tail, and structure", () => {
    const text = bigArray(200)
    const result = compactJson(text, 16)
    expect(result.lossy).toBe(true)
    expect(result.text.length).toBeLessThan(text.length)
    expect(result.dropped).toMatch(/items/)
    // Head and tail items survive whole — including their high-entropy ids.
    expect(result.text).toContain("id-0")
    expect(result.text).toContain("id-199")
    // The elision marker is present and the result is still valid JSON.
    expect(result.text).toContain("items elided")
    expect(() => JSON.parse(result.text)).not.toThrow()
  })

  test("preserves object keys while crushing a nested array", () => {
    const text = JSON.stringify({ total: 500, rows: Array.from({ length: 100 }, (_, i) => ({ i })) })
    const result = compactJson(text, 8)
    expect(result.lossy).toBe(true)
    const parsed = JSON.parse(result.text) as { total: number; rows: unknown[] }
    expect(parsed.total).toBe(500)
    expect(Array.isArray(parsed.rows)).toBe(true)
  })

  test("is deterministic and idempotent", () => {
    const text = bigArray(200)
    const once = compactJson(text, 16)
    expect(compactJson(text, 16)).toEqual(once)
    // Re-compacting the already-compacted body does not shrink it further.
    expect(compactJson(once.text, 16).lossy).toBe(false)
  })

  test("non-JSON is reported as not lossy", () => {
    expect(compactJson("not json at all", 16)).toEqual({ text: "not json at all", lossy: false })
  })
})
