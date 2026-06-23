import { localModelFit } from "./local-fit"
import { ollamaBaseURL } from "./ollama"

export interface LocalModelRec {
  /** Ollama model tag to pull, e.g. "qwen2.5-coder:7b". */
  model: string
  label: string
  /** Approximate download / resident size in bytes (Q4 quant). */
  sizeBytes: number
}

/**
 * Vetted local coding models that support tool-calling, smallest → largest.
 * Used to recommend a sensible default sized to the user's RAM.
 */
export const RECOMMENDED_LOCAL_MODELS: LocalModelRec[] = [
  { model: "qwen2.5-coder:3b", label: "Qwen2.5 Coder 3B", sizeBytes: 1_900_000_000 },
  { model: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", sizeBytes: 4_700_000_000 },
  { model: "qwen2.5-coder:14b", label: "Qwen2.5 Coder 14B", sizeBytes: 9_000_000_000 },
  { model: "qwen2.5-coder:32b", label: "Qwen2.5 Coder 32B", sizeBytes: 20_000_000_000 },
]

/**
 * Recommend a local model sized to the machine: the largest vetted model that
 * fits comfortably in RAM, falling back to the smallest when nothing fits cleanly.
 */
export function recommendLocalModel(): LocalModelRec {
  const fitting = RECOMMENDED_LOCAL_MODELS.filter((m) => localModelFit(m.sizeBytes).status === "ok")
  return fitting.at(-1) ?? RECOMMENDED_LOCAL_MODELS[0]!
}

/** Whether an Ollama server is reachable, regardless of whether it has models installed. */
export async function isOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaBaseURL()}/api/tags`, { signal: AbortSignal.timeout(600) })
    return res.ok
  } catch {
    return false
  }
}

export interface PullProgress {
  status: string
  /** 0–100 when the server reports byte totals for the current layer. */
  percent?: number
}

/**
 * Parse one NDJSON line from Ollama's /api/pull stream. Pure for testability.
 * Throws if the line reports an error; returns undefined for blank/unparseable lines.
 */
export function parsePullProgress(line: string): PullProgress | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let ev: { status?: string; total?: number; completed?: number; error?: string }
  try {
    ev = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (ev.error) throw new Error(ev.error)
  const percent =
    typeof ev.total === "number" && ev.total > 0 && typeof ev.completed === "number"
      ? Math.round((ev.completed / ev.total) * 100)
      : undefined
  return { status: ev.status ?? "", percent }
}

/**
 * Pull a model into the local Ollama server, reporting streamed progress.
 * Resolves when the pull completes; rejects on a server error or aborted signal.
 */
export async function pullOllamaModel(
  model: string,
  onProgress?: (p: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${ollamaBaseURL()}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`Ollama pull failed: HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl = buf.indexOf("\n")
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const progress = parsePullProgress(line)
      if (progress) onProgress?.(progress)
      nl = buf.indexOf("\n")
    }
  }
  const tail = parsePullProgress(buf)
  if (tail) onProgress?.(tail)
}
