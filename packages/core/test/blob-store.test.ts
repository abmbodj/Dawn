import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ContextStore } from "../src/context/store"

function tmpStore(): ContextStore {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-blob-"))
  return new ContextStore(path.join(tmp, "b.db"))
}

describe("compacted blob store", () => {
  test("round-trips a blob by hash", () => {
    const store = tmpStore()
    store.putBlob({
      hash: "abc123",
      tool: "bash",
      content: "hello world",
      sourceTokens: 3,
      createdAt: Date.now(),
    })
    expect(store.getBlob("abc123")?.content).toBe("hello world")
    expect(store.getBlob("missing")).toBeUndefined()
    store.close()
  })

  test("putBlob is idempotent on hash (last write wins)", () => {
    const store = tmpStore()
    store.putBlob({ hash: "h", tool: "bash", content: "v1", sourceTokens: 1, createdAt: 1 })
    store.putBlob({ hash: "h", tool: "bash", content: "v2", sourceTokens: 1, createdAt: 2 })
    expect(store.getBlob("h")?.content).toBe("v2")
    store.close()
  })

  test("pruneBlobs keeps only the most recent up to the cap", () => {
    const store = tmpStore()
    for (let i = 0; i < 10; i++) {
      store.putBlob({ hash: `h${i}`, tool: "bash", content: `c${i}`, sourceTokens: 1, createdAt: i })
    }
    store.pruneBlobs(3)
    expect(store.getBlob("h9")).toBeDefined()
    expect(store.getBlob("h8")).toBeDefined()
    expect(store.getBlob("h7")).toBeDefined()
    expect(store.getBlob("h6")).toBeUndefined()
    expect(store.getBlob("h0")).toBeUndefined()
    store.close()
  })
})
