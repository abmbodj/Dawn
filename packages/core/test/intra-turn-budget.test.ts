import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ModelMessage } from "ai"
import { Bus } from "../src/bus/bus"
import { messageTokens } from "../src/context/budget"
import { ContextStore } from "../src/context/store"
import { PermissionGate } from "../src/permission/permission"

const actualAi = await import("ai")
const streamTextMock = mock((() => {
  throw new Error("streamText mock not configured")
}) as (...args: any[]) => any)

mock.module("ai", () => ({ ...actualAi, streamText: streamTextMock }))

const { DawnAgent } = await import("../src/agent/agent")

const BIG_OUTPUT = `search results ${"match line here\n".repeat(600)}`

function toolTurn(id: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: { command: "grep -rn x ." } }],
    } as any,
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "bash",
          output: { type: "text", value: BIG_OUTPUT },
        },
      ],
    } as any,
  ]
}

/**
 * Drives prepareStep the way the SDK does across a multi-step turn: the message list
 * grows by one tool turn per step and is re-sent whole each time.
 */
function stepPayloads(prepareStep: any, base: ModelMessage[], steps: number): number[] {
  const sizes: number[] = []
  let accumulated = [...base]
  for (let stepNumber = 0; stepNumber < steps; stepNumber++) {
    const result = prepareStep({ stepNumber, messages: accumulated, steps: [], model: {} as any })
    const sent = result?.messages ?? accumulated
    sizes.push(sent.reduce((s: number, m: ModelMessage) => s + messageTokens(m), 0))
    // The SDK keeps its own history: pruning applies to what is SENT, and the pruned
    // form is what the provider sees from then on.
    accumulated = [...sent, ...toolTurn(`call-${stepNumber}`)]
  }
  return sizes
}

describe("intra-turn budget enforcement", () => {
  let tmp: string
  let bus: Bus
  let gate: PermissionGate
  let contextStore: ContextStore

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-intra-turn-"))
    bus = new Bus()
    gate = new PermissionGate()
    contextStore = new ContextStore(path.join(tmp, "context.db"))
    streamTextMock.mockReset()
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "ok" }
        yield { type: "text-end" }
      })(),
      response: Promise.resolve({ messages: [] }),
    }))
  })

  afterEach(() => {
    contextStore.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function makeAgent(naive = false) {
    return new DawnAgent({
      cwd: tmp,
      modelRef: "test/edit",
      bus,
      gate,
      catalog: {
        test: {
          id: "test",
          name: "Test",
          api: "http://localhost:9999/v1",
          models: { edit: { id: "edit", name: "Edit", tool_call: true } },
        },
      } as any,
      config: {},
      contextStore,
      tokenBudget: 8000,
      naive,
    })
  }

  async function prepareStepOf(agent: any) {
    await agent.send("investigate")
    const call = streamTextMock.mock.calls[streamTextMock.mock.calls.length - 1]
    return call?.[0]?.prepareStep
  }

  test("a long multi-step turn stops growing without bound", async () => {
    const agent = makeAgent()
    try {
      const prepareStep = await prepareStepOf(agent)
      expect(typeof prepareStep).toBe("function")

      const sizes = stepPayloads(prepareStep, [{ role: "user", content: "investigate" }], 8)
      const peak = Math.max(...sizes)

      // Each step adds ~2.5k tokens of tool output. Unbounded, step 8 would be ~20k.
      // Pruning holds the sent payload near the 8k budget instead.
      expect(peak).toBeLessThan(8000 * 1.6)
      expect(sizes[sizes.length - 1]).toBeLessThan((sizes[3] ?? 0) * 2)
    } finally {
      agent.close()
    }
  })

  test("naive mode keeps growing — the baseline must stay un-optimized", async () => {
    const agent = makeAgent(true)
    try {
      const prepareStep = await prepareStepOf(agent)
      const sizes = stepPayloads(prepareStep, [{ role: "user", content: "investigate" }], 8)

      // Monotonic growth: every step carries every earlier output in full.
      expect(sizes[sizes.length - 1]).toBeGreaterThan((sizes[0] ?? 0) * 5)
    } finally {
      agent.close()
    }
  })
})
