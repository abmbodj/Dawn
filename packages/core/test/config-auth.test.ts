import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { listAuthProviders, removeApiKey, resolveApiKey, setApiKey } from "../src/auth/auth"
import { resolveGithubClientId } from "../src/auth/github-oauth"
import { hasConfiguredModel, loadConfig, saveConfig } from "../src/config/config"
import type { Catalog } from "../src/provider/catalog"

const CATALOG: Catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    modelsSource: "live",
    models: { "claude-sonnet": { id: "claude-sonnet", name: "Claude Sonnet", tool_call: true } },
  },
  ollama: {
    id: "ollama",
    name: "Ollama (local)",
    env: [],
    api: "http://localhost:11434/v1",
    modelsSource: "live",
    models: {},
  },
}

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-test-"))
  process.env.DAWN_DATA_DIR = path.join(tmp, "data")
  process.env.DAWN_CONFIG_DIR = path.join(tmp, "config")
  process.env.DAWN_CACHE_DIR = path.join(tmp, "cache")
})

afterEach(() => {
  delete process.env.DAWN_DATA_DIR
  delete process.env.DAWN_CONFIG_DIR
  delete process.env.DAWN_CACHE_DIR
  delete process.env.DAWN_GITHUB_CLIENT_ID
  delete process.env.DAWN_TEST_KEY
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("auth store", () => {
  test("set, resolve, list, remove round-trip", () => {
    setApiKey("anthropic", "sk-test-123")
    expect(resolveApiKey("anthropic")).toBe("sk-test-123")
    expect(listAuthProviders()).toEqual(["anthropic"])
    expect(removeApiKey("anthropic")).toBe(true)
    expect(resolveApiKey("anthropic")).toBeUndefined()
  })

  test("auth file is written with 0600 permissions", () => {
    setApiKey("openai", "sk-x")
    const dataDir = process.env.DAWN_DATA_DIR ?? ""
    const mode = fs.statSync(path.join(dataDir, "auth.json")).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("falls back to env vars when no stored key", () => {
    process.env.DAWN_TEST_KEY = "from-env"
    expect(resolveApiKey("custom", ["DAWN_TEST_KEY"])).toBe("from-env")
  })

  test("stored key wins over env", () => {
    process.env.DAWN_TEST_KEY = "from-env"
    setApiKey("custom", "from-store")
    expect(resolveApiKey("custom", ["DAWN_TEST_KEY"])).toBe("from-store")
  })
})

describe("loadConfig", () => {
  test("returns empty config when no files exist", () => {
    expect(loadConfig(tmp)).toEqual({ providers: {} })
  })

  test("project dawn.json overrides global config", () => {
    const configDir = process.env.DAWN_CONFIG_DIR ?? ""
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ model: "anthropic/claude-opus-4-8", providers: { ollama: { baseURL: "http://a" } } }),
    )
    fs.writeFileSync(
      path.join(tmp, "dawn.json"),
      JSON.stringify({ model: "openai/gpt-5.5", providers: { router: { baseURL: "http://b" } } }),
    )
    const config = loadConfig(tmp)
    expect(config.model).toBe("openai/gpt-5.5")
    // providers merge across both files
    expect(config.providers?.ollama?.baseURL).toBe("http://a")
    expect(config.providers?.router?.baseURL).toBe("http://b")
  })

  test("rejects invalid config shape", () => {
    fs.writeFileSync(path.join(tmp, "dawn.json"), JSON.stringify({ permissions: { bash: "yolo" } }))
    expect(() => loadConfig(tmp)).toThrow()
  })
})

describe("GitHub OAuth client id", () => {
  test("uses DAWN_GITHUB_CLIENT_ID when set", () => {
    process.env.DAWN_GITHUB_CLIENT_ID = "env-client"

    expect(resolveGithubClientId({ githubOAuthClientId: "config-client" }, "built-in-client")).toBe(
      "env-client",
    )
  })

  test("falls back to config githubOAuthClientId", () => {
    expect(resolveGithubClientId({ githubOAuthClientId: "config-client" }, "built-in-client")).toBe(
      "config-client",
    )
  })

  test("falls back to the built-in client id", () => {
    expect(resolveGithubClientId({}, "built-in-client")).toBe("built-in-client")
  })

  test("returns undefined when no client id is configured", () => {
    expect(resolveGithubClientId({})).toBeUndefined()
  })
})

describe("saveConfig", () => {
  test("persists a model choice into global config.json", () => {
    saveConfig({ model: "ollama/qwen2.5-coder:latest" })
    expect(loadConfig(tmp).model).toBe("ollama/qwen2.5-coder:latest")
  })

  test("merges without clobbering existing keys", () => {
    saveConfig({ model: "anthropic/claude-opus-4-8" })
    saveConfig({ providers: { router: { baseURL: "http://x" } } })
    const config = loadConfig(tmp)
    expect(config.model).toBe("anthropic/claude-opus-4-8")
    expect(config.providers?.router?.baseURL).toBe("http://x")
  })
})

describe("hasConfiguredModel", () => {
  test("false when only a key-free local provider is reachable", () => {
    expect(hasConfiguredModel(CATALOG, { providers: {} })).toBe(false)
  })

  test("true when a cloud provider has a key", () => {
    setApiKey("anthropic", "sk-test")
    expect(hasConfiguredModel(CATALOG, { providers: {} })).toBe(true)
  })

  test("true when config.model is set, even with no keys", () => {
    expect(hasConfiguredModel(CATALOG, { model: "ollama/qwen2.5-coder:latest", providers: {} })).toBe(true)
  })
})
