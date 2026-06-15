import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Catalog, loadConfig, setApiKey } from "@dawn/core"
import type { ProviderOption } from "../src/components/ProviderConnect"
import { completeConnectedProviderSetup } from "../src/components/Setup"

const realFetch = globalThis.fetch
let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-setup-"))
  process.env.DAWN_DATA_DIR = path.join(tmp, "data")
  process.env.DAWN_CONFIG_DIR = path.join(tmp, "config")
  process.env.DAWN_CACHE_DIR = path.join(tmp, "cache")
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.DAWN_DATA_DIR
  delete process.env.DAWN_CONFIG_DIR
  delete process.env.DAWN_CACHE_DIR
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("setup provider completion", () => {
  test("saves the live-selected model instead of the provider's hard-coded default", async () => {
    const provider: ProviderOption = {
      id: "custom",
      label: "Custom",
      url: "provider.example",
      defaultModel: "custom/stale-default",
      envVar: "CUSTOM_API_KEY",
    }
    const catalog: Catalog = {
      custom: {
        id: "custom",
        name: "Custom",
        env: ["CUSTOM_API_KEY"],
        api: "https://provider.example/v1",
        models: {
          "stale-default": { id: "stale-default", name: "Stale Default", tool_call: true },
        },
      },
    }

    globalThis.fetch = ((input: any) => {
      expect(String(input)).toBe("https://provider.example/v1/models")
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: "account-visible",
              name: "Account Visible",
              supported_parameters: ["tools"],
            },
          ],
        }),
      )
    }) as typeof fetch
    setApiKey("custom", "sk-test")

    const selection = await completeConnectedProviderSetup(provider, catalog, { providers: {} })

    expect(selection?.ref).toBe("custom/account-visible")
    expect(selection?.ref).not.toBe(provider.defaultModel)
    expect(loadConfig(tmp).model).toBe("custom/account-visible")
  })
})
