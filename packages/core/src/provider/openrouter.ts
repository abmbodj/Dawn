import { resolveApiKey } from "../auth/auth"
import type { Catalog, ModelInfo, ProviderInfo } from "./catalog"

interface OpenRouterModel {
  id: string
  name: string
  context_length?: number
  pricing?: {
    prompt?: string
    completion?: string
  }
  per_request_limits?: {
    completion_tokens?: number | null
  } | null
  supported_parameters?: string[]
}

function toPerMillion(raw: string | undefined): number | undefined {
  const n = Number(raw)
  return Number.isFinite(n) ? n * 1_000_000 : undefined
}

/**
 * Fetch all models from OpenRouter and inject them into the catalog.
 * Requires OPENROUTER_API_KEY to be present; silently skips if not.
 * Never throws — the agent must boot even if this fails.
 */
export async function withOpenRouter(catalog: Catalog): Promise<Catalog> {
  const apiKey = resolveApiKey("openrouter", ["OPENROUTER_API_KEY"])
  if (!apiKey) return catalog

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return catalog

    const data = (await res.json()) as { data?: OpenRouterModel[] }
    const models: ProviderInfo["models"] = {}

    for (const m of data.data ?? []) {
      const input = toPerMillion(m.pricing?.prompt)
      const output = toPerMillion(m.pricing?.completion)
      const params = m.supported_parameters ?? []

      const cost: ModelInfo["cost"] =
        input !== undefined || output !== undefined ? { input: input ?? 0, output: output ?? 0 } : undefined

      const info: ModelInfo = {
        id: m.id,
        name: m.name,
        cost,
        tool_call: params.includes("tools"),
        reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
      }
      if (m.context_length) {
        info.limit = { context: m.context_length }
        const outLimit = m.per_request_limits?.completion_tokens
        if (outLimit) info.limit.output = outLimit
      }
      models[m.id] = info
    }

    if (Object.keys(models).length > 0) {
      catalog.openrouter = {
        id: "openrouter",
        name: "OpenRouter",
        env: ["OPENROUTER_API_KEY"],
        api: "https://openrouter.ai/api/v1",
        models,
      }
    }
  } catch {
    // network error — leave static fallback intact
  }

  return catalog
}
