import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { chooseFallback } from "../src/agent/agent"
import { setApiKey } from "../src/auth/auth"
import type { DawnConfig } from "../src/config/config"
import type { Catalog } from "../src/provider/catalog"
import { resolveRoleModel } from "../src/provider/roles"

let tmp: string

// Provider keys can leak in from the host environment (resolveApiKey reads env vars),
// which would make cross-provider fallback non-deterministic. Neutralize them so each
// test controls connectivity purely through setApiKey (auth.json).
const NEUTRALIZED_ENV = [
  "TEST_API_KEY",
  "SOLO_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  // Enterprise gateways resolve via cloud credential chains — neutralize so the
  // cross-provider blessed fallback can't pick up host AWS/GCP/Azure config.
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_VERTEX_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "AZURE_API_KEY",
]
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-roles-fallback-"))
  process.env.DAWN_DATA_DIR = path.join(tmp, "data")
  process.env.DAWN_CONFIG_DIR = path.join(tmp, "config")
  process.env.DAWN_CACHE_DIR = path.join(tmp, "cache")
  savedEnv = {}
  for (const key of NEUTRALIZED_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  delete process.env.DAWN_DATA_DIR
  delete process.env.DAWN_CONFIG_DIR
  delete process.env.DAWN_CACHE_DIR
  for (const key of NEUTRALIZED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

function catalog(): Catalog {
  return {
    test: {
      id: "test",
      name: "Test",
      env: ["TEST_API_KEY"],
      api: "https://test.example/v1",
      modelsSource: "live",
      models: {
        expensive: { id: "expensive", name: "Expensive", tool_call: true, cost: { input: 10 } },
        cheap: { id: "cheap", name: "Cheap", tool_call: true, cost: { input: 1 } },
        "no-tool": { id: "no-tool", name: "No Tool", tool_call: false },
      },
    },
    solo: {
      id: "solo",
      name: "Solo",
      env: ["SOLO_API_KEY"],
      api: "https://solo.example/v1",
      modelsSource: "live",
      models: {
        only: { id: "only", name: "Only", tool_call: true },
      },
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      modelsSource: "live",
      models: {
        "claude-opus-4-8": { id: "claude-opus-4-8", name: "Opus", tool_call: true, cost: { input: 15 } },
        "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Sonnet", tool_call: true, cost: { input: 3 } },
        "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Haiku", tool_call: true, cost: { input: 1 } },
      },
    },
    // Present (with env) so resolveModel performs a real key check during the
    // cross-provider blessed fallback — mirrors production where the catalog always
    // carries these providers.
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      modelsSource: "live",
      models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", tool_call: true } },
    },
    google: {
      id: "google",
      name: "Google",
      env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
      modelsSource: "live",
      models: { "gemini-3.5-pro": { id: "gemini-3.5-pro", name: "Gemini 3.5 Pro", tool_call: true } },
    },
  }
}

describe("chooseFallback ordering", () => {
  test("prefers the cheapest accessible model on the same provider", () => {
    setApiKey("test", "sk-test")
    const config: DawnConfig = { providers: {} }
    expect(chooseFallback("test/expensive", catalog(), config)).toBe("test/cheap")
  })

  test("honors a provider-suggested slug first", () => {
    setApiKey("test", "sk-test")
    const config: DawnConfig = { providers: {} }
    expect(chooseFallback("test/expensive", catalog(), config, "cheap")).toBe("test/cheap")
  })

  test("crosses to a blessed flagship on another connected provider as last resort", () => {
    setApiKey("solo", "sk-solo")
    setApiKey("anthropic", "sk-anthropic")
    const config: DawnConfig = { providers: {} }
    // solo has no other same-provider tool-capable model → cross to a connected blessed model
    const ref = chooseFallback("solo/only", catalog(), config)
    expect(ref?.startsWith("anthropic/")).toBe(true)
  })

  test("returns undefined when no alternative is accessible", () => {
    setApiKey("solo", "sk-solo")
    const config: DawnConfig = { providers: {} }
    expect(chooseFallback("solo/only", catalog(), config)).toBeUndefined()
  })
})

describe("resolveRoleModel", () => {
  const primary = "anthropic/claude-opus-4-8"

  test("primary returns the primary ref", () => {
    expect(resolveRoleModel("primary", primary, catalog(), { providers: {} })).toBe(primary)
  })

  test("plan defaults to primary, honors configured planModel", () => {
    expect(resolveRoleModel("plan", primary, catalog(), { providers: {} })).toBe(primary)
    expect(resolveRoleModel("plan", primary, catalog(), { planModel: "test/cheap", providers: {} })).toBe(
      "test/cheap",
    )
  })

  test("utility defaults to the cheapest blessed model on the primary's provider", () => {
    expect(resolveRoleModel("utility", primary, catalog(), { providers: {} })).toBe(
      "anthropic/claude-haiku-4-5",
    )
  })

  test("utility honors an explicit utilityModel", () => {
    expect(
      resolveRoleModel("utility", primary, catalog(), { utilityModel: "test/cheap", providers: {} }),
    ).toBe("test/cheap")
  })
})
