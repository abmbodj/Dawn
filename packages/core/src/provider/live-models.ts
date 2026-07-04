import fs from "node:fs"
import path from "node:path"
import { accessToken, OAUTH_BETA_HEADER } from "../auth/anthropic-oauth"
import { hasOAuth, resolveApiKey } from "../auth/auth"
import type { DawnConfig } from "../config/config"
import { cacheDir } from "../paths"
import type { Catalog, ModelInfo, ProviderInfo } from "./catalog"
import { FALLBACK_CATALOG } from "./catalog"
import { connectedProviders } from "./provider"

// ---------------------------------------------------------------------------
// Last-known-live cache
//
// The raw models.dev catalog lists models a given API key may not be entitled
// to. Only live per-account probes are trusted for display, so when a probe
// can't run (offline, provider hiccup) we fall back to the last successful
// probe persisted here — never to the raw catalog list. No TTL: this is the
// user's own account data, valid until replaced by the next successful probe.
// ---------------------------------------------------------------------------

type LiveCacheFile = Record<string, { fetchedAt: number; models: Record<string, ModelInfo> }>

function liveCachePath(): string {
  return path.join(cacheDir(), "live-models.json")
}

function readLiveCache(): LiveCacheFile {
  try {
    return JSON.parse(fs.readFileSync(liveCachePath(), "utf8"))
  } catch {
    return {}
  }
}

function writeLiveCache(providerId: string, models: Record<string, ModelInfo>): void {
  try {
    const data = readLiveCache()
    data[providerId] = { fetchedAt: Date.now(), models }
    fs.writeFileSync(liveCachePath(), JSON.stringify(data))
  } catch {
    // best-effort: a failed cache write must never break the boot path
  }
}

/**
 * A connected provider's probe didn't land — replace any raw catalog models
 * with the last-known-live list, or the curated fallback singleton, so the
 * picker never shows models the user's account can't invoke.
 */
