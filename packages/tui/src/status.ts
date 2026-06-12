import {
  type Catalog,
  type ContextPlanItem,
  type ContextPlanTotals,
  type ContextStats,
  parseModelRef,
  type UsageTotals,
} from "@dawn/core"

export type FooterMode = "wide" | "medium" | "narrow"

export interface FooterParts {
  mode: FooterMode
  left: string
  right?: string
}

export interface UsageBoxRow {
  label: string
  value: string
  tone?: "normal" | "accent" | "dim"
}

export interface SavingsReportScope {
  label: "session" | "project" | "lifetime"
  usage: UsageTotals
  context: ContextPlanTotals
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
  lines.push("")
  lines.push(...formatContextAudit(stats))
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

export function formatSavingsReport(args: {
  scopes: SavingsReportScope[]
  catalog: Catalog
  modelRef: string
}): string {
  const inputPrice = modelInputPrice(args.catalog, args.modelRef)
  const lines = [
    "Savings",
    "Compared to: without Dawn context planning",
    inputPrice === undefined
      ? "Pricing: unknown for current model"
      : `Pricing: current model input at ${formatCost(inputPrice)} / 1M tokens`,
  ]

  for (const scope of args.scopes) {
    const metrics = savingsMetrics(scope.usage.inputTokens, scope.context.estimatedSavedTokens, inputPrice)
    lines.push("")
    lines.push(`${scope.label}:`)
    lines.push(`  saved: ${formatWholeTokens(scope.context.estimatedSavedTokens)} tokens`)
    lines.push(`  input cut: ${metrics.savedPercent}%`)
    lines.push(`  Dawn sent: ${formatTokens(scope.usage.inputTokens)} input`)
    lines.push(`  would send: ${formatTokens(metrics.wouldSendTokens)} input`)
    lines.push(`  est $ saved: ${metrics.estimatedCostSaved}`)
    lines.push(`  context plans: ${formatWholeTokens(scope.context.plans)}`)
    lines.push(
      `  context items: ${formatWholeTokens(scope.context.includedItems)} included / ` +
        `${formatWholeTokens(scope.context.skippedItems)} skipped`,
    )
    if (scope.context.highestSavingsPlan) {
      const plan = scope.context.highestSavingsPlan
      lines.push(
        `  highest-saving turn: ${formatWholeTokens(plan.savedTokens)} tokens saved ` +
          `(${formatTokens(plan.totalEstimatedTokens)} / ${formatTokens(plan.budget)}, ${plan.mode})`,
      )
    }
  }

  return lines.join("\n")
}

export function usageBoxRows(args: { usage: UsageTotals; context: ContextStats }): UsageBoxRow[] {
  const avgInput = args.usage.steps ? Math.round(args.usage.inputTokens / args.usage.steps) : 0
  const hasCache = args.usage.cachedInputTokens > 0 || args.usage.cacheWriteTokens > 0
  const hasCost = args.usage.cost > 0

  return [
    { label: "cost", value: formatCost(args.usage.cost), tone: hasCost ? "accent" : "dim" },
    { label: "steps", value: formatWholeTokens(args.usage.steps), tone: "dim" },
    {
      label: "tokens",
      value: `↑${formatTokens(args.usage.inputTokens)} ↓${formatTokens(args.usage.outputTokens)}`,
    },
    {
      label: "cache",
      value: `read ${formatTokens(args.usage.cachedInputTokens)} / write ${formatTokens(args.usage.cacheWriteTokens)}`,
      tone: hasCache ? "accent" : "dim",
    },
    { label: "avg input", value: `${formatTokens(avgInput)}/turn` },
  ]
}

export function savingsBoxRows(args: {
  usage: UsageTotals
  context: ContextStats
  catalog: Catalog
  modelRef: string
}): UsageBoxRow[] {
  const savedTokens = args.context.estimatedSavedTokens
  const wouldSendTokens = args.usage.inputTokens + savedTokens
  const savedPercent = wouldSendTokens ? Math.round((savedTokens / wouldSendTokens) * 100) : 0
  const inputPrice = modelInputPrice(args.catalog, args.modelRef)
  const estimatedCostSaved = inputPrice === undefined ? undefined : (savedTokens * inputPrice) / 1_000_000
  const hasSavings = savedTokens > 0

  return [
    {
      label: "saved",
      value: `${formatTokens(savedTokens)} tokens`,
      tone: hasSavings ? "accent" : "dim",
    },
    {
      label: "input cut",
      value: `${savedPercent}%`,
      tone: hasSavings ? "accent" : "dim",
    },
    { label: "would send", value: `${formatTokens(wouldSendTokens)} tokens` },
    { label: "sent", value: `${formatTokens(args.usage.inputTokens)} tokens` },
    {
      label: "$ saved",
      value: estimatedCostSaved === undefined ? "unknown" : formatCost(estimatedCostSaved),
      tone: estimatedCostSaved && estimatedCostSaved > 0 ? "accent" : "dim",
    },
    { label: "vs", value: "no planning", tone: "dim" },
  ]
}

export function // todo: implement plan mode toggle with tab
statusFooterParts(args: {
  busy: boolean
  catalog: Catalog
  modelRef: string
  usage: UsageTotals
  width: number
  showUsageBox?: boolean
}): FooterParts {
  const mode = footerMode(args.width)
  const cost = formatCost(args.usage.cost)
  const showUsageInFooter = !(args.showUsageBox && mode === "wide")

  if (args.busy) {
    if (mode === "narrow") {
      return { mode, left: "Working... Esc to stop" }
    }
    if (showUsageInFooter) {
      return { mode, left: "Working... Esc to stop", right: formatStatusUsage(args.usage, mode) }
    }
    return { mode, left: "Working... Esc to stop" }
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

  if (!showUsageInFooter) {
    return {
      mode,
      left: truncateEnd(`Model: ${modelLabel(args.catalog, args.modelRef)}`, args.width - 2),
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

function modelInputPrice(catalog: Catalog, modelRef: string): number | undefined {
  try {
    const { providerId, modelId } = parseModelRef(modelRef)
    const input = catalog[providerId]?.models?.[modelId]?.cost?.input
    return typeof input === "number" ? input : undefined
  } catch {
    return undefined
  }
}

function formatContextAudit(stats: ContextStats): string[] {
  const plan = stats.latestPlan
  if (!plan) return ["Audit:", "- no context plan recorded yet"]

  const included = plan.includedItems ?? []
  const skipped = plan.skippedItems ?? []
  const loaded = included.filter((item) => item.kind !== "summary" && item.kind !== "history").length
  const summarized = included.filter((item) => item.kind === "summary").length
  const expired = skipped.filter((item) => item.reason.includes("expired")).length
  const overBudget = skipped.filter((item) => item.reason.includes("budget")).length

  return [
    "Audit:",
    `Loaded: ${formatWholeTokens(loaded)}`,
    `Summarized: ${formatWholeTokens(summarized)}`,
    `Skipped: ${formatWholeTokens(skipped.length)}`,
    `Expired: ${formatWholeTokens(expired)}`,
    `Over budget: ${formatWholeTokens(overBudget)}`,
    `Saved this turn: ${formatWholeTokens(plan.savingsEstimate)} tokens`,
    ...formatPlanItems("Included", included),
    ...formatPlanItems("Skipped", skipped),
  ]
}

function formatPlanItems(title: string, items: ContextPlanItem[]): string[] {
  if (items.length === 0) return [`${title}: none`]
  const lines = [`${title}:`]
  for (const item of items.slice(0, 6)) {
    lines.push(`- ${item.label} (${formatWholeTokens(item.tokens)} tokens) — ${item.reason}`)
  }
  if (items.length > 6) lines.push(`- … ${items.length - 6} more`)
  return lines
}

function savingsMetrics(
  inputTokens: number,
  savedTokens: number,
  inputPrice: number | undefined,
): {
  wouldSendTokens: number
  savedPercent: number
  estimatedCostSaved: string
} {
  const wouldSendTokens = inputTokens + savedTokens
  const savedPercent = wouldSendTokens ? Math.round((savedTokens / wouldSendTokens) * 100) : 0
  const estimatedCostSaved =
    inputPrice === undefined ? "unknown" : formatCost((savedTokens * inputPrice) / 1_000_000)
  return { wouldSendTokens, savedPercent, estimatedCostSaved }
}
