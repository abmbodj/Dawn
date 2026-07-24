import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Catalog } from "../src/provider/catalog"
import { FALLBACK_CATALOG } from "../src/provider/catalog"
import { withLiveModels } from "../src/provider/live-models"

// Raw models.dev-style catalog entry for a connected provider: three models,
// two of which the account may not actually have access to.
function rawGroq(baseURL: string): Catalog {
  return {
    groq: {
      id: "groq",
      name: "Groq",
      env: ["GROQ_API_KEY"],
      api: baseURL,
      models: {
        "real-model": { id: "real-model", name: "Real Model", tool_call: true },
        "gated-model": { id: "gated-model", name: "Gated Model", tool_call: true },
        "stale-model": { id: "stale-model", name: "Stale Model", tool_call: true },
      },
    },
  }
}

describe("withLiveModels availability clamp", () => {
  let tmp: string
  let prevCache: string | undefined
  let prevData: string | undefined
  let prevKey: string | undefined
  let servers: Array<{ stop: (force?: boolean) => void }>

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-live-"))
    prevCache = process.env.DAWN_CACHE_DIR
    prevData = process.env.DAWN_DATA_DIR
    prevKey = process.env.GROQ_API_KEY
    process.env.DAWN_CACHE_DIR = path.join(tmp, "cache")
    process.env.DAWN_DATA_DIR = path.join(tmp, "data") // keep the user's real auth.json out of tests
    process.env.GROQ_API_KEY = "test-key"
    servers = []
  })

  afterEach(() => {
    for (const s of servers) s.stop(true)
    if (prevCache === undefined) delete process.env.DAWN_CACHE_DIR
    else process.env.DAWN_CACHE_DIR = prevCache
    if (prevData === undefined) delete process.env.DAWN_DATA_DIR
    else process.env.DAWN_DATA_DIR = prevData
    if (prevKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = prevKey
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function serve(handler: (req: Request) => Response): string {
    const server = Bun.serve({ port: 0, fetch: handler })
    servers.push(server)
    return `http://localhost:${server.port}`
  }

  function liveCacheFile(): Record<string, { fetchedAt: number; models: Record<string, unknown> }> {
    return JSON.parse(fs.readFileSync(path.join(tmp, "cache", "live-models.json"), "utf8"))
  }

  test("successful probe replaces catalog models and persists the live cache", async () => {
    const url = serve(() => Response.json({ data: [{ id: "real-model", name: "Real Model" }] }))
    const catalog = rawGroq(url)
    await withLiveModels(catalog, "groq", { providers: {} })

    expect(catalog.groq?.modelsSource).toBe("live")
    expect(Object.keys(catalog.groq?.models ?? {})).toEqual(["real-model"])
    expect(Object.keys(liveCacheFile().groq?.models ?? {})).toEqual(["real-model"])
  })

  test("failed probe with a live cache falls back to cached-live, not raw catalog", async () => {
    const goodUrl = serve(() => Response.json({ data: [{ id: "real-model", name: "Real Model" }] }))
    const badUrl = serve(() => new Response("nope", { status: 500 }))

    // First run seeds the cache, second run probes a failing endpoint.
    await withLiveModels(rawGroq(goodUrl), "groq", { providers: {} })
    const catalog = rawGroq(badUrl)
    await withLiveModels(catalog, "groq", { providers: {} })

    expect(catalog.groq?.modelsSource).toBe("cached-live")
    expect(Object.keys(catalog.groq?.models ?? {})).toEqual(["real-model"])
  })

  test("failed probe with no cache clamps to the curated fallback list", async () => {
    const badUrl = serve(() => new Response("nope", { status: 500 }))
    const catalog = rawGroq(badUrl)
    await withLiveModels(catalog, "groq", { providers: {} })

    expect(catalog.groq?.modelsSource).toBe("catalog")
    expect(catalog.groq?.models).toEqual(FALLBACK_CATALOG.groq?.models ?? {})
    expect(catalog.groq?.models["stale-model"]).toBeUndefined()
  })

  test("unreachable endpoint (network error) also clamps", async () => {
    // Port 1 refuses connections.
    const catalog = rawGroq("http://127.0.0.1:1")
    await withLiveModels(catalog, "groq", { providers: {} })
    expect(catalog.groq?.modelsSource).toBe("catalog")
    expect(catalog.groq?.models["stale-model"]).toBeUndefined()
  })

  test("unconnected provider is left untouched", async () => {
    delete process.env.GROQ_API_KEY
    const catalog = rawGroq("http://127.0.0.1:1")
    await withLiveModels(catalog, "groq", { providers: {} })
    expect(catalog.groq?.modelsSource).toBeUndefined()
    expect(Object.keys(catalog.groq?.models ?? {})).toHaveLength(3)
  })
})

describe("GitHub Copilot plan gating", () => {
  let tmp: string
  let prevCache: string | undefined
  let prevData: string | undefined
  let prevToken: string | undefined
  let server: { stop: (force?: boolean) => void } | undefined

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-copilot-"))
    prevCache = process.env.DAWN_CACHE_DIR
    prevData = process.env.DAWN_DATA_DIR
    prevToken = process.env.GITHUB_COPILOT_TOKEN
    process.env.DAWN_CACHE_DIR = path.join(tmp, "cache")
    process.env.DAWN_DATA_DIR = path.join(tmp, "data")
    process.env.GITHUB_COPILOT_TOKEN = "test-token"
  })

  afterEach(() => {
    server?.stop(true)
    if (prevCache === undefined) delete process.env.DAWN_CACHE_DIR
    else process.env.DAWN_CACHE_DIR = prevCache
    if (prevData === undefined) delete process.env.DAWN_DATA_DIR
    else process.env.DAWN_DATA_DIR = prevData
    if (prevToken === undefined) delete process.env.GITHUB_COPILOT_TOKEN
    else process.env.GITHUB_COPILOT_TOKEN = prevToken
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("drops plan-gated (policy disabled) models, keeps usable ones even when picker-hidden", async () => {
    const s = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          data: [
            { id: "included-model", name: "Included" },
            // model_picker_enabled is a VS Code preference, not entitlement — must be kept.
            {
              id: "picker-hidden",
              name: "Hidden",
              model_picker_enabled: false,
              policy: { state: "enabled" },
            },
            { id: "premium-model", name: "Premium", is_premium: true },
            // policy.state "disabled" is the real plan gate — must be dropped.
            { id: "plan-gated", name: "Gated", policy: { state: "disabled" } },
            { id: "embeddings", name: "Embed", capabilities: { type: "embeddings" } },
          ],
        }),
    })
    server = s
    const baseURL = `http://localhost:${s.port}`
    const catalog: Catalog = {
      "github-copilot": {
        id: "github-copilot",
        name: "GitHub Copilot",
        env: ["GITHUB_COPILOT_TOKEN"],
        api: baseURL,
        models: {},
      },
    }

    await withLiveModels(catalog, "github-copilot", { providers: {} })

    const models = catalog["github-copilot"]?.models ?? {}
    expect(Object.keys(models).sort()).toEqual(["included-model", "picker-hidden", "premium-model"])
    expect(models["premium-model"]?.access).toBe("premium")
    expect(models["included-model"]?.access).toBe("standard")
  })
})
