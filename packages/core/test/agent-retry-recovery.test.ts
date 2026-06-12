import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { APICallError } from "ai"
import { Bus } from "../src/bus/bus"
import { ContextStore } from "../src/context/store"
import { PermissionGate } from "../src/permission/permission"
import { SessionStore } from "../src/session/store"

const actualAi = await import("ai")
const streamTextMock = mock((() => {
  throw new Error("streamText mock not configured")
}) as (...args: any[]) => any)

mock.module("ai", () => ({
  ...actualAi,
  streamText: streamTextMock,
}))

const { DawnAgent } = await import("../src/agent/agent")

function makeRetryableError(message = "Failed to call a function. See failed_generation for details.") {
  return new APICallError({
    message,
    url: "https://api.groq.com/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: '{"error":{"failed_generation":"bad tool call"}}',
    isRetryable: false,
  })
}

function streamFrom(parts: any[], messages: Array<{ role: "assistant"; content: string }> = []): any {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part
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
        model: {
          id: "model",
          name: "Test Model",
          tool_call: true,
        },
      },
    },
  }
}

describe("DawnAgent retry recovery", () => {
  let tmp: string
  let bus: Bus
  let gate: PermissionGate
  let sessionStore: SessionStore
  let contextStore: ContextStore
  let events: any[]

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-agent-retry-"))
    bus = new Bus()
    gate = new PermissionGate()
    sessionStore = new SessionStore(path.join(tmp, "session.db"))
    contextStore = new ContextStore(path.join(tmp, "context.db"))
    events = []
    bus.subscribe((event) => {
      events.push(event)
    })
    streamTextMock.mockReset()
  })

  afterEach(() => {
    sessionStore.close()
    contextStore.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("discards partial streamed output and retries once on a retryable tool-call failure", async () => {
    const session = sessionStore.createSession(tmp)
    const agent = new DawnAgent({
      cwd: tmp,
      modelRef: "test/model",
      bus,
      gate,
      catalog: testCatalog(),
      config: {},
      store: sessionStore,
      sessionId: session.id,
      contextStore,
    })

    streamTextMock
      .mockImplementationOnce(() =>
        streamFrom([
          { type: "text-delta", text: "Let me search for the Catalog file." },
          { type: "error", error: makeRetryableError() },
        ]),
      )
      .mockImplementationOnce(() =>
        streamFrom(
          [{ type: "text-delta", text: "Recovered answer" }, { type: "text-end" }],
          [{ role: "assistant", content: "Recovered answer" }],
        ),
      )

    try {
      await agent.send("find the catalog")

      expect(events.map((event) => event.type)).toEqual([
        "turn-start",
        "text-delta",
        "attempt-reset",
        "status",
        "text-delta",
        "text-end",
        "turn-end",
      ])
      expect(events[2]).toEqual({ type: "attempt-reset", reason: "retryable-tool-failure" })
      expect(events[3]).toEqual({ type: "status", message: "provider rejected a tool call — retrying…" })

      expect(sessionStore.loadMessages(session.id)).toEqual([
        { role: "user", content: "find the catalog" },
        { role: "assistant", content: "Recovered answer" },
      ])
    } finally {
      agent.close()
    }
  })

  test("drops both failed attempts and surfaces only the final error when retry also fails", async () => {
    const session = sessionStore.createSession(tmp)
    const agent = new DawnAgent({
      cwd: tmp,
      modelRef: "test/model",
      bus,
      gate,
      catalog: testCatalog(),
      config: {},
      store: sessionStore,
      sessionId: session.id,
      contextStore,
    })

    streamTextMock
      .mockImplementationOnce(() =>
        streamFrom([
          { type: "text-delta", text: "First partial answer" },
          {
            type: "error",
            error: makeRetryableError("Failed to call a function. Please adjust your prompt."),
          },
        ]),
      )
      .mockImplementationOnce(() =>
        streamFrom([
          { type: "text-delta", text: "Second partial answer" },
          {
            type: "error",
            error: makeRetryableError("Failed to call a function. Please adjust your prompt."),
          },
        ]),
      )

    try {
      await agent.send("find the catalog")

      expect(events.map((event) => event.type)).toEqual([
        "turn-start",
        "text-delta",
        "attempt-reset",
        "status",
        "text-delta",
        "attempt-reset",
        "error",
        "turn-end",
      ])
      expect(events[6]).toEqual({
        type: "error",
        message: "Failed to call a function. Please adjust your prompt.",
      })

      expect(sessionStore.loadMessages(session.id)).toEqual([{ role: "user", content: "find the catalog" }])
    } finally {
      agent.close()
    }
  })

  test("does not reset the attempt for non-retryable errors", async () => {
    const session = sessionStore.createSession(tmp)
    const agent = new DawnAgent({
      cwd: tmp,
      modelRef: "test/model",
      bus,
      gate,
      catalog: testCatalog(),
      config: {},
      store: sessionStore,
      sessionId: session.id,
      contextStore,
    })

    streamTextMock.mockImplementationOnce(() =>
      streamFrom([
        { type: "text-delta", text: "Partial answer" },
        { type: "error", error: new Error("plain provider error") },
      ]),
    )

    try {
      await agent.send("find the catalog")

      expect(events.map((event) => event.type)).toEqual(["turn-start", "text-delta", "error", "turn-end"])
      expect(events.some((event) => event.type === "attempt-reset")).toBe(false)
      expect(sessionStore.loadMessages(session.id)).toEqual([{ role: "user", content: "find the catalog" }])
    } finally {
      agent.close()
    }
  })
})
