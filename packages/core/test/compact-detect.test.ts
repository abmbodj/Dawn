import { describe, expect, test } from "bun:test"
import { detectKind } from "../src/context/compact"

describe("detectKind", () => {
  test("tool hints win", () => {
    expect(detectKind("anything at all", "grep")).toBe("search")
    expect(detectKind("a\nb\nc", "ls")).toBe("text")
    expect(detectKind("a\nb\nc", "glob")).toBe("text")
  })

  test("valid JSON objects and arrays are json", () => {
    expect(detectKind('{"a":1,"b":[1,2,3]}')).toBe("json")
    expect(detectKind("[1, 2, 3]")).toBe("json")
  })

  test("a leading brace that is not valid JSON falls through to text", () => {
    expect(detectKind("{ this is not json, just prose with a brace")).toBe("text")
  })

  test("grep-shaped path:line: lines are search", () => {
    const text = Array.from({ length: 6 }, (_, i) => `src/file${i}.ts:${i + 1}:const value = ${i}`).join("\n")
    expect(detectKind(text)).toBe("search")
  })

  test("timestamped lines are logs, not search (HH:MM:SS is not a path:line match)", () => {
    const text = Array.from(
      { length: 6 },
      (_, i) => `2024-01-01T10:0${i}:00Z INFO handled request ${i}`,
    ).join("\n")
    expect(detectKind(text)).toBe("log")
  })

  test("level-prefixed lines are logs", () => {
    const text = [
      "INFO boot",
      "DEBUG connect",
      "WARN retrying",
      "ERROR failed",
      "INFO done",
      "INFO idle",
    ].join("\n")
    expect(detectKind(text)).toBe("log")
  })

  test("plain prose is text", () => {
    expect(detectKind("just some\nplain text\nlines here\nwith nothing\nspecial about them")).toBe("text")
  })
})
