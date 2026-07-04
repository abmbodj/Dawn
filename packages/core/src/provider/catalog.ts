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
  /**
   * Subscription / billing tier for this model.
   * "free"     — no per-token cost (e.g. OpenRouter :free, Copilot included quota)
   * "standard" — regular paid pricing
   * "premium"  — draws on a premium/add-on quota (e.g. Copilot premium models)
   * Absent means unknown (treat as standard).
   */
  access?: "free" | "standard" | "premium"
}

export interface ProviderInfo {
  id: string
  name: string
  env?: string[]
  npm?: string
  api?: string
  /** Extra HTTP headers sent on every request to this provider (both chat and model listing). */
  headers?: Record<string, string>
  /**
   * Where this provider's model list came from:
   * "live"        — probed from the provider this session (per-account accurate)
   * "cached-live" — last successful probe, loaded from disk (probe failed/offline this session)
   * "catalog"     — curated fallback only; never the raw models.dev list for a connected provider
   * Absent means raw catalog/models.dev data (unconnected providers only).
   */
  modelsSource?: "live" | "cached-live" | "catalog"
  models: Record<string, ModelInfo>
}

export type Catalog = Record<string, ProviderInfo>

/**
 * Whether a model supports prompt caching, inferred from catalog pricing: a `cache_read`
 * rate means the provider bills cached input separately (Anthropic, OpenAI, Google, …).
 * Used to decide how aggressively to inject re-sent context like repo summaries — caching
 * amortizes the per-turn re-send, so cacheable models can afford a more generous share.
 */
export function modelCaches(info?: ModelInfo): boolean {
  return info?.cost?.cache_read != null
}

const CATALOG_URL = "https://models.dev/api.json"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

const LEGACY_MODEL_REFS: Record<string, string> = {
  "groq/llama-4-scout-17b-16e-instruct": "groq/meta-llama/llama-4-scout-17b-16e-instruct",
  "groq/llama-4-maverick-17b-128e-instruct": "groq/meta-llama/llama-4-maverick-17b-128e-instruct",
}

function cachePath(): string {
  return path.join(cacheDir(), "models.json")
}

/**
 * Offline emergency fallback — one stable model per provider.
 * Only used when models.dev is unreachable AND the live-model fetch fails.
 * Provides the api/env fields that models.dev omits so providers stay resolvable.
 * The live fetch (withAllLiveModels) replaces per-provider model lists at runtime.
 */
