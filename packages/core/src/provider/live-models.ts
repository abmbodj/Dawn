import { resolveApiKey } from "../auth/auth"
import type { DawnConfig } from "../config/config"
import type { Catalog, ModelInfo, ProviderInfo } from "./catalog"
import { FALLBACK_CATALOG } from "./catalog"
import { connectedProviders } from "./provider"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPerMillion(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n * 1_000_000 : undefined
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
  providerId: string,
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
      limit: catalogEntry?.limit ?? (live.contextLength ? { context: live.contextLength, output: live.outputLimit ?? undefined } : undefined),
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
async function fetchOpenAICompatible(baseURL: string, apiKey: string | undefined, providerId: string): Promise<LiveModel[]> {
  const url = `${baseURL.replace(/\/$/, "")}/models`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

  // GitHub Copilot requires extra identity headers
  if (providerId === "github-copilot") {
    headers["Copilot-Integration-Id"] = "vscode-chat"
    headers["Editor-Version"] = "vscode/1.95.0"
    headers["Editor-Plugin-Version"] = "copilot-chat/0.22.4"
  }

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
      // GitHub Copilot fields
      capabilities?: { supports_tool_calling?: boolean; type?: string }
      billing_type?: string
      policy?: { state?: string }
      is_premium?: boolean
    }>
    models?: Array<{ id: string; name?: string }>
  }

  type RawItem = NonNullable<Raw["data"]>[number]
  const data = (await res.json()) as Raw
  const items = (data.data ?? data.models ?? []) as RawItem[]

  return items
    .filter((m) => {
      // Skip Copilot models that are disabled by policy or text-only
      if (providerId === "github-copilot") {
        if (m.policy?.state === "disabled") return false
        if (m.capabilities?.type === "embeddings") return false
      }
      return true
    })
    .map((m) => {
      const params = (m.supported_parameters ?? []) as string[]
      const costInput = toPerMillion(m.pricing?.prompt)
      const costOutput = toPerMillion(m.pricing?.completion)

      let access: ModelInfo["access"] = undefined
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
        toolCall: params.length > 0 ? params.includes("tools") : (m.capabilities?.supports_tool_calling ?? undefined),
        reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
        access,
      } satisfies LiveModel
    })
}

/** Anthropic /v1/models: { data: [{ id, display_name, … }] } */
async function fetchAnthropic(apiKey: string): Promise<LiveModel[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
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
export async function withLiveModels(catalog: Catalog, providerId: string, config: DawnConfig): Promise<Catalog> {
  const providerInfo = catalog[providerId]
  const custom = config.providers?.[providerId]
  const envNames = [...(custom?.apiKeyEnv ? [custom.apiKeyEnv] : []), ...(providerInfo?.env ?? [])]
  const apiKey = resolveApiKey(providerId, envNames)
  const baseURL = custom?.baseURL ?? providerInfo?.api

  // Skip if no credential and the provider requires one
  const requiresKey = envNames.length > 0
  if (!apiKey && requiresKey) return catalog
  // Skip if no base URL for OpenAI-compatible providers (non-standard)
  if (providerId !== "anthropic" && providerId !== "google" && !baseURL) return catalog

  try {
    let liveModels: LiveModel[]

    if (providerId === "anthropic") {
      if (!apiKey) return catalog
      liveModels = await fetchAnthropic(apiKey)
    } else if (providerId === "google") {
      if (!apiKey) return catalog
      liveModels = await fetchGoogle(apiKey)
    } else {
      liveModels = await fetchOpenAICompatible(baseURL!, apiKey, providerId)
    }

    if (liveModels.length === 0) return catalog

    // Filter to models with tool-call support (or unknown — included optimistically)
    const toolCapable = liveModels.filter((m) => m.toolCall !== false)
    if (toolCapable.length === 0) return catalog

    const updatedProvider: ProviderInfo = {
      ...(providerInfo ?? FALLBACK_CATALOG[providerId] ?? { id: providerId, name: providerId, models: {} }),
      models: buildProviderModels(providerId, toolCapable, providerInfo),
    }

    // Mutate in place (same contract as withOpenRouter / withOllama) so callers
    // that hold a reference to the catalog object see the update without needing
    // to use the return value.
    catalog[providerId] = updatedProvider
    return catalog
  } catch {
    return catalog
  }
}

/**
 * Refresh live model lists for every currently-connected provider in parallel.
 * Replaces the separate withOpenRouter / withOllama startup calls.
 */
export async function withAllLiveModels(catalog: Catalog, config: DawnConfig): Promise<Catalog> {
  const connected = connectedProviders(catalog, config)
  // withLiveModels mutates the catalog in place, so parallel calls safely accumulate onto it.
  await Promise.allSettled(connected.map((p) => withLiveModels(catalog, p.id, config)))
  return catalog
}
