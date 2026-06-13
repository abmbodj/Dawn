import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bus } from "../src/bus/bus"
import { ContextStore } from "../src/context/store"
import { PermissionGate } from "../src/permission/permission"

const actualAi = await import("ai")
const streamTextMock = mock((() => {
  throw new Error("streamText mock not configured")
}) as (...args: any[]) => any)

mock.module("ai", () => ({
  ...actualAi,
  streamText: streamTextMock,
}))

const { DawnAgent } = await import("../src/agent/agent")

function streamFrom(messages: Array<{ role: "assistant"; content: string }> = []): any {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "ok" }
      yield { type: "text-end" }
    })(),
    response: Promise.resolve({ messages }),
  }
}

function testCatalog() {
  return {
    test: {
      id: "test",
      name: "Test",
      api: "http://localhost:9999/v1",
      models: {
        edit: { id: "edit", name: "Edit Model", tool_call: true },
        plan: { id: "plan", name: "Plan Model", tool_call: true },
      },
    },
  }
}

/** The model id the SDK was asked to stream from on the latest call. */
function lastModelId(): string | undefined {
  const call = streamTextMock.mock.calls[streamTextMock.mock.calls.length - 1]
  return call?.[0]?.model?.modelId
}

describe("DawnAgent plan model selection", () => {
  let tmp: string
  let bus: Bus
  let gate: PermissionGate
  let contextStore: ContextStore

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-agent-plan-model-"))
    bus = new Bus()
    gate = new PermissionGate()
    contextStore = new ContextStore(path.join(tmp, "context.db"))
    streamTextMock.mockReset()
    streamTextMock.mockImplementation(() => streamFrom([{ role: "assistant", content: "ok" }]))
  })

  afterEach(() => {
    contextStore.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function makeAgent() {
    return new DawnAgent({
      cwd: tmp,
      modelRef: "test/edit",
      planModelRef: "test/plan",
      bus,
      gate,
      catalog: testCatalog(),
      config: {},
      contextStore,
    })
  }

  test("uses the plan model while in plan mode", async () => {
    const agent = makeAgent()
    gate.setMode("plan")
    try {
      await agent.send("draft a plan")
      expect(lastModelId()).toBe("plan")
    } finally {
      agent.close()
    }
  })

  test("uses the edit model in normal and acceptEdits modes", async () => {
    const agent = makeAgent()
    try {
      gate.setMode("normal")
      await agent.send("make the edit")
      expect(lastModelId()).toBe("edit")

      gate.setMode("acceptEdits")
      await agent.send("make another edit")
      expect(lastModelId()).toBe("edit")
    } finally {
      agent.close()
    }
  })

  test("falls back to the edit model in plan mode when no plan model is set", async () => {
    const agent = new DawnAgent({
      cwd: tmp,
      modelRef: "test/edit",
      bus,
      gate,
      catalog: testCatalog(),
      config: {},
      contextStore,
    })
    gate.setMode("plan")
    try {
      await agent.send("draft a plan")
      expect(lastModelId()).toBe("edit")
    } finally {
      agent.close()
    }
  })

  test("setPlanModel validates and can be cleared", () => {
    const agent = makeAgent()
    try {
      agent.setPlanModel("test/edit")
      expect(agent.planModelRef).toBe("test/edit")
      agent.setPlanModel("")
      expect(agent.planModelRef).toBeUndefined()
      expect(() => agent.setPlanModel("nope/missing")).toThrow()
    } finally {
      agent.close()
    }
  })
})
