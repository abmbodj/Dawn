import fs from "node:fs"
import path from "node:path"
import { cacheDir } from "../paths"

export interface ModelCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}

export interface ModelInfo {
  id: string
  name: string
  cost?: ModelCost | null
  limit?: { context?: number; output?: number }
  tool_call?: boolean
  reasoning?: boolean
  release_date?: string
}

export interface ProviderInfo {
  id: string
  name: string
  env?: string[]
  npm?: string
  api?: string
  models: Record<string, ModelInfo>
}

export type Catalog = Record<string, ProviderInfo>

const CATALOG_URL = "https://models.dev/api.json"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

function cachePath(): string {
  return path.join(cacheDir(), "models.json")
}

/** Minimal embedded catalog so first runs work offline. Prices are USD per 1M tokens. */
export const FALLBACK_CATALOG: Catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1_000_000, output: 128_000 },
        tool_call: true,
      },
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 1_000_000, output: 64_000 },
        tool_call: true,
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
        limit: { context: 200_000, output: 64_000 },
        tool_call: true,
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-5.5": {
        id: "gpt-5.5",
        name: "GPT-5.5",
        cost: { input: 5, output: 30, cache_read: 0.5 },
        limit: { context: 1_050_000, output: 128_000 },
        tool_call: true,
      },
      "gpt-5.4-mini": {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        cost: { input: 0.75, output: 4.5, cache_read: 0.075 },
        limit: { context: 400_000, output: 128_000 },
        tool_call: true,
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    npm: "@ai-sdk/google",
    models: {
      "gemini-3.5-flash": {
        id: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        cost: { input: 1.5, output: 9, cache_read: 0.15 },
        limit: { context: 1_048_576, output: 65_536 },
        tool_call: true,
      },
    },
  },
}

function readCache(maxAgeMs: number | null): Catalog | undefined {
  try {
    const stat = fs.statSync(cachePath())
    if (maxAgeMs !== null && Date.now() - stat.mtimeMs > maxAgeMs) return undefined
    return JSON.parse(fs.readFileSync(cachePath(), "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Load the models.dev catalog: fresh disk cache → network → stale cache → embedded fallback.
 * Never throws; the agent must boot offline.
 */
export async function loadCatalog(opts: { refresh?: boolean } = {}): Promise<Catalog> {
  if (!opts.refresh) {
    const fresh = readCache(CACHE_TTL_MS)
    if (fresh) return fresh
  }
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Catalog
    fs.writeFileSync(cachePath(), JSON.stringify(data))
    return data
  } catch {
    return readCache(null) ?? FALLBACK_CATALOG
  }
}

/** "anthropic/claude-opus-4-8" → { providerId, modelId } */
export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const slash = ref.indexOf("/")
  if (slash === -1) throw new Error(`Invalid model "${ref}" — expected "provider/model"`)
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

export function getModelInfo(catalog: Catalog, ref: string): ModelInfo | undefined {
  const { providerId, modelId } = parseModelRef(ref)
  return catalog[providerId]?.models?.[modelId]
}
