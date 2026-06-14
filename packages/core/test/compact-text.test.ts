import { describe, expect, test } from "bun:test"
import { compactText } from "../src/context/compact"

describe("compactText", () => {
  test("keeps head and tail, omits the middle", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`)
    const result = compactText(lines.join("\n"), 40)
    expect(result.lossy).toBe(true)
    expect(result.text).toContain("line 0")
    expect(result.text).toContain("line 299")
    expect(result.text).toMatch(/middle lines? omitted/)
  })

  test("force-keeps error lines from the elided middle", () => {
    const lines = Array.from({ length: 300 }, (_, i) =>
      i === 150 ? "Error: boom at the center" : `line ${i}`,
    )
    const result = compactText(lines.join("\n"), 40)
    expect(result.text).toContain("Error: boom at the center")
  })

  test("short text is unchanged", () => {
    const text = "a\nb\nc"
    expect(compactText(text, 40)).toEqual({ text, lossy: false })
  })

  test("is deterministic", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")
    expect(compactText(text, 40)).toEqual(compactText(text, 40))
  })
})
