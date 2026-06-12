import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildRequestMessages } from "../src/context/budget"
import { buildRepoIndex } from "../src/context/indexer"
import { ContextStore } from "../src/context/store"
import { getFileSummary } from "../src/context/summarize"
import { ContextWorkingSet } from "../src/context/working-set"

describe("repo index", () => {
  let tmp: string
  let repo: string
  let store: ContextStore

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-context-"))
    repo = path.join(tmp, "repo")
    fs.mkdirSync(repo)
    store = new ContextStore(path.join(tmp, "test.db"))
  })

  afterEach(() => {
    store.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("ignores node_modules and .git", async () => {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true })
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true })
    fs.mkdirSync(path.join(repo, ".git", "objects"), { recursive: true })
    fs.writeFileSync(path.join(repo, "src", "main.ts"), "export function main() { return 1 }\n")
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.ts"), "export const ignored = true\n")
    fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n")

    const result = await buildRepoIndex(repo, store)

    expect(result.indexed).toBe(1)
    expect(store.indexStatus(repo).indexedFiles).toBe(1)
    expect(store.getIndexEntry(repo, path.join("src", "main.ts"))?.symbols).toContain("main")
    expect(store.getIndexEntry(repo, path.join("node_modules", "pkg", "index.ts"))).toBeUndefined()
  })

  test("file hash invalidates summary", () => {
    fs.writeFileSync(path.join(tmp, "auth.ts"), "export function login() { return true }\n")
    const first = getFileSummary({ cwd: tmp, path: "auth.ts", store })

    fs.writeFileSync(path.join(tmp, "auth.ts"), "export function login() { return false }\n")
    const second = getFileSummary({ cwd: tmp, path: "auth.ts", store })

    expect(second.hash).not.toBe(first.hash)
    expect(second.summary).toContain("login")
  })
})

describe("context budget", () => {
  test("trims expired working-set context before current context", () => {
    const built = buildRequestMessages({
      system: "system",
      messages: [{ role: "user", content: "latest request" }],
      summaries: [],
      budget: { mode: "balanced", budget: 40 },
      workingSet: [
        {
          kind: "file-range",
          path: "old.ts",
          startLine: 1,
          endLine: 80,
          content: "x".repeat(300),
          reason: "old",
          ttl: 0,
          estimatedTokens: 75,
          createdAt: 1,
        },
        {
          kind: "file-range",
          path: "current.ts",
          startLine: 1,
          endLine: 5,
          content: "const current = true",
          reason: "current",
          ttl: 2,
          estimatedTokens: 5,
          createdAt: 2,
        },
      ],
    })

    expect(built.plan.trimmedItems).toContain("old.ts lines 1-80")
    expect(JSON.stringify(built.messages)).toContain("current.ts")
    expect(JSON.stringify(built.messages)).toContain("latest request")
  })

  test("keeps system prompt first and latest user request intact", () => {
    const built = buildRequestMessages({
      system: "stable system",
      messages: [
        { role: "user", content: `old ${"x".repeat(1000)}` },
        { role: "assistant", content: `old answer ${"y".repeat(1000)}` },
        { role: "user", content: "fix login bug" },
      ],
      summaries: [],
      workingSet: [],
      budget: { mode: "minimal", budget: 80 },
    })

    expect(built.messages[0]?.role).toBe("system")
    expect(built.messages[0]?.content).toBe("stable system")
    expect(JSON.stringify(built.messages.at(-1))).toContain("fix login bug")
  })
})

describe("ContextWorkingSet", () => {
  test("evicts expired raw ranges after ttl decrement", () => {
    const workingSet = new ContextWorkingSet()
    workingSet.add({
      kind: "file-range",
      path: "src/auth.ts",
      startLine: 40,
      endLine: 120,
      content: "code",
      reason: "login validation bug",
      ttl: 1,
    })

    workingSet.decrementLeases()

    expect(workingSet.all()).toEqual([])
  })
})
