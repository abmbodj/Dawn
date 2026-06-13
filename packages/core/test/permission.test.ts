import { describe, expect, test } from "bun:test"
import { Asker } from "../src/permission/asker"
import { PermissionGate } from "../src/permission/permission"

const req = { tool: "write", title: "Create file.ts" }
const bashReq = { tool: "bash", title: "rm -rf ." }

describe("PermissionGate modes", () => {
  test("normal mode routes to handler", async () => {
    const gate = new PermissionGate()
    gate.setMode("normal")
    gate.setHandler(async () => "allow")
    expect(await gate.ask(req)).toBe(true)
  })

  test("plan mode blocks all gated tools regardless of handler", async () => {
    const gate = new PermissionGate()
    gate.setMode("plan")
    gate.setHandler(async () => "allow")
    expect(await gate.ask(req)).toBe(false)
    expect(await gate.ask(bashReq)).toBe(false)
  })

  test("plan mode blocks even when allowAll is set", async () => {
    const gate = new PermissionGate()
    gate.setMode("plan")
    gate.allowAll = true
    expect(await gate.ask(req)).toBe(false)
  })

  test("acceptEdits auto-approves write and edit without a handler", async () => {
    const gate = new PermissionGate()
    gate.setMode("acceptEdits")
    expect(await gate.ask({ tool: "write", title: "Create file.ts" })).toBe(true)
    expect(await gate.ask({ tool: "edit", title: "Edit file.ts" })).toBe(true)
  })

  test("acceptEdits still routes bash to the handler", async () => {
    const gate = new PermissionGate()
    gate.setMode("acceptEdits")
    gate.setHandler(async () => "deny")
    expect(await gate.ask(bashReq)).toBe(false)
  })

  test("acceptEdits bash is allowed when handler approves", async () => {
    const gate = new PermissionGate()
    gate.setMode("acceptEdits")
    gate.setHandler(async () => "allow")
    expect(await gate.ask(bashReq)).toBe(true)
  })

  test("normal mode with no handler denies", async () => {
    const gate = new PermissionGate()
    expect(await gate.ask(req)).toBe(false)
  })

  test("always decision pre-allows the tool for subsequent calls", async () => {
    const gate = new PermissionGate()
    let calls = 0
    gate.setHandler(async () => {
      calls++
      return "always"
    })
    await gate.ask(req)
    await gate.ask(req)
    expect(calls).toBe(1)
    expect(await gate.ask(req)).toBe(true)
  })
})

describe("Asker", () => {
  test("returns -1 when no handler is registered", async () => {
    const asker = new Asker()
    const result = await asker.ask({ kind: "ask", question: "Pick one", options: [{ label: "A" }] })
    expect(result).toBe(-1)
  })

  test("returns the handler's chosen index", async () => {
    const asker = new Asker()
    asker.setHandler(async () => 2)
    const result = await asker.ask({
      kind: "ask",
      question: "Pick one",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
    })
    expect(result).toBe(2)
  })

  test("clearing the handler reverts to -1", async () => {
    const asker = new Asker()
    asker.setHandler(async () => 0)
    asker.setHandler(undefined)
    expect(await asker.ask({ kind: "ask", question: "Pick", options: [{ label: "A" }] })).toBe(-1)
  })
})
