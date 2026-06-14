import type { CompactorResult } from "./types"

/**
 * SmartCrusher-lite: keeps the structure (all keys) and the head+tail items of large
 * arrays, eliding the redundant middle. Items are kept whole, so high-entropy values
 * (ids, hashes) inside them survive. Recurses one level into nested arrays/objects.
 */
function crush(value: unknown, keepItems: number, depth: number): { value: unknown; dropped: number } {
  if (Array.isArray(value)) {
    let dropped = 0
    if (value.length > keepItems) {
      // Reserve one slot for the elision marker so the result has exactly `keepItems`
      // elements — re-compacting it is then a no-op (idempotent).
      const budget = Math.max(2, keepItems - 1)
      const head = Math.max(1, Math.ceil(budget * 0.7))
      const tail = Math.max(1, budget - head)
      const elided = value.length - head - tail
      if (elided > 0) {
        const headItems = value
          .slice(0, head)
          .map((v) => crushChild(v, keepItems, depth, (d) => (dropped += d)))
        const tailItems = value
          .slice(value.length - tail)
          .map((v) => crushChild(v, keepItems, depth, (d) => (dropped += d)))
        return { value: [...headItems, `«${elided} items elided»`, ...tailItems], dropped: dropped + elided }
      }
    }
    if (depth < 2) {
      const out = value.map((v) => crushChild(v, keepItems, depth, (d) => (dropped += d)))
      return { value: out, dropped }
    }
    return { value, dropped }
  }
  if (value && typeof value === "object" && depth < 3) {
    let dropped = 0
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = crush(v, keepItems, depth + 1)
      out[k] = r.value
      dropped += r.dropped
    }
    return { value: out, dropped }
  }
  return { value, dropped: 0 }
}

function crushChild(v: unknown, keepItems: number, depth: number, add: (n: number) => void): unknown {
  const r = crush(v, keepItems, depth + 1)
  add(r.dropped)
  return r.value
}

export function compactJson(text: string, keepItems: number): CompactorResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { text, lossy: false }
  }
  const { value, dropped } = crush(parsed, keepItems, 0)
  if (dropped <= 0) return { text, lossy: false }
  const pretty = /\n\s/.test(text)
  return { text: JSON.stringify(value, null, pretty ? 2 : 0), lossy: true, dropped: `${dropped} items` }
}
