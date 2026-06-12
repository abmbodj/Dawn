import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { listAuthProviders, removeApiKey, resolveApiKey, setApiKey } from "../src/auth/auth"
import { loadConfig } from "../src/config/config"

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
    const mode = fs.statSync(path.join(process.env.DAWN_DATA_DIR!, "auth.json")).mode & 0o777
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
    fs.mkdirSync(process.env.DAWN_CONFIG_DIR!, { recursive: true })
    fs.writeFileSync(
      path.join(process.env.DAWN_CONFIG_DIR!, "config.json"),
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
