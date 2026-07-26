import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/bus/bus"
import { ContextStore } from "../src/context/store"
import { PermissionGate } from "../src/permission/permission"
import { createTools } from "../src/tools/index"

/** ~1,250 tokens — well over the balanced compaction threshold of 800. */
const LINES = 400
const BODY = Array.from({ length: LINES }, (_, i) => `line ${i} of file content here`).join("\n")

function setup(headroomTokens?: () => number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-headroom-"))
  const store = new ContextStore(path.join(tmp, "c.db"))
  const gate = new PermissionGate()
  gate.allowAll = true
  fs.writeFileSync(path.join(tmp, "big.txt"), BODY)
  const tools = createTools({
    cwd: tmp,
    gate,
    bus: new Bus(),
    contextStore: store,
    contextMode: "balanced",
    headroomTokens,
  })
  return { tmp, store, tools }
}

const cat = (tools: any) => tools.bash.execute({ command: "cat big.txt" }, {})

describe("compaction stands down when the budget can afford the output", () => {
  test("compacts when there is no headroom to speak of", async () => {
    const { store, tools } = setup(() => 0)
    const out = String(await cat(tools))

    expect(out.split("\n").length).toBeLessThan(LINES)
    expect(out).toContain("«expand:")
    store.close()
  })

  test("keeps the output whole when it comfortably fits", async () => {
    const { store, tools } = setup(() => 14_000)
    const out = String(await cat(tools))

    // Whole file, no elision marker, nothing for the model to go re-fetch.
    expect(out).toContain(`line ${LINES - 1} of file content here`)
    expect(out).not.toContain("«expand:")
    store.close()
  })

  test("still compacts when the output would eat most of the headroom", async () => {
    // Output ~1,250 tokens; headroom 1,500 → 1,250 > 1,500 × 0.6, so compaction stays on.
    const { store, tools } = setup(() => 1_500)
    expect(String(await cat(tools))).toContain("«expand:")
    store.close()
  })

  test("no headroom callback keeps the previous always-compact behaviour", async () => {
    const { store, tools } = setup(undefined)
    expect(String(await cat(tools))).toContain("«expand:")
    store.close()
  })
})
