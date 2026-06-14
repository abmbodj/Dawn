import { describe, expect, test } from "bun:test"
import { toolResultSummary } from "../src/tools/index"

describe("toolResultSummary", () => {
  test("read — counts numbered lines", () => {
    const out = "    1→import os\n    2→import path\n    3→"
    expect(toolResultSummary("read", {}, out)).toBe("Read 3 lines")
  })

  test("read — singular line", () => {
    const out = "    1→const x = 1"
    expect(toolResultSummary("read", {}, out)).toBe("Read 1 line")
  })

  test("read — no numbered lines falls back", () => {
    expect(toolResultSummary("read", {}, "some raw text")).toBe("Read")
  })

  test("grep — counts match lines", () => {
    const out = "src/foo.ts:1: match\nsrc/bar.ts:5: match"
    expect(toolResultSummary("grep", {}, out)).toBe("2 matches")
  })

  test("grep — no matches", () => {
    expect(toolResultSummary("grep", {}, "No matches found")).toBe("no matches")
  })

  test("grep — singular match", () => {
    expect(toolResultSummary("grep", {}, "src/foo.ts:1: match")).toBe("1 match")
  })

  test("glob — counts files", () => {
    const out = "src/a.ts\nsrc/b.ts\nsrc/c.ts"
    expect(toolResultSummary("glob", {}, out)).toBe("3 files")
  })

  test("glob — no files", () => {
    expect(toolResultSummary("glob", {}, "No files match")).toBe("no files")
  })

  test("ls — counts entries", () => {
    const out = "file.ts\ndir/"
    expect(toolResultSummary("ls", {}, out)).toBe("2 entries")
  })

  test("ls — empty directory", () => {
    expect(toolResultSummary("ls", {}, "(empty directory)")).toBe("empty")
  })

  test("edit — shows +/- line counts", () => {
    const input = { oldString: "line1\nline2", newString: "line1\nline2\nline3" }
    expect(toolResultSummary("edit", input, "Edited foo.ts")).toBe("+3 −2")
  })

  test("write — shows line count", () => {
    const input = { content: "line1\nline2\nline3" }
    expect(toolResultSummary("write", input, "Wrote 3 lines")).toBe("Wrote 3 lines")
  })

  test("bash — ok for single-line output", () => {
    expect(toolResultSummary("bash", {}, "hello world")).toBe("ok")
  })

  test("bash — ok with line count for multi-line output", () => {
    expect(toolResultSummary("bash", {}, "line1\nline2\nline3")).toBe("ok · 3 lines")
  })

  test("bash — shows exit code on failure", () => {
    expect(toolResultSummary("bash", {}, "something failed\n[exit code 1]")).toBe("exit 1")
  })

  test("repo_overview — snapshot", () => {
    expect(toolResultSummary("repo_overview", {}, "...")).toBe("snapshot")
  })

  test("todo_write — counts tasks and done", () => {
    const input = {
      todos: [
        { content: "A", status: "completed", activeForm: "Doing A" },
        { content: "B", status: "in_progress", activeForm: "Doing B" },
        { content: "C", status: "pending", activeForm: "Doing C" },
      ],
    }
    expect(toolResultSummary("todo_write", input, "Tracking 3 tasks")).toBe("3 tasks · 1 done")
  })

  test("web_fetch — shows line count for non-URL output", () => {
    const result = toolResultSummary("web_fetch", {}, "line one\nline two")
    expect(result).toBe("2 lines")
  })

  test("web_search — counts results", () => {
    const out = "Title 1\nhttp://example.com\nSnippet\n\nTitle 2\nhttp://example2.com\nSnippet"
    expect(toolResultSummary("web_search", {}, out)).toBe("2 results")
  })

  test("web_search — not configured", () => {
    expect(
      toolResultSummary("web_search", {}, "Search not configured — use web_fetch with a known URL."),
    ).toBe("not configured")
  })

  test("unknown tool — returns first line of output", () => {
    expect(toolResultSummary("unknown_tool", {}, "first line\nsecond line")).toBe("first line")
  })

  test("unknown tool — truncates long first line", () => {
    expect(toolResultSummary("unknown_tool", {}, "a".repeat(100))).toMatch(/…$/)
  })
})
