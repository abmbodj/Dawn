import type { Catalog, ProviderInfo } from "./catalog"

/** Default endpoint; OLLAMA_HOST overrides (accepts "host:port" or a full URL). */
export function ollamaBaseURL(): string {
  const raw = process.env.OLLAMA_HOST?.trim().replace(/\/+$/, "")
  if (!raw) return "http://localhost:11434"
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw
  return `http://${raw}`
}

interface OllamaTag {
  name: string
  size?: number
}

/**
 * Probe a local Ollama server. Returns a ProviderInfo populated with the
 * actually-installed models, or undefined if Ollama isn't reachable / has no models.
 * Fast: localhost connection-refused returns immediately; capped at 600ms.
 */
export async function detectOllama(): Promise<ProviderInfo | undefined> {
  const base = ollamaBaseURL()
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(600) })
    if (!res.ok) return undefined
    const data = (await res.json()) as { models?: OllamaTag[] }
    const tags = data.models ?? []
    if (tags.length === 0) return undefined
    const models: ProviderInfo["models"] = {}
    for (const t of tags) {
      // tool_call optimistic: /api/tags doesn't report tool support; the user can switch.
      models[t.name] = { id: t.name, name: t.name, cost: null, tool_call: true, sizeBytes: t.size }
    }
    return { id: "ollama", name: "Ollama (local)", env: [], api: `${base}/v1`, models }
  } catch {
    return undefined
  }
}

/** Overwrite any stale ollama entry with a freshly-probed one (or remove it). */
export async function withOllama(catalog: Catalog): Promise<Catalog> {
  delete catalog.ollama
  const info = await detectOllama()
  if (info) catalog.ollama = info
  return catalog
}