function clampProvider(catalog: Catalog, providerId: string): void {
  const p = catalog[providerId]
  if (!p || p.modelsSource === "live" || p.modelsSource === "cached-live") return
  const cached = readLiveCache()[providerId]
  if (cached && Object.keys(cached.models).length > 0) {
    catalog[providerId] = { ...p, modelsSource: "cached-live", models: cached.models }
    return
  }
  // mergeCatalog spreads models.dev models over the fallback, so read the
  // curated list straight from FALLBACK_CATALOG rather than catalog models.
  const fb = FALLBACK_CATALOG[providerId]
  catalog[providerId] = { ...p, modelsSource: "catalog", models: fb ? fb.models : {} }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPerMillion(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined // negative values are API sentinels (e.g. -1 = "variable"), not real prices
  return n * 1_000_000
}

/** Derive access tier from cost. */
function accessFromCost(cost: ModelInfo["cost"]): ModelInfo["access"] {
  if (!cost) return undefined
  if (cost.input === 0 && cost.output === 0) return "free"
  return "standard"
}

/**
 * Merge a freshly-fetched model list into the existing catalog for one provider.
 * The live list decides which IDs are available; the catalog/models.dev values
 * supply pricing, limits, and capability metadata.
 */
function buildProviderModels(
  _providerId: string,
  liveIds: LiveModel[],
  existing: ProviderInfo | undefined,
): ProviderInfo["models"] {
  const models: ProviderInfo["models"] = {}
  for (const live of liveIds) {
    const catalogEntry = existing?.models?.[live.id]
    const cost: ModelInfo["cost"] =
      catalogEntry?.cost !== undefined
        ? catalogEntry.cost
        : live.costInput !== undefined || live.costOutput !== undefined
          ? { input: live.costInput ?? 0, output: live.costOutput ?? 0 }
          : undefined

    models[live.id] = {
      id: live.id,
      name: live.name ?? catalogEntry?.name ?? live.id,
      cost: cost ?? catalogEntry?.cost,
      limit:
        catalogEntry?.limit ??
        (live.contextLength
          ? { context: live.contextLength, output: live.outputLimit ?? undefined }
          : undefined),
      tool_call: catalogEntry?.tool_call ?? live.toolCall ?? true,
      reasoning: catalogEntry?.reasoning ?? live.reasoning,
      access: live.access ?? catalogEntry?.access ?? accessFromCost(cost ?? catalogEntry?.cost),
    }
  }
  return models
}

interface LiveModel {
  id: string
  name?: string
  contextLength?: number
  outputLimit?: number | null
  costInput?: number
  costOutput?: number
  toolCall?: boolean
  reasoning?: boolean
  access?: ModelInfo["access"]
}

// ---------------------------------------------------------------------------
// Provider-specific adapters
// ---------------------------------------------------------------------------

/** Standard OpenAI-compatible /models endpoint: { data: [{ id, … }] } */
async function fetchOpenAICompatible(
  baseURL: string,
  apiKey: string | undefined,
  providerId: string,
  providerHeaders?: Record<string, string>,
): Promise<LiveModel[]> {
  const url = `${baseURL.replace(/\/$/, "")}/models`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Spread provider-specific headers (e.g. Copilot identity headers from catalog).
    ...providerHeaders,
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
  if (!res.ok) return []

  type Raw = {
    data?: Array<{
      id: string
      name?: string
      context_length?: number
      supported_parameters?: string[]
      per_request_limits?: { completion_tokens?: number | null } | null
      pricing?: { prompt?: string | number; completion?: string | number }
      // GitHub Copilot / OpenAI-compatible extended fields
      capabilities?: { supports_tool_calling?: boolean; type?: string }
      billing_type?: string
      policy?: { state?: string }
      is_premium?: boolean
      model_picker_enabled?: boolean
      deprecated?: boolean
    }>
    models?: Array<{ id: string; name?: string }>
  }

  type RawItem = NonNullable<Raw["data"]>[number]
  const data = (await res.json()) as Raw
  const items = (data.data ?? data.models ?? []) as RawItem[]

  return items
    .filter((m) => {
      // Drop models the provider itself marks as disabled, deprecated, or embedding-only.
      if (m.deprecated === true) return false
      if (m.policy?.state === "disabled") return false
      if (m.capabilities?.type === "embeddings") return false
      // Copilot reports plan entitlement per model; false means this account's
      // plan can't invoke it (undefined passes — older accounts omit the field).
      if (providerId === "github-copilot" && m.model_picker_enabled === false) return false
      return true
    })
    .map((m) => {
      const params = (m.supported_parameters ?? []) as string[]
      const costInput = toPerMillion(m.pricing?.prompt)
      const costOutput = toPerMillion(m.pricing?.completion)

      let access: ModelInfo["access"]
      if (providerId === "github-copilot") {
        if (m.is_premium || m.billing_type === "premium") access = "premium"
        else access = "standard"
      } else if (costInput === 0 && costOutput === 0 && costInput !== undefined) {
        access = "free"
      }

      return {
        id: m.id,
        name: m.name,
        contextLength: m.context_length,
        outputLimit: m.per_request_limits?.completion_tokens,
        costInput,
        costOutput,
        toolCall:
          params.length > 0 ? params.includes("tools") : (m.capabilities?.supports_tool_calling ?? undefined),
        reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
        access,
      } satisfies LiveModel
    })
}

/** Anthropic /v1/models: { data: [{ id, display_name, … }] } */
async function fetchAnthropic(auth: { apiKey?: string; bearer?: string }): Promise<LiveModel[]> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" }
  if (auth.bearer) {
    headers.authorization = `Bearer ${auth.bearer}`
    headers["anthropic-beta"] = OAUTH_BETA_HEADER
  } else if (auth.apiKey) {
    headers["x-api-key"] = auth.apiKey
  }
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers,
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return []

  const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> }
  return (data.data ?? []).map((m) => ({
    id: m.id,
    name: m.display_name,
    toolCall: true,
  }))
}

