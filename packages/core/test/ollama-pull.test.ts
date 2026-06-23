import { describe, expect, test } from "bun:test"
import { parsePullProgress, RECOMMENDED_LOCAL_MODELS, recommendLocalModel } from "../src/provider/ollama-pull"

describe("recommendLocalModel", () => {
  test("returns a vetted model that exists in the recommended list", () => {
    const rec = recommendLocalModel()
    expect(RECOMMENDED_LOCAL_MODELS.some((m) => m.model === rec.model)).toBe(true)
  })

  test("recommended list is ordered smallest → largest", () => {
    const sizes = RECOMMENDED_LOCAL_MODELS.map((m) => m.sizeBytes)
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes)
  })
})

describe("parsePullProgress", () => {
  test("computes percent from total/completed", () => {
    expect(parsePullProgress('{"status":"pulling","total":100,"completed":25}')).toEqual({
      status: "pulling",
      percent: 25,
    })
  })

  test("omits percent when totals are absent", () => {
    expect(parsePullProgress('{"status":"verifying sha256"}')).toEqual({
      status: "verifying sha256",
      percent: undefined,
    })
  })

  test("ignores blank and unparseable lines", () => {
    expect(parsePullProgress("")).toBeUndefined()
    expect(parsePullProgress("   ")).toBeUndefined()
    expect(parsePullProgress("not json")).toBeUndefined()
  })

  test("throws on a server-reported error", () => {
    expect(() => parsePullProgress('{"error":"model not found"}')).toThrow(/model not found/)
  })
})
