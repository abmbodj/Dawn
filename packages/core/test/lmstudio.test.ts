import { afterEach, describe, expect, test } from "bun:test"
import type { Catalog } from "../src/provider/catalog"
import { detectLMStudio, lmStudioBaseURL, withLMStudio } from "../src/provider/lmstudio"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.LMSTUDIO_HOST
})

function mockFetch(impl: (url: string) => Response | Promise<Response> | Promise<never>) {
  globalThis.fetch = ((input: any) => Promise.resolve(impl(String(input)))) as any
}

describe("lmStudioBaseURL", () => {
  test("defaults to localhost:1234", () => {
    expect(lmStudioBaseURL()).toBe("http://localhost:1234")
  })

  test("LMSTUDIO_HOST as host:port gets an http prefix", () => {
    process.env.LMSTUDIO_HOST = "192.168.1.5:5678"
    expect(lmStudioBaseURL()).toBe("http://192.168.1.5:5678")
  })

  test("LMSTUDIO_HOST as full URL is used as-is, trailing slash trimmed", () => {
    process.env.LMSTUDIO_HOST = "http://gpu-box:1234/"
    expect(lmStudioBaseURL()).toBe("http://gpu-box:1234")
  })
})

describe("detectLMStudio", () => {
  test("returns a ProviderInfo with loaded models", async () => {
    mockFetch(() =>
      Response.json({
        data: [
          { id: "lmstudio-community/meta-llama-3.1-8b-instruct-gguf" },
          { id: "qwen2.5-coder-7b-instruct" },
        ],
      }),
    )
    const info = await detectLMStudio()
    expect(info?.id).toBe("lmstudio")
    expect(info?.name).toBe("LM Studio (local)")
    expect(info?.env).toEqual([])
    expect(info?.api).toBe("http://localhost:1234/v1")
    expect(Object.keys(info?.models ?? {})).toEqual([
      "lmstudio-community/meta-llama-3.1-8b-instruct-gguf",
      "qwen2.5-coder-7b-instruct",
    ])
    expect(info?.models["qwen2.5-coder-7b-instruct"]?.tool_call).toBe(true)
    expect(info?.models["qwen2.5-coder-7b-instruct"]?.cost).toBeNull()
  })

  test("returns undefined when the server is unreachable", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")))
    expect(await detectLMStudio()).toBeUndefined()
  })

  test("returns undefined when no models are loaded", async () => {
    mockFetch(() => Response.json({ data: [] }))
    expect(await detectLMStudio()).toBeUndefined()
  })

  test("returns undefined on a non-OK response", async () => {
    mockFetch(() => new Response("nope", { status: 500 }))
    expect(await detectLMStudio()).toBeUndefined()
  })
})

describe("withLMStudio", () => {
  test("injects a detected LM Studio into the catalog", async () => {
    mockFetch(() => Response.json({ data: [{ id: "phi-4-mini-instruct" }] }))
    const catalog: Catalog = {}
    await withLMStudio(catalog)
    expect(catalog.lmstudio?.models["phi-4-mini-instruct"]).toBeDefined()
  })

  test("removes a stale lmstudio entry when the probe fails", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")))
    const catalog: Catalog = {
      lmstudio: {
        id: "lmstudio",
        name: "stale",
        env: [],
        api: "http://x/v1",
        models: { old: { id: "old", name: "old" } },
      },
    }
    await withLMStudio(catalog)
    expect(catalog.lmstudio).toBeUndefined()
  })
})
