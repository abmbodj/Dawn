import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  Asker,
  Bus,
  type Catalog,
  ContextStore,
  DawnAgent,
  type ModelMessage,
  PermissionGate,
  SessionStore,
} from "@dawn/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { act, createElement } from "react"
import { App } from "../src/app"

const reactActEnv = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

const catalog: Catalog = {
  test: {
    id: "test",
    name: "Test",
    modelsSource: "live",
    models: {
      model: {
        id: "model",
        name: "Test Model",
        tool_call: true,
        cost: { input: 1, output: 1 },
      },
    },
  },
}

async function renderApp(messages: ModelMessage[]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-tui-app-"))
  const store = new SessionStore(path.join(tmp, "session.db"))
  const session = store.createSession(tmp)
  const gate = new PermissionGate()
  const asker = new Asker()
  const agent = new DawnAgent({
    cwd: tmp,
    modelRef: "test/model",
    bus: new Bus(),
    gate,
    asker,
    catalog,
    config: { model: "test/model" },
    store,
    sessionId: session.id,
    initialMessages: messages,
    contextStore: new ContextStore(path.join(tmp, "context.db")),
  })
  const setup = await createTestRenderer({ width: 140, height: 24 })
  const root = createRoot(setup.renderer)

  act(() => {
    root.render(
      createElement(App, {
        agent,
        store,
        session,
        catalog,
        config: { model: "test/model" },
        gate,
        asker,
        animate: false,
      }),
    )
  })
  await setup.flush()

  return {
    frame: setup.captureCharFrame(),
    cleanup: async () => {
      act(() => {
        root.unmount()
      })
      await setup.renderer.destroy()
      await agent.close()
      store.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

describe("App usage boxes", () => {
  test("hides usage and savings boxes on the empty home screen", async () => {
    reactActEnv.IS_REACT_ACT_ENVIRONMENT = true
    const { frame, cleanup } = await renderApp([])

    try {
      expect(frame).toContain("Usage: 0 in / 0 out")
      expect(frame).not.toContain("usage")
      expect(frame).not.toContain("savings")
    } finally {
      await cleanup()
      reactActEnv.IS_REACT_ACT_ENVIRONMENT = false
    }
  })

  test("shows usage and savings boxes once the transcript is visible", async () => {
    reactActEnv.IS_REACT_ACT_ENVIRONMENT = true
    const { frame, cleanup } = await renderApp([{ role: "user", content: "hello Dawn" }])

    try {
      expect(frame).toContain("hello Dawn")
      expect(frame).toContain("usage")
      expect(frame).toContain("savings")
      expect(frame).not.toContain("Usage: 0 in / 0 out")
    } finally {
      await cleanup()
      reactActEnv.IS_REACT_ACT_ENVIRONMENT = false
    }
  })
})
