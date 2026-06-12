import os from "node:os"

export type FitStatus = "ok" | "tight" | "oversized"

export interface LocalModelFit {
  status: FitStatus
  sizeBytes?: number
  totalBytes: number
  freeBytes: number
}

/**
 * Estimate whether a local model can run without thrashing the machine.
 *
 * A model needs its weights resident in RAM (plus context + OS/app overhead).
 * On low-RAM machines, picking a model larger than free memory triggers a swap
 * storm that can freeze the whole system — the exact failure this guards against.
 *
 * Heuristic (vs. total/free RAM): `oversized` when it won't fit in free memory or
 * exceeds 60% of total; `tight` past 45% of total; otherwise `ok`. Unknown size
 * is treated as `ok` so we never block on missing metadata.
 */
export function localModelFit(sizeBytes?: number): LocalModelFit {
  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()
  if (sizeBytes === undefined || sizeBytes <= 0) {
    return { status: "ok", sizeBytes, totalBytes, freeBytes }
  }
  let status: FitStatus = "ok"
  if (sizeBytes > freeBytes || sizeBytes > totalBytes * 0.6) status = "oversized"
  else if (sizeBytes > totalBytes * 0.45) status = "tight"
  return { status, sizeBytes, totalBytes, freeBytes }
}

/** Human-readable size, e.g. "4.7 GB". */
export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes <= 0) return "?"
  const gb = bytes / 1_000_000_000
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1_000_000)} MB`
}
