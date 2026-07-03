import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DawnAgent } from "../src/agent/agent"
import { Bus } from "../src/bus/bus"
import { ContextStore } from "../src/context/store"
import { PermissionGate } from "../src/permission/permission"
import { resolveProfile } from "../src/provider/profile"

describe("context budget overflow", () => {
  test("requestMessages degrades instead of throwing when the estimate exceeds the budget", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-agent-overflow-"))
    const bus = new Bus()
    const statuses: string[] = []
    bus.subscribe((e) => {
      if (e.type === "status") statuses.push(e.message)
    })
    const agent = new DawnAgent({
      cwd: tmp,
      modelRef: "test/model",
      bus,
      gate: new PermissionGate(),
      catalog: {},
      config: {},
      sessionId: "session-overflow",
      contextStore: new ContextStore(path.join(tmp, "context.db")),
      tokenBudget: 50,
    })

    try {
      // A latest turn far beyond a 50-token budget: nothing left to trim.
      agent.messages = [{ role: "user", content: "x".repeat(4000) }]
      const profile = resolveProfile("test/model", {})
      // biome-ignore lint/complexity/useLiteralKeys: bracket access reaches the private method under test
      const built = agent["requestMessages"](profile)
      expect(built.messages.length).toBeGreaterThan(0)
      expect(statuses.some((s) => s.includes("exceeds budget"))).toBe(true)
    } finally {
      agent.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
