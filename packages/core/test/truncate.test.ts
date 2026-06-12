import { describe, expect, test } from "bun:test"
import { capLine, truncateMiddle } from "../src/tools/truncate"

describe("truncateMiddle", () => {
  test("returns short text unchanged", () => {
    expect(truncateMiddle("hello\nworld", 100)).toBe("hello\nworld")
  })

  test("keeps head and tail with omission marker", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`)
    const result = truncateMiddle(lines.join("\n"), 200)
    expect(result).toContain("line-0")
    expect(result).toContain("line-99")
    expect(result).toMatch(/\[… \d+ lines omitted …\]/)
    expect(result.length).toBeLessThan(300)
  })

  test("omitted count is accurate", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(40))
    const result = truncateMiddle(lines.join("\n"), 200)
    const match = result.match(/\[… (\d+) lines omitted …\]/)
    expect(match).not.toBeNull()
    const kept = result.split("\n").length - 1 // minus the marker line
    expect(kept + Number(match![1])).toBe(10)
  })
})

describe("capLine", () => {
  test("caps overly long lines with ellipsis", () => {
    expect(capLine("x".repeat(3000), 100)).toHaveLength(101)
    expect(capLine("short")).toBe("short")
  })
})
