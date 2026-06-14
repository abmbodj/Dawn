import type { Catalog, ProviderInfo } from "./catalog"

export function lmStudioBaseURL(): string {
  const raw = process.env.LMSTUDIO_HOST?.trim().replace(/\/+$/, "")
  if (!raw) return "http://localhost:1234"
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw
  return `http://${raw}`
}

/**
 * Probe a local LM Studio server. Returns a ProviderInfo populated with the
 * loaded models, or undefined if LM Studio isn't reachable / has no models.
 * Fast: localhost connection-refused returns immediately; capped at 600ms.
 */
export async function detectLMStudio(): Promise<ProviderInfo | undefined> {
  const base = lmStudioBaseURL()
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(600) })
    if (!res.ok) return undefined
    const data = (await res.json()) as { data?: Array<{ id: string }> }
    const items = data.data ?? []
    if (items.length === 0) return undefined
    const models: ProviderInfo["models"] = {}
    for (const m of items) {
      models[m.id] = { id: m.id, name: m.id, cost: null, tool_call: true }
    }
    return { id: "lmstudio", name: "LM Studio (local)", env: [], api: `${base}/v1`, models }
  } catch {
    return undefined
  }
}

/** Overwrite any stale lmstudio entry with a freshly-probed one (or remove it). */
export async function withLMStudio(catalog: Catalog): Promise<Catalog> {
  delete catalog.lmstudio
  const info = await detectLMStudio()
  if (info) catalog.lmstudio = info
  return catalog
}
