import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/bus/bus"
import { PermissionGate } from "../src/permission/permission"
import { createTools } from "../src/tools/index"

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-syntax-"))
  const readRegistry = new Map<string, string>()
  const gate = new PermissionGate()
  gate.allowAll = true
  const tools = createTools({ cwd: tmp, gate, bus: new Bus(), readRegistry })
  return { tmp, tools }
}

const run = (tool: any, input: unknown) => tool.execute(input, {})

describe("post-edit syntax validation", () => {
  test("an edit that breaks the parse is reported in the same tool result", async () => {
    const { tmp, tools } = setup()
    const file = path.join(tmp, "mod.ts")
    fs.writeFileSync(file, "export function add(a: number, b: number) {\n  return a + b\n}\n")
    await run(tools.read, { filePath: "mod.ts" })

    // Drop the closing brace — the classic truncated edit.
    const out = String(
      await run(tools.edit, {
        filePath: "mod.ts",
        oldString: "  return a + b\n}",
        newString: "  return a + b",
      }),
    )

    expect(out).toContain("Edited")
    expect(out).toContain("no longer parses")
  })

  test("a valid edit says nothing extra", async () => {
    const { tmp, tools } = setup()
    const file = path.join(tmp, "mod.ts")
    fs.writeFileSync(file, "export function add(a: number, b: number) {\n  return a + b\n}\n")
    await run(tools.read, { filePath: "mod.ts" })

    const out = String(await run(tools.edit, { filePath: "mod.ts", oldString: "a + b", newString: "a - b" }))
    expect(out).toContain("Edited")
    expect(out).not.toContain("no longer parses")
  })

  test("write catches broken JSON", async () => {
    const { tools } = setup()
    const out = String(await run(tools.write, { filePath: "pkg.json", content: '{ "a": 1,, }' }))
    expect(out).toContain("no longer parses")
  })

  test("non-code files are not parse-checked", async () => {
    const { tools } = setup()
    const out = String(await run(tools.write, { filePath: "notes.md", content: "# hi { unbalanced" }))
    expect(out).not.toContain("no longer parses")
  })

  test("the warning does not block the write — the change is still on disk", async () => {
    const { tmp, tools } = setup()
    await run(tools.write, { filePath: "broken.ts", content: "export const x = (" })
    expect(fs.readFileSync(path.join(tmp, "broken.ts"), "utf8")).toBe("export const x = (")
  })
})
