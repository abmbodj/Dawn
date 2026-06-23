import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FALLBACK_CATALOG } from "../src/provider/catalog"
import { resolveProfile } from "../src/provider/profile"
import { connectedProviders, enterpriseConfigured, resolveModel } from "../src/provider/provider"

const ENTERPRISE_ENV = [
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

let tmp: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-enterprise-"))
  process.env.DAWN_DATA_DIR = path.join(tmp, "data")
  process.env.DAWN_CONFIG_DIR = path.join(tmp, "config")
  process.env.DAWN_CACHE_DIR = path.join(tmp, "cache")
  saved = {}
  for (const k of ENTERPRISE_ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  delete process.env.DAWN_DATA_DIR
  delete process.env.DAWN_CONFIG_DIR
  delete process.env.DAWN_CACHE_DIR
  for (const k of ENTERPRISE_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("enterprise gateways", () => {
  test("are present in the fallback catalog with their model ids", () => {
    expect(FALLBACK_CATALOG.bedrock?.models["anthropic.claude-sonnet-4-6"]).toBeDefined()
    expect(FALLBACK_CATALOG.vertex?.models["gemini-3.5-pro"]).toBeDefined()
    expect(FALLBACK_CATALOG.azure?.models["gpt-5.5"]).toBeDefined()
  })

  test("enterpriseConfigured reflects the credential chain", () => {
    expect(enterpriseConfigured("bedrock")).toBe(false)
    process.env.AWS_PROFILE = "default"
    expect(enterpriseConfigured("bedrock")).toBe(true)

    expect(enterpriseConfigured("vertex")).toBe(false)
    process.env.GOOGLE_VERTEX_PROJECT = "my-proj"
    expect(enterpriseConfigured("vertex")).toBe(true)
  })

  test("resolveModel refuses an unconfigured gateway", () => {
    expect(() =>
      resolveModel("bedrock/anthropic.claude-sonnet-4-6", FALLBACK_CATALOG, { providers: {} }),
    ).toThrow(/not configured/)
  })

  test("resolveModel builds a model once the gateway is configured", () => {
    process.env.AWS_PROFILE = "default"
    process.env.AWS_REGION = "us-east-1"
    const resolved = resolveModel("bedrock/anthropic.claude-sonnet-4-6", FALLBACK_CATALOG, { providers: {} })
    expect(resolved.providerId).toBe("bedrock")
    expect(resolved.modelId).toBe("anthropic.claude-sonnet-4-6")
  })

  test("connectedProviders includes a configured gateway and excludes an unconfigured one", () => {
    expect(connectedProviders(FALLBACK_CATALOG, { providers: {} }).some((p) => p.id === "bedrock")).toBe(
      false,
    )
    process.env.AWS_ACCESS_KEY_ID = "AKIA…"
    expect(connectedProviders(FALLBACK_CATALOG, { providers: {} }).some((p) => p.id === "bedrock")).toBe(true)
  })

  test("Claude via Bedrock keeps native reasoning + caching (profile is family-aware)", () => {
    const p = resolveProfile("bedrock/anthropic.claude-sonnet-4-6", FALLBACK_CATALOG)
    expect(p.family).toBe("claude")
    expect(p.reasoning).toBe("native")
    expect(p.supportsCaching).toBe(true)
  })

  test("Gemini via Vertex strips reasoning and does not use Anthropic caching", () => {
    const p = resolveProfile("vertex/gemini-3.5-pro", FALLBACK_CATALOG)
    expect(p.family).toBe("gemini")
    expect(p.reasoning).toBe("strip")
    expect(p.supportsCaching).toBe(false)
  })
})
