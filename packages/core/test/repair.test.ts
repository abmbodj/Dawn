import { describe, expect, test } from "bun:test"
import { repairToolInput } from "../src/agent/repair"

describe("repairToolInput", () => {
  test("strips json code fences", () => {
    const raw = '```json\n{"path": "foo.ts"}\n```'
    const result = repairToolInput(raw)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ path: "foo.ts" })
  })

  test("strips plain code fences", () => {
    const raw = '```\n{"path": "bar.ts"}\n```'
    const result = repairToolInput(raw)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ path: "bar.ts" })
  })

  test("trims prose before and after braces", () => {
    const raw = 'Sure, I will call the tool with these args:\n{"filePath": "x.ts"}\nThat should work.'
    const result = repairToolInput(raw)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ filePath: "x.ts" })
  })

  test("unwraps double-encoded JSON", () => {
    const inner = '{"pattern": "*.ts"}'
    const doubleEncoded = JSON.stringify(inner)
    const result = repairToolInput(doubleEncoded)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ pattern: "*.ts" })
  })

  test("returns null for unrecoverable garbage", () => {
    expect(repairToolInput("not json at all")).toBeNull()
    expect(repairToolInput("")).toBeNull()
    expect(repairToolInput("{ broken: json")).toBeNull()
  })

  test("returns valid JSON unchanged", () => {
    const valid = '{"a": 1, "b": true}'
    const result = repairToolInput(valid)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ a: 1, b: true })
  })
})
