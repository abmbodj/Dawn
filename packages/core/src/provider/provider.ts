import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"
import { resolveApiKey } from "../auth/auth"
import type { CustomProvider, DawnConfig } from "../config/config"
import { type Catalog, type ModelInfo, normalizeModelRef, parseModelRef } from "./catalog"

export interface ResolvedModel {
  model: LanguageModel
  providerId: string
  modelId: string
  info: ModelInfo | undefined
}

/** Enterprise gateways authenticate via cloud credential chains, not a single Dawn key. */
export const ENTERPRISE_PROVIDERS = new Set(["bedrock", "vertex", "azure"])

const firstEnv = (...names: string[]): string | undefined => names.map((n) => process.env[n]).find(Boolean)

/**
 * Whether an enterprise gateway is configured enough to use. These don't fit the
 * "single API key" model: Bedrock uses the AWS credential chain (or a Bedrock API
 * key), Vertex uses Google ADC + a project, Azure uses an API key + resource.
 */
export function enterpriseConfigured(providerId: string): boolean {
  switch (providerId) {
    case "bedrock":
      return !!firstEnv("AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_PROFILE")
    case "vertex":
      return !!firstEnv("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT")
    case "azure":
      return resolveApiKey("azure", ["AZURE_API_KEY"]) !== undefined
    default:
      return false
  }
}

/** Build a model for an enterprise gateway, each with its own credential model. */
function resolveEnterpriseModel(
  providerId: string,
  modelId: string,
  info: ModelInfo | undefined,
  custom: CustomProvider | undefined,
): ResolvedModel {
  // These SDKs construct lazily and wouldn't fail until request time; refuse an
  // unconfigured gateway up front so it's never offered as a usable fallback.
  if (!enterpriseConfigured(providerId)) {
    const hint =
      providerId === "bedrock"
        ? "configure AWS credentials (AWS_PROFILE / AWS_ACCESS_KEY_ID, or AWS_BEARER_TOKEN_BEDROCK)"
        : providerId === "vertex"
          ? "configure Google ADC (GOOGLE_APPLICATION_CREDENTIALS) and GOOGLE_VERTEX_PROJECT"
          : "set AZURE_API_KEY (and AZURE_RESOURCE_NAME or a baseURL)"
    throw new Error(`${providerId} is not configured — ${hint}.`)
  }

  let model: LanguageModel
  if (providerId === "bedrock") {
    const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK
    const region = firstEnv("AWS_REGION", "AWS_DEFAULT_REGION")
    // No args → SDK resolves the standard AWS credential chain (env/profile/SSO).
    model = createAmazonBedrock({ ...(apiKey ? { apiKey } : {}), ...(region ? { region } : {}) })(modelId)
  } else if (providerId === "vertex") {
    const project = firstEnv("GOOGLE_VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT")
    const location = firstEnv("GOOGLE_VERTEX_LOCATION", "GOOGLE_CLOUD_LOCATION") ?? "us-central1"
    model = createVertex({ ...(project ? { project } : {}), location })(modelId)
  } else {
    // azure
    const apiKey = resolveApiKey("azure", ["AZURE_API_KEY"])
    if (!apiKey) {
      throw new Error("Azure needs AZURE_API_KEY (set it or run `dawn auth login azure`).")
    }
    const resourceName = process.env.AZURE_RESOURCE_NAME
    const baseURL = custom?.baseURL
    model = createAzure({
      apiKey,
      ...(resourceName ? { resourceName } : {}),
      ...(baseURL ? { baseURL } : {}),
    })(modelId)
  }
  return { model, providerId, modelId, info }
}

export function resolveModel(ref: string, catalog: Catalog, config: DawnConfig): ResolvedModel {
  ref = normalizeModelRef(ref)
  const { providerId, modelId } = parseModelRef(ref)
  const providerInfo = catalog[providerId]
  const custom = config.providers?.[providerId]

  if (ENTERPRISE_PROVIDERS.has(providerId)) {
    return resolveEnterpriseModel(providerId, modelId, providerInfo?.models?.[modelId], custom)
  }

  const envNames = [...(custom?.apiKeyEnv ? [custom.apiKeyEnv] : []), ...(providerInfo?.env ?? [])]
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
      // Merge catalog headers + user-configured headers (user config wins on conflict).
      const headers = { ...(providerInfo?.headers ?? {}), ...(custom?.headers ?? {}) }
      // Keyless local endpoints (Ollama) still want a well-formed Authorization
      // header; a harmless placeholder is ignored by servers that don't need a key.
      model = createOpenAICompatible({
        name: providerId,
        baseURL,
        apiKey: apiKey ?? "ollama",
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      })(modelId)
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

    // Enterprise gateways authenticate via a cloud credential chain, not a Dawn key.
    if (ENTERPRISE_PROVIDERS.has(id)) {
      if (enterpriseConfigured(id)) {
        result.push({ id, name: custom?.name ?? info?.name ?? id, hasKey: true, local: false })
      }
      continue
    }

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