export const FALLBACK_CATALOG: Catalog = {
  // ── Anthropic ─────────────────────────────────────────────────────────────
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 1_000_000, output: 64_000 },
        tool_call: true,
        access: "standard",
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
      "gpt-5.4-mini": {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        cost: { input: 0.75, output: 4.5, cache_read: 0.075 },
        limit: { context: 400_000, output: 128_000 },
        tool_call: true,
        access: "standard",
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
      "gemini-3.5-flash": {
        id: "gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        cost: { input: 1.5, output: 9, cache_read: 0.15 },
        limit: { context: 1_048_576, output: 65_536 },
        tool_call: true,
        access: "standard",
      },
    },
  },

  // ── GitHub Copilot — default login via OAuth device flow ─────────────────
  "github-copilot": {
    id: "github-copilot",
    name: "GitHub Copilot",
    env: ["GITHUB_COPILOT_TOKEN"],
    api: "https://api.githubcopilot.com",
    headers: {
      "Copilot-Integration-Id": "copilot-4-cli",
      "Editor-Version": "vscode/1.95.0",
      "Editor-Plugin-Version": "copilot-chat/0.22.4",
    },
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 16_384 },
        tool_call: true,
        access: "standard",
      },
    },
  },

  // ── Groq ──────────────────────────────────────────────────────────────────
  groq: {
    id: "groq",
    name: "Groq",
    env: ["GROQ_API_KEY"],
    api: "https://api.groq.com/openai/v1",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B Versatile",
        cost: { input: 0.59, output: 0.79 },
        limit: { context: 128_000, output: 32_768 },
        tool_call: true,
        access: "standard",
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
      "grok-3-mini": {
        id: "grok-3-mini",
        name: "Grok 3 Mini",
        cost: { input: 0.3, output: 0.5 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
        reasoning: true,
        access: "standard",
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
      "mistral-small-latest": {
        id: "mistral-small-latest",
        name: "Mistral Small",
        cost: { input: 0.1, output: 0.3 },
        limit: { context: 128_000, output: 16_384 },
        tool_call: true,
        access: "standard",
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
        access: "standard",
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
      sonar: {
        id: "sonar",
        name: "Sonar",
        cost: { input: 1, output: 1 },
        limit: { context: 200_000, output: 16_384 },
        tool_call: true,
        access: "standard",
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
      "meta-llama/Llama-4-Scout-Instruct-Basic": {
        id: "meta-llama/Llama-4-Scout-Instruct-Basic",
        name: "Llama 4 Scout",
        cost: { input: 0.1, output: 0.1 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
        access: "standard",
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
      "accounts/fireworks/models/llama-4-scout": {
        id: "accounts/fireworks/models/llama-4-scout",
        name: "Llama 4 Scout",
        cost: { input: 0.15, output: 0.6 },
        limit: { context: 131_072, output: 16_384 },
        tool_call: true,
        access: "standard",
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
        access: "standard",
      },
    },
  },

  // ── OpenRouter ────────────────────────────────────────────────────────────
  // One stable paid fallback — withAllLiveModels() replaces this with the full account list.
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
        access: "standard",
      },
    },
  },

  // ── Ollama Cloud ──────────────────────────────────────────────────────────
  "ollama-cloud": {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    env: ["OLLAMA_API_KEY"],
    api: "https://ollama.com/v1",
    models: {
      "llama3.3": {
        id: "llama3.3",
        name: "Llama 3.3",
        tool_call: true,
        access: "standard",
      },
    },
  },

  // ── AWS Bedrock (enterprise gateway) ──────────────────────────────────────
  // Auth via the AWS credential chain (env/profile/SSO) or a Bedrock API key.
  bedrock: {
    id: "bedrock",
    name: "AWS Bedrock",
    env: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_PROFILE"],
    npm: "@ai-sdk/amazon-bedrock",
    models: {
      "anthropic.claude-sonnet-4-6": {
        id: "anthropic.claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (Bedrock)",
        limit: { context: 1_000_000, output: 64_000 },
        tool_call: true,
        access: "standard",
      },
    },
  },

  // ── Google Vertex AI (enterprise gateway) ─────────────────────────────────
  // Auth via Google ADC (GOOGLE_APPLICATION_CREDENTIALS) + a project.
  vertex: {
    id: "vertex",
    name: "Google Vertex AI",
    env: ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_VERTEX_PROJECT"],
    npm: "@ai-sdk/google-vertex",
    models: {
      "gemini-3.5-pro": {
        id: "gemini-3.5-pro",
        name: "Gemini 3.5 Pro (Vertex)",
        limit: { context: 1_048_576, output: 65_536 },
        tool_call: true,
        access: "standard",
      },
    },
  },

  // ── Azure OpenAI (enterprise gateway) ─────────────────────────────────────
  // Auth via AZURE_API_KEY + AZURE_RESOURCE_NAME (or a custom baseURL/deployment).
  azure: {
    id: "azure",
    name: "Azure OpenAI",
    env: ["AZURE_API_KEY"],
    npm: "@ai-sdk/azure",
    models: {
      "gpt-5.5": {
        id: "gpt-5.5",
        name: "GPT-5.5 (Azure)",
        limit: { context: 400_000, output: 128_000 },
        tool_call: true,
        access: "standard",
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

/** Quality tier for a model: hand-curated flagship, viable, or below-floor. */
export type ModelTier = "blessed" | "standard" | "experimental"

/**
 * Hand-curated "blessed" flagships: verified tool-calling, tuned profiles, and
 * regression-tested (`dawn doctor models`). The single source of truth for the
 * Recommended tier and the model-selection preference order. Local models are
 * intentionally never blessed — per-machine quant/hardware variance makes a
 * perfection guarantee impossible.
 */
export const BLESSED_MODELS: ReadonlySet<string> = new Set<string>([
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5.5",
  "openai/gpt-5.4-mini",
  "google/gemini-3.5-pro",
  "google/gemini-3.5-flash",
  // Same blessed flagships over enterprise gateways (different transport/auth).
  "bedrock/anthropic.claude-sonnet-4-6",
  "vertex/gemini-3.5-pro",
  "azure/gpt-5.5",
])

/** Minimum context window (tokens) a model needs to be a viable coding agent. */
export const FLOOR_CONTEXT_TOKENS = 32_000

/**
 * Whether a model clears the capability floor: tool-calling + a coding-viable
 * context window. (Streaming is assumed — every provider Dawn supports streams
 * via the AI SDK; there is no per-model streaming flag to check.) A model with
 * an unknown context window is given the benefit of the doubt, since many live
 * provider listings omit limits; only a *known* too-small window fails.
 */
export function meetsFloor(model: ModelInfo | undefined): boolean {
  if (!model) return false
  if (model.tool_call === false) return false
  const context = model.limit?.context
  if (context !== undefined && context < FLOOR_CONTEXT_TOKENS) return false
  return true
}

/** Tier for a model ref: blessed allowlist → floor-passing standard → experimental. */
export function modelTier(ref: string, model: ModelInfo | undefined): ModelTier {
  if (BLESSED_MODELS.has(normalizeModelRef(ref))) return "blessed"
  return meetsFloor(model) ? "standard" : "experimental"
}
