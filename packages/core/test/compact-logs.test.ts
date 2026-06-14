import { describe, expect, test } from "bun:test"
import { compactLogs } from "../src/context/compact"

describe("compactLogs", () => {
  test("collapses runs of identical lines into (×N)", () => {
    const lines = ["start", ...Array(50).fill("retrying connection"), "done"]
    const result = compactLogs(lines.join("\n"), 80)
    expect(result.lossy).toBe(true)
    expect(result.text).toContain("retrying connection  (×50)")
    expect(result.text).toContain("start")
    expect(result.text).toContain("done")
    expect(result.dropped).toMatch(/duplicate/)
  })

  test("collapses near-identical lines differing only in numbers", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `processed batch ${i}`)
    const result = compactLogs(lines.join("\n"), 80)
    expect(result.lossy).toBe(true)
    expect(result.text).toMatch(/\(×40\)/)
  })

  test("leaves short, non-repetitive logs untouched", () => {
    const text = "line a\nline b\nline c"
    expect(compactLogs(text, 80)).toEqual({ text, lossy: false })
  })

  test("is deterministic", () => {
    const text = ["start", ...Array(50).fill("retrying connection"), "done"].join("\n")
    expect(compactLogs(text, 80)).toEqual(compactLogs(text, 80))
  })
})
