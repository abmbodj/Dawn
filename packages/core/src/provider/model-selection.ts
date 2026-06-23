import type { DawnConfig } from "../config/config"
import type { Catalog, ModelInfo } from "./catalog"
import { BLESSED_MODELS, normalizeModelRef, parseModelRef } from "./catalog"
import { connectedProviders, type ProviderStatus } from "./provider"

export type ModelSelectionReason = "requested" | "configured" | "repaired" | "connected" | "provider"

export interface ModelSelection {
  ref: string
  reason: ModelSelectionReason
  repairedFrom?: string
}

export interface SelectInitialModelOptions {
  /** Explicit CLI/model-picker override. It is returned without validation. */
  requestedModel?: string
}

const PREFERRED_MODELS: Array<[string, string[]]> = [
  ["github-copilot", ["gpt-4o", "claude-opus-4", "claude-3.5-sonnet", "gpt-4o-mini"]],
  ["openrouter", ["deepseek/deepseek-chat-v3-0324:free", "meta-llama/llama-4-maverick"]],
  ["anthropic", ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]],
  ["openai", ["gpt-5.5", "gpt-5.4-mini", "gpt-4o"]],
  ["google", ["gemini-3.5-pro", "gemini-3.5-flash"]],
  ["groq", ["qwen/qwen3-32b", "meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.3-70b-versatile"]],
  ["xai", ["grok-3", "grok-3-mini"]],
  ["mistral", ["mistral-large-latest", "mistral-small-latest"]],
  ["deepseek", ["deepseek-chat"]],
]

function isLiveProvider(catalog: Catalog, providerId: string): boolean {
  return catalog[providerId]?.modelsSource === "live"
}

function connectedProvider(
  catalog: Catalog,
  config: DawnConfig,
  providerId: string,
): ProviderStatus | undefined {
  return connectedProviders(catalog, config).find((provider) => provider.id === providerId)
}

function isToolCapable(model: ModelInfo | undefined): model is ModelInfo {
  return model !== undefined && model.tool_call !== false
}

/** Blessed model ids for a provider, derived from the BLESSED_MODELS allowlist. */
function blessedModelIds(providerId: string): string[] {
  const ids: string[] = []
  for (const ref of BLESSED_MODELS) {
    const { providerId: p, modelId } = parseModelRef(ref)
    if (p === providerId) ids.push(modelId)
  }
  return ids
}

/**
 * Preference order for a provider's models: blessed ids first (authoritative,
 * derived from BLESSED_MODELS so the two can't drift), then the hand-tuned
 * breadth list for providers/models that aren't blessed.
 */
function preferredModelIds(providerId: string): string[] {
  const hand = PREFERRED_MODELS.find(([id]) => id === providerId)?.[1] ?? []
  const blessed = blessedModelIds(providerId)
  return [...blessed, ...hand.filter((id) => !blessed.includes(id))]
}

function firstUsableModelId(providerId: string, catalog: Catalog): string | undefined {
  const models = catalog[providerId]?.models ?? {}
  for (const id of preferredModelIds(providerId)) {
    if (isToolCapable(models[id])) return id
  }
  return Object.values(models).find(isToolCapable)?.id
}

function orderedConnectedProviders(catalog: Catalog, config: DawnConfig): ProviderStatus[] {
  const connected = connectedProviders(catalog, config)
  const byId = new Map(connected.map((provider) => [provider.id, provider]))
  const ordered: ProviderStatus[] = []

  for (const [providerId] of PREFERRED_MODELS) {
    const provider = byId.get(providerId)
    if (provider) {
      ordered.push(provider)
      byId.delete(providerId)
    }
  }

  ordered.push(...byId.values())
  return ordered
}

export function isUsableModelRef(ref: string, catalog: Catalog, config: DawnConfig): boolean {
  let providerId: string
  let modelId: string
  try {
    const parsed = parseModelRef(ref)
    providerId = parsed.providerId
    modelId = parsed.modelId
  } catch {
    return false
  }

  if (!isLiveProvider(catalog, providerId)) return false
  if (!connectedProvider(catalog, config, providerId)) return false
  return isToolCapable(catalog[providerId]?.models?.[modelId])
}

export function selectProviderInitialModel(
  providerId: string,
  catalog: Catalog,
  config: DawnConfig,
): ModelSelection | undefined {
  if (!isLiveProvider(catalog, providerId)) return undefined
  if (!connectedProvider(catalog, config, providerId)) return undefined

  const modelId = firstUsableModelId(providerId, catalog)
  return modelId ? { ref: `${providerId}/${modelId}`, reason: "provider" } : undefined
}

function selectConnectedCloudModel(
  catalog: Catalog,
  config: DawnConfig,
  skipProviderId?: string,
): ModelSelection | undefined {
  for (const provider of orderedConnectedProviders(catalog, config)) {
    if (provider.id === skipProviderId || provider.local) continue
    const selection = selectProviderInitialModel(provider.id, catalog, config)
    if (selection) return { ...selection, reason: "connected" }
  }
  return undefined
}

export function selectInitialModel(
  catalog: Catalog,
  config: DawnConfig,
  options: SelectInitialModelOptions = {},
): ModelSelection | undefined {
  if (options.requestedModel) {
    return { ref: options.requestedModel, reason: "requested" }
  }

  if (config.model) {
    const configured = normalizeModelRef(config.model)
    if (isUsableModelRef(configured, catalog, config)) {
      return { ref: configured, reason: "configured" }
    }

    let providerId: string | undefined
    try {
      providerId = parseModelRef(configured).providerId
    } catch {
      providerId = undefined
    }

    if (providerId) {
      const sameProvider = selectProviderInitialModel(providerId, catalog, config)
      if (sameProvider) {
        return { ...sameProvider, reason: "repaired", repairedFrom: configured }
      }
    }

    const replacement = selectConnectedCloudModel(catalog, config, providerId)
    return replacement ? { ...replacement, reason: "repaired", repairedFrom: configured } : undefined
  }

  return selectConnectedCloudModel(catalog, config)
}
