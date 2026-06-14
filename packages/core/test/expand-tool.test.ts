import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/bus/bus"
import { ContextStore } from "../src/context/store"
import { PermissionGate } from "../src/permission/permission"
import { createTools } from "../src/tools/index"

function setup(extra: Record<string, unknown> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-expand-"))
  const store = new ContextStore(path.join(tmp, "e.db"))
  const tools = createTools({
    cwd: tmp,
    gate: new PermissionGate(),
    bus: new Bus(),
    contextStore: store,
    ...extra,
  })
  return { tmp, store, tools }
}

const run = (tool: any, input: unknown) => tool.execute(input, {})

describe("expand tool", () => {
  test("retrieves the full stored output by hash", async () => {
    const { store, tools } = setup()
    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
    store.putBlob({ hash: "deadbeef01", tool: "bash", content, sourceTokens: 50, createdAt: Date.now() })

    const out = String(await run(tools.expand, { hash: "deadbeef01" }))
    expect(out).toContain("line 0")
    expect(out).toContain("line 19")
    store.close()
  })

  test("filters by regex pattern", async () => {
    const { store, tools } = setup()
    store.putBlob({
      hash: "h1",
      tool: "bash",
      content: "apple\nbanana\nApricot\ncherry",
      sourceTokens: 5,
      createdAt: Date.now(),
    })
    const out = String(await run(tools.expand, { hash: "h1", pattern: "^a" }))
    expect(out).toBe("apple")
    store.close()
  })

  test("slices by offset and limit", async () => {
    const { store, tools } = setup()
    const content = Array.from({ length: 10 }, (_, i) => `row${i}`).join("\n")
    store.putBlob({ hash: "h2", tool: "bash", content, sourceTokens: 5, createdAt: Date.now() })
    const out = String(await run(tools.expand, { hash: "h2", offset: 3, limit: 2 }))
    expect(out).toContain("row2")
    expect(out).toContain("row3")
    expect(out).not.toContain("row5")
    expect(out).toMatch(/continue with offset=5/)
    store.close()
  })

  test("reports a clear message when the hash is unknown", async () => {
    const { tools, store } = setup()
    const out = String(await run(tools.expand, { hash: "nope" }))
    expect(out).toMatch(/No stored output/)
    store.close()
  })
})

describe("compaction wrapper", () => {
  test("heavy tool outputs are compacted through createTools and stashed for expand", async () => {
    let saved = 0
    const { tmp, store, tools } = setup({ onCompaction: (b: number, a: number) => (saved += b - a) })
    for (let i = 0; i < 600; i++) {
      fs.writeFileSync(path.join(tmp, `a-fairly-long-filename-number-${i}.txt`), "x")
    }

    const out = String(await run(tools.ls, {}))
    expect(out).toMatch(/«expand:[0-9a-f]{10}/)
    expect(saved).toBeGreaterThan(0)

    const hash = out.match(/«expand:([0-9a-f]{10})/)?.[1] ?? ""
    expect(store.getBlob(hash)).toBeDefined()
    store.close()
  })
})
