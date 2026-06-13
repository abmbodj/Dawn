import { describe, expect, test } from "bun:test"
import type { DeviceFlowStart } from "@dawn/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { act, createElement } from "react"
import { ProviderConnect, SETUP_PROVIDERS } from "../src/components/ProviderConnect"

const reactActEnv = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

const deviceFlow: DeviceFlowStart = {
  deviceCode: "device-code",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresIn: 900,
  interval: 5,
}

// The github-copilot flow is async (detect gh CLI → start device flow → open
// browser), so pump microtasks and re-render until the expected text lands,
// instead of guessing a fixed number of flushes.
async function flushUntil(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (frame: string) => boolean,
  tries = 50,
): Promise<string> {
  let frame = setup.captureCharFrame()
  for (let i = 0; i < tries && !predicate(frame); i++) {
    await act(async () => {
      await Promise.resolve()
    })
    await setup.flush()
    frame = setup.captureCharFrame()
  }
  return frame
}

describe("ProviderConnect", () => {
  test("falls back to token paste when no OAuth client id is configured", async () => {
    reactActEnv.IS_REACT_ACT_ENVIRONMENT = true
    const setup = await createTestRenderer({ width: 90, height: 10 })
    const root = createRoot(setup.renderer)

    try {
      act(() => {
        root.render(
          createElement(ProviderConnect, {
            provider: SETUP_PROVIDERS[0],
            config: { providers: {} },
            tryGhCliTokenFn: async () => undefined,
            onConnected: () => {},
            onCancel: () => {},
          }),
        )
      })

      const frame = await flushUntil(setup, (f) => f.includes("GitHub Copilot token"))
      expect(frame).toContain("Or paste an existing GitHub Copilot token below.")
      expect(frame).toContain("GITHUB_COPILOT_TOKEN")
    } finally {
      act(() => {
        root.unmount()
      })
      await setup.renderer.destroy()
      reactActEnv.IS_REACT_ACT_ENVIRONMENT = false
    }
  })

  test("starts GitHub OAuth when a client id is configured", async () => {
    reactActEnv.IS_REACT_ACT_ENVIRONMENT = true
    const setup = await createTestRenderer({ width: 90, height: 16 })
    const root = createRoot(setup.renderer)

    try {
      act(() => {
        root.render(
          createElement(ProviderConnect, {
            provider: SETUP_PROVIDERS[0],
            config: { providers: {}, githubOAuthClientId: "config-client" },
            openUrl: async () => true,
            startDeviceFlowFn: async () => deviceFlow,
            pollForTokenFn: async () => new Promise<string>(() => {}),
            tryGhCliTokenFn: async () => undefined,
            copyToClipboardFn: async () => true,
            onConnected: () => {},
            onCancel: () => {},
          }),
        )
      })

      const frame = await flushUntil(setup, (f) => f.includes("Your browser is open"))
      expect(frame).toContain("ABCD-1234")
      expect(frame).toContain("Your browser is open. Enter the code below when prompted:")
      // Auto-open path: don't ask the user to open the URL themselves.
      expect(frame).not.toContain("Then enter this code:")
    } finally {
      act(() => {
        root.unmount()
      })
      await setup.renderer.destroy()
      reactActEnv.IS_REACT_ACT_ENVIRONMENT = false
    }
  })

  test("shows manual browser guidance when opening GitHub fails", async () => {
    reactActEnv.IS_REACT_ACT_ENVIRONMENT = true
    const setup = await createTestRenderer({ width: 90, height: 16 })
    const root = createRoot(setup.renderer)

    try {
      act(() => {
        root.render(
          createElement(ProviderConnect, {
            provider: SETUP_PROVIDERS[0],
            config: { providers: {}, githubOAuthClientId: "config-client" },
            openUrl: async () => false,
            startDeviceFlowFn: async () => deviceFlow,
            pollForTokenFn: async () => new Promise<string>(() => {}),
            tryGhCliTokenFn: async () => undefined,
            copyToClipboardFn: async () => true,
            onConnected: () => {},
            onCancel: () => {},
          }),
        )
      })

      const frame = await flushUntil(setup, (f) => f.includes("Then enter this code:"))
      // Manual path: surface the URL and the code, and don't claim the browser opened.
      expect(frame).toContain("github.com/login/device")
      expect(frame).toContain("ABCD-1234")
      expect(frame).toContain("Then enter this code:")
      expect(frame).not.toContain("Your browser is open")
    } finally {
      act(() => {
        root.unmount()
      })
      await setup.renderer.destroy()
      reactActEnv.IS_REACT_ACT_ENVIRONMENT = false
    }
  })
})
