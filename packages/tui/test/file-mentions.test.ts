import { describe, expect, test } from "bun:test"
import {
  applyMention,
  extractMentionQuery,
  filterFileMentions,
  mentionCaretOffset,
} from "../src/fileMentions"

describe("extractMentionQuery", () => {
  test("returns null when no @ present", () => {
    expect(extractMentionQuery("hello world", 11)).toBeNull()
  })

  test("returns empty string for bare @", () => {
    expect(extractMentionQuery("fix @", 5)).toBe("")
  })

  test("returns query after @", () => {
    expect(extractMentionQuery("fix @system", 11)).toBe("system")
  })

  test("returns null when space follows @", () => {
    expect(extractMentionQuery("fix @ something", 15)).toBeNull()
  })

  test("returns partial query when caret is mid-token", () => {
    expect(extractMentionQuery("fix @sys", 8)).toBe("sys")
  })

  test("returns null when caret is before the @", () => {
    expect(extractMentionQuery("@foo", 0)).toBeNull()
  })
})

describe("filterFileMentions", () => {
  const files = [
    "packages/core/src/agent/system.ts",
    "packages/core/src/agent/agent.ts",
    "packages/tui/src/app.tsx",
    "README.md",
    "index.ts",
  ]

  test("returns first 20 files for empty query", () => {
    const result = filterFileMentions(files, "")
    expect(result).toHaveLength(files.length)
  })

  test("matches by filename substring", () => {
    const result = filterFileMentions(files, "system")
    expect(result[0]).toBe("packages/core/src/agent/system.ts")
  })

  test("matches by path substring", () => {
    const result = filterFileMentions(files, "agent/agent")
    expect(result[0]).toBe("packages/core/src/agent/agent.ts")
  })

  test("subsequence match on filename", () => {
    const result = filterFileMentions(files, "sys")
    expect(result).toContain("packages/core/src/agent/system.ts")
  })

  test("returns empty array when nothing matches", () => {
    const result = filterFileMentions(files, "zzznomatch")
    expect(result).toHaveLength(0)
  })

  test("ranks exact filename match higher than path match", () => {
    const result = filterFileMentions(files, "app")
    // app.tsx should rank first (filename contains 'app')
    expect(result[0]).toBe("packages/tui/src/app.tsx")
  })
})

describe("applyMention", () => {
  test("replaces @query with the file path", () => {
    expect(applyMention("fix @sys", 8, "packages/core/src/agent/system.ts")).toBe(
      "fix packages/core/src/agent/system.ts",
    )
  })

  test("preserves text after caret", () => {
    expect(applyMention("fix @sys please", 8, "system.ts")).toBe("fix system.ts please")
  })

  test("returns unchanged text when no @ found", () => {
    expect(applyMention("no mention here", 15, "file.ts")).toBe("no mention here")
  })
})

describe("mentionCaretOffset", () => {
  test("returns offset after the inserted path", () => {
    const text = "fix @sys"
    const offset = mentionCaretOffset(text, 8, "system.ts")
    expect(offset).toBe("fix ".length + "system.ts".length)
  })
})
