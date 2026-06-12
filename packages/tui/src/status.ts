import { type Catalog, type ContextStats, parseModelRef, type UsageTotals } from "@dawn/core"

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

export function formatContextReport(stats: ContextStats): string {
  const lines = [
    "Context",
    `Mode: ${stats.mode}`,
    `Budget: ${formatWholeTokens(stats.budget)} tokens`,
    `Working set: ${formatWholeTokens(stats.workingSetTokens)} tokens`,
    "",
    "Loaded:",
  ]
  if (stats.loadedItems.length === 0) {
    lines.push("- none")
  } else {
    for (const item of stats.loadedItems) {
      if (item.kind === "file-range") {
        lines.push(
          `- ${item.path ?? "(unknown)"} lines ${item.startLine ?? "?"}-${item.endLine ?? "?"} — ${item.reason}`,
        )
      } else if (item.path) {
        lines.push(`- ${item.path} ${item.kind} — ${item.reason}`)
      } else {
        lines.push(`- ${item.kind} — ${item.reason}`)
      }
    }
  }
  lines.push("")
  lines.push(`Cached summaries: ${stats.cachedSummaries}`)
  lines.push(
    `Repo index: ${stats.repoIndex.indexedFiles} files` +
      (stats.repoIndex.updatedAt ? `, updated ${new Date(stats.repoIndex.updatedAt).toLocaleString()}` : ""),
  )
  lines.push(`Estimated saved: ${formatWholeTokens(stats.estimatedSavedTokens)} tokens`)
  return lines.join("\n")
}

export function formatUsageReport(args: {
  perModel: ReadonlyMap<string, UsageTotals>
  lifetime: UsageTotals
  context: ContextStats
  catalog: Catalog
}): string {
  const lines = [`session usage (${args.lifetime.steps} steps):`]
  for (const [model, t] of args.perModel) {
    lines.push(
      `  ${model}: ↑${formatTokens(t.inputTokens)} ↓${formatTokens(t.outputTokens)} ` +
        `· cache read ${formatTokens(t.cachedInputTokens)} · cache write ${formatTokens(t.cacheWriteTokens)} ` +
        `· ${formatCost(t.cost)}`,
    )
    const comparison = modelCostComparison(args.catalog, model, t)
    if (comparison) lines.push(`    ${comparison}`)
  }
  lines.push(
    `total this session: ${formatCost(args.lifetime.cost)} ` +
      `(↑${formatTokens(args.lifetime.inputTokens)} ↓${formatTokens(args.lifetime.outputTokens)}, ` +
      `${formatTokens(args.lifetime.cachedInputTokens)} cached reads, ` +
      `${formatTokens(args.lifetime.cacheWriteTokens)} cache writes)`,
  )
  const avg = args.lifetime.steps ? Math.round(args.lifetime.inputTokens / args.lifetime.steps) : 0
  lines.push(`average input: ${formatWholeTokens(avg)} tokens/turn`)
  if (args.context.highestCostTurn) {
    const turn = args.context.highestCostTurn
    lines.push(
      `highest-cost turn: ${turn.providerId}/${turn.modelId} ${formatCost(turn.cost)} ` +
        `(↑${formatTokens(turn.inputTokens)} ↓${formatTokens(turn.outputTokens)})`,
    )
  }
  lines.push(`estimated context savings: ${formatWholeTokens(args.context.estimatedSavedTokens)} tokens`)
  return lines.join("\n")
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

function formatWholeTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

function formatCost(usd: number): string {
  return usd >= 0.995 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`
}

function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars))
  return `${text.slice(0, maxChars - 1)}…`
}

function modelCostComparison(catalog: Catalog, modelRef: string, usage: UsageTotals): string | undefined {
  try {
    const { providerId, modelId } = parseModelRef(modelRef)
    const cost = catalog[providerId]?.models?.[modelId]?.cost
    if (!cost) return undefined
    const uncached =
      (usage.inputTokens * (cost.input ?? 0) + usage.outputTokens * (cost.output ?? 0)) / 1_000_000
    if (uncached <= 0) return undefined
    return `without cache pricing: ${formatCost(uncached)} vs actual ${formatCost(usage.cost)}`
  } catch {
    return undefined
  }
}
