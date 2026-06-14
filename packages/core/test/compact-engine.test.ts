import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { compactBudget } from "../src/context/budget"
import { compactToolOutput } from "../src/context/compact"
import { ContextStore } from "../src/context/store"

const budget = compactBudget("balanced")
const bigLog = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n")

function tmpStore(): ContextStore {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-compact-"))
  return new ContextStore(path.join(tmp, "c.db"))
}

describe("compactToolOutput", () => {
  test("leaves small outputs untouched (below threshold)", () => {
    const out = compactToolOutput("tiny output", { tool: "bash", budget })
    expect(out.compacted).toBe(false)
    expect(out.text).toBe("tiny output")
  })

  test("compacts a large output and appends an expand sentinel when a store is present", () => {
    const store = tmpStore()
    const out = compactToolOutput(bigLog, { tool: "bash", budget, store, sessionId: "s1" })
    expect(out.compacted).toBe(true)
    expect(out.afterTokens).toBeLessThan(out.beforeTokens)
    expect(out.text).toMatch(/«expand:[0-9a-f]{10} — .*call expand\(/)

    const hash = out.text.match(/«expand:([0-9a-f]{10})/)?.[1] ?? ""
    expect(store.getBlob(hash)?.content).toBe(bigLog)
    store.close()
  })

  test("uses a store-free sentinel (no expand hash) when no store is given", () => {
    const out = compactToolOutput(bigLog, { tool: "bash", budget })
    expect(out.compacted).toBe(true)
    expect(out.text).toContain("elided»")
    expect(out.text).not.toContain("expand:")
  })

  test("returned text is deterministic", () => {
    const a = compactToolOutput(bigLog, { tool: "bash", budget })
    const b = compactToolOutput(bigLog, { tool: "bash", budget })
    expect(a.text).toBe(b.text)
  })

  test("inflation guard: an incompressible large output is returned unchanged", () => {
    const raw = "x".repeat(8000) // over the token threshold, but a single line — nothing to drop
    const out = compactToolOutput(raw, { tool: "bash", budget })
    expect(out.compacted).toBe(false)
    expect(out.text).toBe(raw)
  })
})
