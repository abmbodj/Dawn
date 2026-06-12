import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DawnAgent } from "../src/agent/agent"
import { Bus } from "../src/bus/bus"
import { ContextStore } from "../src/context/store"
import { PermissionGate } from "../src/permission/permission"

describe("DawnAgent sessions", () => {
  test("startSession resets messages, usage, and context counters", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-agent-session-"))
    const agent = new DawnAgent({
      cwd: tmp,
      modelRef: "test/model",
      bus: new Bus(),
      gate: new PermissionGate(),
      catalog: {},
      config: {},
      sessionId: "session-a",
      contextStore: new ContextStore(path.join(tmp, "context.db")),
    })

    try {
      agent.messages = [{ role: "user", content: "old turn" }]
      agent.ledger.record({
        providerId: "test",
        modelId: "model",
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 20,
        cacheWriteTokens: 5,
        cost: 0.001,
      })

      agent.startSession("session-b", [{ role: "user", content: "fresh turn" }])

      expect(agent.messages).toEqual([{ role: "user", content: "fresh turn" }])
      expect(agent.ledger.totals().steps).toBe(0)
      expect(agent.contextStats().estimatedSavedTokens).toBe(0)
      expect(agent.contextStats().highestCostTurn).toBeUndefined()
    } finally {
      agent.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
