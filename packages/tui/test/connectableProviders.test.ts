import { describe, expect, test } from "bun:test"
import type { Catalog } from "@dawn/core"
import { connectableProviders, SETUP_PROVIDERS } from "../src/components/ProviderConnect"

const catalog: Catalog = {
  // curated — must not be duplicated
  groq: {
    id: "groq",
    name: "Groq",
    env: ["GROQ_API_KEY"],
    api: "https://api.groq.com/openai/v1",
    models: {},
  },
  // normal OpenAI-compatible extra provider
  requesty: {
    id: "requesty",
    name: "Requesty",
    env: ["REQUESTY_API_KEY"],
    api: "https://router.requesty.ai/v1",
    doc: "https://requesty.ai/models",
    models: { "some-model": { id: "some-model", name: "Some Model" } },
  },
  // no env vars → not key-connectable (local-style)
  ollama: { id: "ollama", name: "Ollama (local)", env: [], api: "http://localhost:11434/v1", models: {} },
  // no api and no native SDK → cannot dispatch
  sdkonly: { id: "sdkonly", name: "SDK Only", env: ["SDK_KEY"], npm: "@ai-sdk/sdkonly", models: {} },
  // enterprise gateway → excluded
  bedrock: { id: "bedrock", name: "Amazon Bedrock", env: ["AWS_ACCESS_KEY_ID"], models: {} },
}

describe("connectableProviders", () => {
  const result = connectableProviders(catalog)
  const ids = result.map((p) => p.id)

  test("curated providers come first, in their existing order", () => {
    expect(ids.slice(0, SETUP_PROVIDERS.length)).toEqual(SETUP_PROVIDERS.map((p) => p.id))
  })

  test("includes extra catalog providers with env + api, mapped from models.dev fields", () => {
    const requesty = result.find((p) => p.id === "requesty")
    expect(requesty).toBeDefined()
    expect(requesty?.label).toBe("Requesty")
    expect(requesty?.envVar).toBe("REQUESTY_API_KEY")
    expect(requesty?.url).toBe("requesty.ai/models")
    expect(requesty?.defaultModel).toBe("requesty/some-model")
  })

  test("excludes keyless, dispatch-less, enterprise, and already-curated providers", () => {
    expect(ids).not.toContain("ollama")
    expect(ids).not.toContain("sdkonly")
    expect(ids).not.toContain("bedrock")
    expect(ids.filter((id) => id === "groq")).toHaveLength(1)
  })
})
