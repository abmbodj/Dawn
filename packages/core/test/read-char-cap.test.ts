import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/bus/bus"
import { maxReadChars, maxReadLines } from "../src/context/budget"
import { PermissionGate } from "../src/permission/permission"
import { createTools } from "../src/tools/index"

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-readcap-"))
  const tools = createTools({ cwd: tmp, gate: new PermissionGate(), bus: new Bus() })
  return { tmp, tools }
}

const run = (tool: any, input: unknown) => tool.execute(input, {})

describe("read total char cap", () => {
  test("minified-style long lines are capped by total chars, not just line count", async () => {
    const { tmp, tools } = setup()
    // 240 lines × ~1,900 chars would be ~456k chars under the line cap alone.
    const lines = Array.from({ length: maxReadLines("balanced") }, (_, i) => `line${i} ${"x".repeat(1900)}`)
    fs.writeFileSync(path.join(tmp, "big.min.js"), lines.join("\n"))

    const out = String(await run(tools.read, { filePath: "big.min.js" }))
    expect(out.length).toBeLessThanOrEqual(maxReadChars("balanced") + 2500) // numbering + marker slack
    expect(out).toContain("continue with offset=") // partial-view contract intact
    const match = out.match(/continue with offset=(\d+)/)
    expect(Number(match?.[1])).toBeGreaterThan(1) // resumes past what was returned
  })

  test("normal files are unaffected", async () => {
    const { tmp, tools } = setup()
    const lines = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i}`)
    fs.writeFileSync(path.join(tmp, "normal.ts"), lines.join("\n"))

    const out = String(await run(tools.read, { filePath: "normal.ts" }))
    expect(out).toContain("const x99 = 99")
    expect(out).not.toContain("continue with offset=")
  })
})
