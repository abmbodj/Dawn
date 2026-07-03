import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/bus/bus"
import { PermissionGate } from "../src/permission/permission"
import { createTools } from "../src/tools/index"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-multiedit-"))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function makeTools() {
  const gate = new PermissionGate()
  gate.allowAll = true
  return createTools({ cwd: dir, gate, bus: new Bus(), readRegistry: new Map() })
}

async function exec(tools: ReturnType<typeof makeTools>, name: string, input: unknown): Promise<string> {
  const t = tools[name] as { execute: (input: unknown, opts: unknown) => Promise<string> }
  return t.execute(input, {})
}

describe("multi_edit", () => {
  test("applies several hunks atomically after a read", async () => {
    const file = path.join(dir, "sample.ts")
    fs.writeFileSync(file, "const a = 1\nconst b = 2\nconst c = 3\n")
    const tools = makeTools()
    await exec(tools, "read", { filePath: "sample.ts" })
    const out = await exec(tools, "multi_edit", {
      filePath: "sample.ts",
      edits: [
        { oldString: "const a = 1", newString: "const a = 10" },
        { oldString: "const c = 3", newString: "const c = 30" },
      ],
    })
    expect(out).toContain("Applied 2 edits")
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 10\nconst b = 2\nconst c = 30\n")
  })

  test("writes nothing when a later hunk fails", async () => {
    const file = path.join(dir, "atomic.ts")
    fs.writeFileSync(file, "let x = 1\n")
    const tools = makeTools()
    await exec(tools, "read", { filePath: "atomic.ts" })
    await expect(
      exec(tools, "multi_edit", {
        filePath: "atomic.ts",
        edits: [
          { oldString: "let x = 1", newString: "let x = 2" },
          { oldString: "does not exist", newString: "nope" },
        ],
      }),
    ).rejects.toThrow("hunk 2/2")
    expect(fs.readFileSync(file, "utf8")).toBe("let x = 1\n")
  })

  test("enforces read-before-edit", async () => {
    const file = path.join(dir, "unread.ts")
    fs.writeFileSync(file, "const y = 1\n")
    const tools = makeTools()
    await expect(
      exec(tools, "multi_edit", {
        filePath: "unread.ts",
        edits: [{ oldString: "const y = 1", newString: "const y = 2" }],
      }),
    ).rejects.toThrow("haven't read")
  })

  test("later hunks see earlier hunks' output", async () => {
    const file = path.join(dir, "chain.ts")
    fs.writeFileSync(file, "alpha\n")
    const tools = makeTools()
    await exec(tools, "read", { filePath: "chain.ts" })
    await exec(tools, "multi_edit", {
      filePath: "chain.ts",
      edits: [
        { oldString: "alpha", newString: "beta" },
        { oldString: "beta", newString: "gamma" },
      ],
    })
    expect(fs.readFileSync(file, "utf8")).toBe("gamma\n")
  })
})
