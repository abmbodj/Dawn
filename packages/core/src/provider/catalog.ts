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
  /** On-disk size in bytes (local providers only); used for the RAM-fit guard. */
  sizeBytes?: number
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

const LEGACY_MODEL_REFS: Record<string, string> = {
  "groq/llama-4-scout-17b-16e-instruct": "groq/meta-llama/llama-4-scout-17b-16e-instruct",
  "groq/llama-4-maverick-17b-128e-instruct": "groq/meta-llama/llama-4-maverick-17b-128e-instruct",
}

function cachePath(): string {
  return path.join(cacheDir(), "models.json")
}

/** Embedded catalog — prices USD/1M tokens. Updated when models.dev is reachable. */
export const FALLBACK_CATALOG: Catalog = {
  // ── Anthropic ─────────────────────────────────────────────────────────────
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-fable-5": {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        cost: { input: 0, output: 0 },
        limit: { context: 1_000_000, output: 128_000 },
        tool_call: true,
        reasoning: true,
      },
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1_000_000, output: 128_000 },
        tool_call: true,
        reasoning: true,
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

  // ── OpenAI ────────────────────────────────────────────────────────────────
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
      o3: {
        id: "o3",
        name: "o3",
        cost: { input: 10, output: 40, cache_read: 1 },
        limit: { context: 200_000, output: 100_000 },
        tool_call: true,
        reasoning: true,
      },
      "o4-mini": {
        id: "o4-mini",
        name: "o4-mini",
        cost: { input: 1.25, output: 5, cache_read: 0.125 },
        limit: { context: 200_000, output: 100_000 },
        tool_call: true,
        reasoning: true,
      },
    },
  },

  // ── Google ────────────────────────────────────────────────────────────────
  google: {
    id: "google",
    name: "Google",
    env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    npm: "@ai-sdk/google",
    models: {
      "gemini-3.5-pro": {
        id: "gemini-3.5-pro",
        name: "Gemini 3.5 Pro",
        cost: { input: 3.5, output: 10.5, cache_read: 0.35 },
        limit: { context: 1_048_576, output: 65_536 },
        tool_call: true,
      },
      "gemini-3.5-flash": {
        id: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        cost: { input: 1.5, output: 9, cache_read: 0.15 },
        limit: { context: 1_048_576, output: 65_536 },
        tool_call: true,
      },
    },
  },

  // ── Groq — free tier, recommended for first-run ───────────────────────────
  groq: {
    id: "groq",
    name: "Groq",
    env: ["GROQ_API_KEY"],
    api: "https://api.groq.com/openai/v1",
    models: {
      "meta-llama/llama-4-scout-17b-16e-instruct": {
        id: "meta-llama/llama-4-scout-17b-16e-instruct",
        name: "Llama 4 Scout",
        cost: { input: 0.11, output: 0.34 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
      "meta-llama/llama-4-maverick-17b-128e-instruct": {
        id: "meta-llama/llama-4-maverick-17b-128e-instruct",
        name: "Llama 4 Maverick",
        cost: { input: 0.2, output: 0.6 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
      "qwen-qwq-32b": {
        id: "qwen-qwq-32b",
        name: "Qwen QwQ 32B",
        cost: { input: 0.29, output: 0.39 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
        reasoning: true,
      },
    },
  },

  // ── xAI ───────────────────────────────────────────────────────────────────
  xai: {
    id: "xai",
    name: "xAI",
    env: ["XAI_API_KEY"],
    api: "https://api.x.ai/v1",
    models: {
      "grok-3": {
        id: "grok-3",
        name: "Grok 3",
        cost: { input: 3, output: 15 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
      "grok-3-mini": {
        id: "grok-3-mini",
        name: "Grok 3 Mini",
        cost: { input: 0.3, output: 0.5 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
        reasoning: true,
      },
      "grok-3-fast": {
        id: "grok-3-fast",
        name: "Grok 3 Fast",
        cost: { input: 5, output: 25 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
    },
  },

  // ── Mistral ───────────────────────────────────────────────────────────────
  mistral: {
    id: "mistral",
    name: "Mistral",
    env: ["MISTRAL_API_KEY"],
    api: "https://api.mistral.ai/v1",
    models: {
      "mistral-large-latest": {
        id: "mistral-large-latest",
        name: "Mistral Large",
        cost: { input: 2, output: 6 },
        limit: { context: 128_000, output: 16_384 },
        tool_call: true,
      },
      "codestral-latest": {
        id: "codestral-latest",
        name: "Codestral",
        cost: { input: 0.3, output: 0.9 },
        limit: { context: 256_000, output: 32_768 },
        tool_call: true,
      },
      "mistral-small-latest": {
        id: "mistral-small-latest",
        name: "Mistral Small",
        cost: { input: 0.1, output: 0.3 },
        limit: { context: 128_000, output: 16_384 },
        tool_call: true,
      },
    },
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    api: "https://api.deepseek.com/v1",
    models: {
      "deepseek-chat": {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        cost: { input: 0.27, output: 1.1 },
        limit: { context: 128_000, output: 16_384 },
        tool_call: true,
      },
      "deepseek-reasoner": {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        cost: { input: 0.55, output: 2.19 },
        limit: { context: 128_000, output: 16_384 },
        tool_call: true,
        reasoning: true,
      },
    },
  },

  // ── Perplexity ────────────────────────────────────────────────────────────
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    env: ["PERPLEXITY_API_KEY"],
    api: "https://api.perplexity.ai",
    models: {
      "sonar-pro": {
        id: "sonar-pro",
        name: "Sonar Pro",
        cost: { input: 3, output: 15 },
        limit: { context: 200_000, output: 16_384 },
        tool_call: true,
      },
      sonar: {
        id: "sonar",
        name: "Sonar",
        cost: { input: 1, output: 1 },
        limit: { context: 200_000, output: 16_384 },
        tool_call: true,
      },
      "sonar-reasoning-pro": {
        id: "sonar-reasoning-pro",
        name: "Sonar Reasoning Pro",
        cost: { input: 2, output: 8 },
        limit: { context: 200_000, output: 16_384 },
        tool_call: true,
        reasoning: true,
      },
    },
  },

  // ── Together AI ───────────────────────────────────────────────────────────
  together: {
    id: "together",
    name: "Together AI",
    env: ["TOGETHER_API_KEY"],
    api: "https://api.together.xyz/v1",
    models: {
      "meta-llama/Llama-4-Maverick-Instruct-Basic": {
        id: "meta-llama/Llama-4-Maverick-Instruct-Basic",
        name: "Llama 4 Maverick",
        cost: { input: 0.27, output: 0.27 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
      "meta-llama/Llama-4-Scout-Instruct-Basic": {
        id: "meta-llama/Llama-4-Scout-Instruct-Basic",
        name: "Llama 4 Scout",
        cost: { input: 0.1, output: 0.1 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
      "deepseek-ai/DeepSeek-V3": {
        id: "deepseek-ai/DeepSeek-V3",
        name: "DeepSeek V3",
        cost: { input: 1.25, output: 1.25 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
    },
  },

  // ── Fireworks ─────────────────────────────────────────────────────────────
  fireworks: {
    id: "fireworks",
    name: "Fireworks AI",
    env: ["FIREWORKS_API_KEY"],
    api: "https://api.fireworks.ai/inference/v1",
    models: {
      "accounts/fireworks/models/llama-4-maverick": {
        id: "accounts/fireworks/models/llama-4-maverick",
        name: "Llama 4 Maverick",
        cost: { input: 0.22, output: 0.88 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
      "accounts/fireworks/models/llama-4-scout": {
        id: "accounts/fireworks/models/llama-4-scout",
        name: "Llama 4 Scout",
        cost: { input: 0.15, output: 0.6 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
      "accounts/fireworks/models/deepseek-v3": {
        id: "accounts/fireworks/models/deepseek-v3",
        name: "DeepSeek V3",
        cost: { input: 0.9, output: 0.9 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
    },
  },

  // ── Cerebras ──────────────────────────────────────────────────────────────
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    env: ["CEREBRAS_API_KEY"],
    api: "https://api.cerebras.ai/v1",
    models: {
      "llama-4-scout": {
        id: "llama-4-scout",
        name: "Llama 4 Scout",
        cost: { input: 0.1, output: 0.1 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
      "llama3.1-70b": {
        id: "llama3.1-70b",
        name: "Llama 3.1 70B",
        cost: { input: 0.6, output: 0.6 },
        limit: { context: 128_000, output: 16_384 },
        tool_call: true,
      },
    },
  },

  // ── OpenRouter ────────────────────────────────────────────────────────────
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    api: "https://openrouter.ai/api/v1",
    models: {
      "meta-llama/llama-4-maverick": {
        id: "meta-llama/llama-4-maverick",
        name: "Llama 4 Maverick",
        cost: { input: 0.18, output: 0.59 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
      },
      "google/gemini-2.5-pro-preview": {
        id: "google/gemini-2.5-pro-preview",
        name: "Gemini 2.5 Pro",
        cost: { input: 1.25, output: 10 },
        limit: { context: 1_048_576, output: 65_536 },
        tool_call: true,
      },
      "anthropic/claude-opus-4-8": {
        id: "anthropic/claude-opus-4-8",
        name: "Claude Opus 4.8",
        cost: { input: 5, output: 25 },
        limit: { context: 1_000_000, output: 128_000 },
        tool_call: true,
      },
    },
  },

  // Ollama is intentionally not static here — it's injected at runtime by
  // withOllama() only when an actual local server is detected (see provider/ollama.ts).
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

export function normalizeModelRef(ref: string): string {
  return LEGACY_MODEL_REFS[ref] ?? ref
}

function parseRawModelRef(ref: string): { providerId: string; modelId: string } {
  const slash = ref.indexOf("/")
  if (slash === -1) throw new Error(`Invalid model "${ref}" — expected "provider/model"`)
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

function normalizeProviderModels(
  providerId: string,
  models: Record<string, ModelInfo>,
): Record<string, ModelInfo> {
  if (providerId !== "groq") return models

  const normalized: Record<string, ModelInfo> = { ...models }
  for (const [legacyRef, canonicalRef] of Object.entries(LEGACY_MODEL_REFS)) {
    const legacyModelId = parseRawModelRef(legacyRef).modelId
    const canonicalModelId = parseRawModelRef(canonicalRef).modelId
    const legacyInfo = normalized[legacyModelId]

    if (legacyInfo && !normalized[canonicalModelId]) {
      normalized[canonicalModelId] = { ...legacyInfo, id: canonicalModelId }
    }
    delete normalized[legacyModelId]
  }
  return normalized
}

// models.dev omits provider-level fields like `api` (baseURL) and `env` that the FALLBACK_CATALOG
// carries. Overlay the fallback values so built-in providers are always resolvable.
function mergeCatalog(fetched: Catalog): Catalog {
  const result: Catalog = { ...fetched }
  for (const [id, fallback] of Object.entries(FALLBACK_CATALOG)) {
    const existing = result[id]
    if (!existing) {
      result[id] = fallback
    } else {
      result[id] = {
        ...existing,
        api: existing.api ?? fallback.api,
        env: existing.env ?? fallback.env,
        npm: existing.npm ?? fallback.npm,
        models: normalizeProviderModels(id, { ...fallback.models, ...existing.models }),
      }
    }
  }
  return result
}

/**
 * Load the models.dev catalog: fresh disk cache → network → stale cache → embedded fallback.
 * Never throws; the agent must boot offline.
 */
export async function loadCatalog(opts: { refresh?: boolean } = {}): Promise<Catalog> {
  if (!opts.refresh) {
    const fresh = readCache(CACHE_TTL_MS)
    if (fresh) return mergeCatalog(fresh)
  }
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Catalog
    fs.writeFileSync(cachePath(), JSON.stringify(data))
    return mergeCatalog(data)
  } catch {
    const stale = readCache(null)
    return stale ? mergeCatalog(stale) : FALLBACK_CATALOG
  }
}

/** "anthropic/claude-opus-4-8" → { providerId, modelId } */
export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  return parseRawModelRef(normalizeModelRef(ref))
}

export function getModelInfo(catalog: Catalog, ref: string): ModelInfo | undefined {
  const { providerId, modelId } = parseModelRef(ref)
  return catalog[providerId]?.models?.[modelId]
}
