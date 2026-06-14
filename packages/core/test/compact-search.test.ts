import { describe, expect, test } from "bun:test"
import { compactSearch } from "../src/context/compact"

describe("compactSearch", () => {
  test("caps matches per file and notes the remainder", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `src/app.ts:${i + 1}:match ${i}`)
    const result = compactSearch(lines.join("\n"), 16)
    expect(result.lossy).toBe(true)
    expect(result.text).toContain("src/app.ts:1:")
    expect(result.text).toMatch(/\+\d+ more match/)
    expect(result.dropped).toMatch(/matches/)
  })

  test("omits files beyond the file cap", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts:1:hit`)
    const result = compactSearch(lines.join("\n"), 8)
    expect(result.lossy).toBe(true)
    expect(result.text).toMatch(/more file/)
  })

  test("non-grep output falls back to text compaction", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `plain line ${i}`)
    const result = compactSearch(lines.join("\n"), 16)
    expect(result.lossy).toBe(true)
    expect(result.text).toContain("plain line 0")
  })

  test("small grep output is unchanged", () => {
    const text = "src/a.ts:1:x\nsrc/b.ts:2:y"
    expect(compactSearch(text, 16).lossy).toBe(false)
  })
})
