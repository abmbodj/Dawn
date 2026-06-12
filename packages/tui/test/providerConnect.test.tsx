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

describe("ProviderConnect", () => {
  test("shows GitHub token fallback when OAuth client id is not configured", async () => {
    reactActEnv.IS_REACT_ACT_ENVIRONMENT = true
    const setup = await createTestRenderer({ width: 90, height: 10 })
    const root = createRoot(setup.renderer)

    try {
      act(() => {
        root.render(
          createElement(ProviderConnect, {
            provider: SETUP_PROVIDERS[0],
            config: { providers: {} },
            onConnected: () => {},
            onCancel: () => {},
          }),
        )
      })

      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain("GitHub OAuth client id is not configured.")
      expect(frame).toContain("DAWN_GITHUB_CLIENT_ID")
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
    const setup = await createTestRenderer({ width: 90, height: 12 })
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
            onConnected: () => {},
            onCancel: () => {},
          }),
        )
      })

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain("ABCD-1234")
      expect(frame).toContain("Browser opened automatically.")
      expect(frame).not.toContain("GitHub OAuth client id is not configured.")
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
    const setup = await createTestRenderer({ width: 90, height: 12 })
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
            onConnected: () => {},
            onCancel: () => {},
          }),
        )
      })

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain("github.com/login/device")
      expect(frame).toContain("ABCD-1234")
      expect(frame).toContain("Open the URL manually")
    } finally {
      act(() => {
        root.unmount()
      })
      await setup.renderer.destroy()
      reactActEnv.IS_REACT_ACT_ENVIRONMENT = false
    }
  })
})
