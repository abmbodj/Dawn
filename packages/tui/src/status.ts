import { type Catalog, parseModelRef, type UsageTotals } from "@dawn/core"

export type FooterMode = "wide" | "medium" | "narrow"

export interface FooterParts {
  mode: FooterMode
  left: string
  right?: string
}

export function footerMode(width: number): FooterMode {
  if (width < 72) return "narrow"
  if (width < 112) return "medium"
  return "wide"
}

export function modelLabel(
  catalog: Catalog,
  modelRef: string,
  opts: { includeProvider?: boolean } = {},
): string {
  const includeProvider = opts.includeProvider ?? true

  try {
    const { providerId, modelId } = parseModelRef(modelRef)
    const provider = catalog[providerId]
    const model = provider?.models?.[modelId]
    if (!model?.name) return modelRef
    if (!includeProvider) return model.name
    return `${provider?.name ?? providerId} · ${model.name}`
  } catch {
    return modelRef
  }
}

export function formatStatusUsage(usage: UsageTotals, mode: FooterMode): string {
  const input = formatTokens(usage.inputTokens)
  const output = formatTokens(usage.outputTokens)
  const cost = formatCost(usage.cost)

  switch (mode) {
    case "wide":
      return `Usage: ${input} in / ${output} out · Cache: ${formatTokens(usage.cachedInputTokens)} · Cost: ${cost}`
    case "medium":
      return `${input} in / ${output} out · ${cost}`
    case "narrow":
      return cost
  }
}

export function statusFooterParts(args: {
  busy: boolean
  catalog: Catalog
  modelRef: string
  usage: UsageTotals
  width: number
}): FooterParts {
  const mode = footerMode(args.width)
  const cost = formatCost(args.usage.cost)

  if (args.busy) {
    return mode === "narrow"
      ? { mode, left: "Working... Esc to stop" }
      : { mode, left: "Working... Esc to stop", right: formatStatusUsage(args.usage, mode) }
  }

  if (mode === "narrow") {
    return {
      mode,
      left: truncateEnd(
        `Model: ${modelLabel(args.catalog, args.modelRef, { includeProvider: false })} · ${cost}`,
        args.width - 2,
      ),
    }
  }

  const right = formatStatusUsage(args.usage, mode)
  const maxLeft = Math.max(18, args.width - right.length - 6)
  return {
    mode,
    left: truncateEnd(`Model: ${modelLabel(args.catalog, args.modelRef)}`, maxLeft),
    right,
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatCost(usd: number): string {
  return usd >= 0.995 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`
}

function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars))
  return `${text.slice(0, maxChars - 1)}…`
}