/** Google /v1beta/models: { models: [{ name: "models/gemini-…", displayName, … }] } */
async function fetchGoogle(apiKey: string): Promise<LiveModel[]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return []

  const data = (await res.json()) as {
    models?: Array<{
      name: string
      displayName?: string
      supportedGenerationMethods?: string[]
      inputTokenLimit?: number
      outputTokenLimit?: number
    }>
  }

  return (data.models ?? [])
    .filter((m) => {
      const methods = m.supportedGenerationMethods ?? []
      return methods.includes("generateContent")
    })
    .map((m) => ({
      // "models/gemini-2.5-pro" → "gemini-2.5-pro"
      id: m.name.replace(/^models\//, ""),
      name: m.displayName,
      contextLength: m.inputTokenLimit,
      outputLimit: m.outputTokenLimit,
      toolCall: true,
    }))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Refresh the live model list for a single connected provider.
 * Merges live IDs with catalog metadata; never throws.
 */
export async function withLiveModels(
  catalog: Catalog,
  providerId: string,
  config: DawnConfig,
): Promise<Catalog> {
  const providerInfo = catalog[providerId]
  const custom = config.providers?.[providerId]
  const envNames = [...(custom?.apiKeyEnv ? [custom.apiKeyEnv] : []), ...(providerInfo?.env ?? [])]
  const apiKey = resolveApiKey(providerId, envNames)
  const baseURL = custom?.baseURL ?? providerInfo?.api

  // No credential and the provider requires one: not connected, the picker
  // won't show it — leave the raw catalog data untouched for pricing lookups.
  const requiresKey = envNames.length > 0
  if (!apiKey && requiresKey && !hasOAuth(providerId)) return catalog

  // From here on the provider counts as connected. Every path that doesn't
  // land a live list must clamp so raw catalog models are never displayed.
  try {
    let liveModels: LiveModel[] = []

    if (providerId === "anthropic") {
      if (apiKey) {
        liveModels = await fetchAnthropic({ apiKey })
      } else {
        // OAuth (Claude Pro/Max): /v1/models with a Bearer token is per-account.
        const bearer = await accessToken()
        if (bearer) liveModels = await fetchAnthropic({ bearer })
      }
    } else if (providerId === "google") {
      if (apiKey) liveModels = await fetchGoogle(apiKey)
    } else if (baseURL) {
      const providerHeaders = { ...(providerInfo?.headers ?? {}), ...(custom?.headers ?? {}) }
      liveModels = await fetchOpenAICompatible(baseURL, apiKey, providerId, providerHeaders)
    }

    // Filter to models with tool-call support (or unknown — included optimistically)
    const toolCapable = liveModels.filter((m) => m.toolCall !== false)
    if (toolCapable.length === 0) {
      clampProvider(catalog, providerId)
      return catalog
    }

    const updatedProvider: ProviderInfo = {
      ...(providerInfo ?? FALLBACK_CATALOG[providerId] ?? { id: providerId, name: providerId, models: {} }),
      modelsSource: "live",
      models: buildProviderModels(providerId, toolCapable, providerInfo),
    }

    // Mutate in place (same contract as withOllama) so callers that hold a
    // reference to the catalog object see the update without needing the
    // return value.
    catalog[providerId] = updatedProvider
    writeLiveCache(providerId, updatedProvider.models)
    return catalog
  } catch {
    clampProvider(catalog, providerId)
    return catalog
  }
}

/**
 * Refresh live model lists for every currently-connected provider in parallel.
 */
export async function withAllLiveModels(catalog: Catalog, config: DawnConfig): Promise<Catalog> {
  const connected = connectedProviders(catalog, config)
  // withLiveModels mutates the catalog in place, so parallel calls safely accumulate onto it.
  await Promise.allSettled(connected.map((p) => withLiveModels(catalog, p.id, config)))
  return catalog
}
