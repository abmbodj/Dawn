import { describe, expect, test } from "bun:test"
import { type ToolSet, tool } from "ai"
import { z } from "zod"
import { visibleTools } from "../src/tools/index"

function fakeToolSet(...names: string[]): ToolSet {
  const ts: ToolSet = {}
  for (const name of names) {
    ts[name] = tool({
      description: name,
      inputSchema: z.object({}),
      execute: async () => "ok",
    })
  }
  return ts
}

describe("visibleTools", () => {
  test("normal mode exposes all tools", () => {
    const all = fakeToolSet("read", "write", "bash", "edit", "grep")
    const visible = visibleTools(all, "normal", {})
    expect(Object.keys(visible).sort()).toEqual(["bash", "edit", "grep", "read", "write"])
  })

  test("plan mode removes side-effecting tools", () => {
    const all = fakeToolSet("read", "write", "bash", "bash_background", "bash_kill", "edit", "git_commit", "grep", "glob")
    const visible = visibleTools(all, "plan", {})
    const names = Object.keys(visible).sort()
    expect(names).not.toContain("write")
    expect(names).not.toContain("bash")
    expect(names).not.toContain("bash_background")
    expect(names).not.toContain("bash_kill")
    expect(names).not.toContain("edit")
    expect(names).not.toContain("git_commit")
    expect(names).toContain("read")
    expect(names).toContain("grep")
    expect(names).toContain("glob")
  })

  test("deny rule removes a tool in normal mode", () => {
    const all = fakeToolSet("read", "bash", "write")
    const visible = visibleTools(all, "normal", { bash: "deny" })
    expect(Object.keys(visible)).not.toContain("bash")
    expect(Object.keys(visible)).toContain("read")
    expect(Object.keys(visible)).toContain("write")
  })

  test("allow and ask rules do not remove tools", () => {
    const all = fakeToolSet("bash", "write", "read")
    const visible = visibleTools(all, "normal", { bash: "allow", write: "ask" })
    expect(Object.keys(visible).sort()).toEqual(["bash", "read", "write"])
  })

  test("plan mode + deny rules both apply independently", () => {
    const all = fakeToolSet("read", "grep", "bash", "write")
    const visible = visibleTools(all, "plan", { grep: "deny" })
    const names = Object.keys(visible)
    expect(names).toContain("read")
    expect(names).not.toContain("grep")   // denied by config
    expect(names).not.toContain("bash")   // blocked by plan mode
    expect(names).not.toContain("write")  // blocked by plan mode
  })

  test("acceptEdits mode does not restrict side-effecting tools", () => {
    const all = fakeToolSet("read", "write", "bash")
    const visible = visibleTools(all, "acceptEdits", {})
    expect(Object.keys(visible).sort()).toEqual(["bash", "read", "write"])
  })

  test("undefined permissions is safe", () => {
    const all = fakeToolSet("read", "bash")
    const visible = visibleTools(all, "normal", undefined)
    expect(Object.keys(visible).sort()).toEqual(["bash", "read"])
  })
})
