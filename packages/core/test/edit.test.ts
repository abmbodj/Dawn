import { describe, expect, test } from "bun:test"
import { applyEdit } from "../src/tools/edit"

describe("applyEdit", () => {
  test("replaces a unique match", () => {
    expect(applyEdit("const a = 1\nconst b = 2", "const b = 2", "const b = 3")).toBe(
      "const a = 1\nconst b = 3",
    )
  })

  test("throws when oldString is missing", () => {
    expect(() => applyEdit("hello", "nope", "x")).toThrow("not found")
  })

  test("throws on ambiguous match without replaceAll", () => {
    expect(() => applyEdit("a\na\n", "a", "b")).toThrow("matches 2 times")
  })

  test("replaceAll replaces every occurrence", () => {
    expect(applyEdit("a-a-a", "a", "b", true)).toBe("b-b-b")
  })

  test("rejects identical old and new strings", () => {
    expect(() => applyEdit("abc", "abc", "abc")).toThrow("identical")
  })

  test("rejects empty oldString", () => {
    expect(() => applyEdit("abc", "", "x")).toThrow("empty")
  })
})
