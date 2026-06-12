import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"
import { resolveApiKey } from "../auth/auth"
import type { DawnConfig } from "../config/config"
import { type Catalog, type ModelInfo, parseModelRef } from "./catalog"

export interface ResolvedModel {
  model: LanguageModel
  providerId: string
  modelId: string
  info: ModelInfo | undefined
}

export function resolveModel(ref: string, catalog: Catalog, config: DawnConfig): ResolvedModel {
  const { providerId, modelId } = parseModelRef(ref)
  const providerInfo = catalog[providerId]
  const custom = config.providers?.[providerId]
  const envNames = [
    ...(custom?.apiKeyEnv ? [custom.apiKeyEnv] : []),
    ...(providerInfo?.env ?? []),
  ]
  const apiKey = resolveApiKey(providerId, envNames)

  // A provider requires a key if it declares env vars. Key-free providers (Ollama, local) have no env entries.
  const requiresKey = envNames.length > 0
  if (!apiKey && requiresKey) {
    const hint = envNames[0] ? ` or set ${envNames[0]}` : ""
    throw new Error(`No API key for "${providerId}". Run \`dawn auth login ${providerId}\`${hint}.`)
  }

  let model: LanguageModel
  switch (providerId) {
    case "anthropic":
      model = createAnthropic({ apiKey })(modelId)
      break
    case "openai":
      model = createOpenAI({ apiKey })(modelId)
      break
    case "google":
      model = createGoogleGenerativeAI({ apiKey })(modelId)
      break
    default: {
      const baseURL = custom?.baseURL ?? providerInfo?.api
      if (!baseURL) {
        throw new Error(
          `Unknown provider "${providerId}". Add it to dawn.json under "providers" with a baseURL.`,
        )
      }
      model = createOpenAICompatible({ name: providerId, baseURL, apiKey })(modelId)
    }
  }

  return { model, providerId, modelId, info: providerInfo?.models?.[modelId] }
}

export interface ProviderStatus {
  id: string
  name: string
  hasKey: boolean
  /** For key-free local providers (Ollama), true means reachable without auth */
  local: boolean
}

/** Providers usable right now (key present or no key required), for the /model picker. */
export function connectedProviders(catalog: Catalog, config: DawnConfig): ProviderStatus[] {
  const ids = new Set([...Object.keys(catalog), ...Object.keys(config.providers ?? {})])
  const result: ProviderStatus[] = []
  for (const id of ids) {
    const info = catalog[id]
    const custom = config.providers?.[id]
    const envNames = [...(custom?.apiKeyEnv ? [custom.apiKeyEnv] : []), ...(info?.env ?? [])]
    const hasKey = resolveApiKey(id, envNames) !== undefined
    const requiresKey = envNames.length > 0
    const baseURL = custom?.baseURL ?? info?.api
    // Connected if: has a key, OR is a key-free provider with a known endpoint
    if (hasKey || (!requiresKey && baseURL)) {
      result.push({ id, name: custom?.name ?? info?.name ?? id, hasKey, local: !requiresKey })
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}
