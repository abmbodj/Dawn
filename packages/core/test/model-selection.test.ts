import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setApiKey } from "../src/auth/auth"
import type { DawnConfig } from "../src/config/config"
import type { Catalog } from "../src/provider/catalog"
import {
  isUsableModelRef,
  selectInitialModel,
  selectProviderInitialModel,
} from "../src/provider/model-selection"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-model-selection-"))
  process.env.DAWN_DATA_DIR = path.join(tmp, "data")
  process.env.DAWN_CONFIG_DIR = path.join(tmp, "config")
  process.env.DAWN_CACHE_DIR = path.join(tmp, "cache")
})

afterEach(() => {
  delete process.env.DAWN_DATA_DIR
  delete process.env.DAWN_CONFIG_DIR
  delete process.env.DAWN_CACHE_DIR
  fs.rmSync(tmp, { recursive: true, force: true })
})

function liveCatalog(): Catalog {
  return {
    test: {
      id: "test",
      name: "Test",
      env: ["TEST_API_KEY"],
      api: "https://test.example/v1",
      modelsSource: "live",
      models: {
        good: { id: "good", name: "Good", tool_call: true },
        backup: { id: "backup", name: "Backup", tool_call: true },
        "no-tool": { id: "no-tool", name: "No Tool", tool_call: false },
      },
    },
  }
}

function connect(providerId = "test") {
  setApiKey(providerId, "sk-test")
}

describe("model selection", () => {
  test("preserves a valid configured model", () => {
    connect()
    const config: DawnConfig = { model: "test/good", providers: {} }

    expect(selectInitialModel(liveCatalog(), config)).toEqual({ ref: "test/good", reason: "configured" })
    expect(isUsableModelRef("test/good", liveCatalog(), config)).toBe(true)
  })

  test("repairs a stale configured model with another model from the same provider", () => {
    connect()
    const config: DawnConfig = { model: "test/missing", providers: {} }

    expect(selectInitialModel(liveCatalog(), config)).toEqual({
      ref: "test/good",
      reason: "repaired",
      repairedFrom: "test/missing",
    })
  })

  test("does not select a missing hard-coded setup default when live models differ", () => {
    connect("groq")
    const catalog: Catalog = {
      groq: {
        id: "groq",
        name: "Groq",
        env: ["GROQ_API_KEY"],
        api: "https://api.groq.com/openai/v1",
        modelsSource: "live",
        models: {
          "account-visible": { id: "account-visible", name: "Account Visible", tool_call: true },
        },
      },
    }

    expect(selectProviderInitialModel("groq", catalog, { providers: {} })?.ref).toBe("groq/account-visible")
  })

  test("returns no provider selection when no live tool-capable models are visible", () => {
    connect()
    const catalog = liveCatalog()
    const provider = catalog.test
    if (!provider) throw new Error("missing test provider")
    provider.models = {
      blocked: { id: "blocked", name: "Blocked", tool_call: false },
    }

    expect(selectProviderInitialModel("test", catalog, { providers: {} })).toBeUndefined()
  })

  test("does not silently pick local models without an explicit saved model", () => {
    const catalog: Catalog = {
      ollama: {
        id: "ollama",
        name: "Ollama",
        env: [],
        api: "http://localhost:11434/v1",
        modelsSource: "live",
        models: {
          "qwen:latest": { id: "qwen:latest", name: "Qwen", tool_call: true },
        },
      },
    }

    expect(selectInitialModel(catalog, { providers: {} })).toBeUndefined()
    expect(selectInitialModel(catalog, { model: "ollama/qwen:latest", providers: {} })).toEqual({
      ref: "ollama/qwen:latest",
      reason: "configured",
    })
  })

  test("returns no initial model when only static catalog metadata is available", () => {
    connect()
    const catalog = liveCatalog()
    const provider = catalog.test
    if (!provider) throw new Error("missing test provider")
    delete provider.modelsSource

    expect(selectInitialModel(catalog, { providers: {} })).toBeUndefined()
  })
})
