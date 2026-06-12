import { afterEach, describe, expect, test } from "bun:test"
import type { Catalog } from "../src/provider/catalog"
import { detectOllama, ollamaBaseURL, withOllama } from "../src/provider/ollama"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.OLLAMA_HOST
})

function mockFetch(impl: (url: string) => Response | Promise<Response> | Promise<never>) {
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  globalThis.fetch = ((input: any) => Promise.resolve(impl(String(input)))) as any
}

describe("ollamaBaseURL", () => {
  test("defaults to localhost:11434", () => {
    expect(ollamaBaseURL()).toBe("http://localhost:11434")
  })

  test("OLLAMA_HOST as host:port gets an http prefix", () => {
    process.env.OLLAMA_HOST = "192.168.1.5:9999"
    expect(ollamaBaseURL()).toBe("http://192.168.1.5:9999")
  })

  test("OLLAMA_HOST as full URL is used as-is, trailing slash trimmed", () => {
    process.env.OLLAMA_HOST = "http://gpu-box:1234/"
    expect(ollamaBaseURL()).toBe("http://gpu-box:1234")
  })
})

describe("detectOllama", () => {
  test("returns a ProviderInfo with installed models", async () => {
    mockFetch(() =>
      Response.json({ models: [{ name: "llama3.2:latest" }, { name: "qwen2.5-coder:7b" }] }),
    )
    const info = await detectOllama()
    expect(info?.id).toBe("ollama")
    expect(info?.env).toEqual([])
    expect(info?.api).toBe("http://localhost:11434/v1")
    expect(Object.keys(info?.models ?? {})).toEqual(["llama3.2:latest", "qwen2.5-coder:7b"])
    expect(info?.models["llama3.2:latest"]?.tool_call).toBe(true)
    expect(info?.models["llama3.2:latest"]?.cost).toBeNull()
  })

  test("returns undefined when the server is unreachable", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")))
    expect(await detectOllama()).toBeUndefined()
  })

  test("returns undefined when no models are installed", async () => {
    mockFetch(() => Response.json({ models: [] }))
    expect(await detectOllama()).toBeUndefined()
  })

  test("returns undefined on a non-OK response", async () => {
    mockFetch(() => new Response("nope", { status: 500 }))
    expect(await detectOllama()).toBeUndefined()
  })
})

describe("withOllama", () => {
  test("injects a detected Ollama into the catalog", async () => {
    mockFetch(() => Response.json({ models: [{ name: "phi4:latest" }] }))
    const catalog: Catalog = {}
    await withOllama(catalog)
    expect(catalog.ollama?.models["phi4:latest"]).toBeDefined()
  })

  test("removes a stale ollama entry when the probe fails", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")))
    const catalog: Catalog = {
      ollama: { id: "ollama", name: "stale", env: [], api: "http://x/v1", models: { old: { id: "old", name: "old" } } },
    }
    await withOllama(catalog)
    expect(catalog.ollama).toBeUndefined()
  })
})
