import type { ModelMessage } from "ai"
import type { ContextBudget, ContextMode, ContextPlan, FileSummary, WorkingSetItem } from "./types"

export const DEFAULT_CONTEXT_MODE: ContextMode = "balanced"
export const DEFAULT_TOKEN_BUDGET = 8000

export function contextBudget(
  mode: ContextMode = DEFAULT_CONTEXT_MODE,
  budget = DEFAULT_TOKEN_BUDGET,
): ContextBudget {
  return { mode, budget }
}

export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return Math.ceil(text.length / 4)
}

export function ttlForKind(mode: ContextMode, kind: WorkingSetItem["kind"]): number {
  if (kind === "summary") return mode === "minimal" ? 6 : mode === "balanced" ? 10 : 14
  if (kind === "tool-result") return mode === "minimal" ? 1 : mode === "balanced" ? 2 : 3
  return mode === "minimal" ? 1 : mode === "balanced" ? 2 : 4
}

export function maxReadLines(mode: ContextMode): number {
  return mode === "minimal" ? 120 : mode === "balanced" ? 240 : 600
}

export function messageTokens(message: ModelMessage): number {
  return estimateTokens(message.content)
}

export function summaryText(summary: FileSummary): string {
  const symbols = summary.symbols.length ? `\nSymbols: ${summary.symbols.join(", ")}` : ""
  const deps = summary.dependencies.length ? `\nDependencies: ${summary.dependencies.join(", ")}` : ""
  return `File summary: ${summary.path}\n${summary.summary}${symbols}${deps}`
}

export function workingSetItemText(item: WorkingSetItem): string {
  switch (item.kind) {
    case "summary":
      return `Context summary: ${item.path ?? "(unknown)"}\nReason: ${item.reason}\n${item.summary ?? item.content ?? ""}`
    case "file-range":
      return `Loaded file range: ${item.path ?? "(unknown)"} lines ${item.startLine ?? "?"}-${item.endLine ?? "?"}\nReason: ${item.reason}\n${item.content ?? ""}`
    case "file":
      return `Loaded file: ${item.path ?? "(unknown)"}\nReason: ${item.reason}\n${item.content ?? ""}`
    case "tool-result":
      return `Recent tool result\nReason: ${item.reason}\n${item.content ?? ""}`
  }
}

export function trimWorkingSet(
  items: WorkingSetItem[],
  budgetLeft: number,
): {
  kept: WorkingSetItem[]
  trimmed: string[]
  savedTokens: number
} {
  let used = 0
  const kept: WorkingSetItem[] = []
  const trimmed: string[] = []
  let savedTokens = 0
  const ordered = [...items].sort((a, b) => priority(a) - priority(b) || b.createdAt - a.createdAt)

  for (const item of ordered) {
    if (used + item.estimatedTokens <= budgetLeft) {
      kept.push(item)
      used += item.estimatedTokens
    } else {
      trimmed.push(itemLabel(item))
      savedTokens += item.estimatedTokens
    }
  }

  return {
    kept: kept.sort((a, b) => a.createdAt - b.createdAt),
    trimmed,
    savedTokens,
  }
}

export function trimHistory(
  messages: ModelMessage[],
  budgetLeft: number,
): {
  kept: ModelMessage[]
  trimmed: string[]
  tokens: number
  savedTokens: number
} {
  if (messages.length === 0) return { kept: [], trimmed: [], tokens: 0, savedTokens: 0 }

  const latest = messages[messages.length - 1]
  if (!latest) return { kept: [], trimmed: [], tokens: 0, savedTokens: 0 }
  const latestTokens = messageTokens(latest)
  let used = latestTokens
  const kept: ModelMessage[] = [latest]
  const trimmed: string[] = []
  let savedTokens = 0

  for (let i = messages.length - 2; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    const tokens = messageTokens(msg)
    if (used + tokens <= budgetLeft) {
      kept.unshift(msg)
      used += tokens
    } else {
      trimmed.push(`${msg.role} message`)
      savedTokens += tokens
    }
  }

  return { kept, trimmed, tokens: used, savedTokens }
}

export function buildContextPlan(args: {
  systemTokens: number
  historyTokens: number
  summaryTokens: number
  fileTokens: number
  toolResultTokens: number
  budget: ContextBudget
  trimmedItems: string[]
  savingsEstimate: number
}): ContextPlan {
  const totalEstimatedTokens =
    args.systemTokens + args.historyTokens + args.summaryTokens + args.fileTokens + args.toolResultTokens
  return {
    systemTokens: args.systemTokens,
    historyTokens: args.historyTokens,
    summaryTokens: args.summaryTokens,
    fileTokens: args.fileTokens,
    toolResultTokens: args.toolResultTokens,
    totalEstimatedTokens,
    budget: args.budget.budget,
    mode: args.budget.mode,
    trimmedItems: args.trimmedItems,
    savingsEstimate: args.savingsEstimate,
  }
}

export function buildRequestMessages(args: {
  system: string
  messages: ModelMessage[]
  workingSet: WorkingSetItem[]
  summaries: FileSummary[]
  budget: ContextBudget
  isAnthropic?: boolean
}): {
  messages: ModelMessage[]
  plan: ContextPlan
  workingSetKept: WorkingSetItem[]
} {
  const systemTokens = estimateTokens(args.system)
  const budgetAfterSystem = Math.max(0, args.budget.budget - systemTokens)
  const summaries = trimSummaries(args.summaries, Math.floor(budgetAfterSystem * 0.35))
  const summaryBlocks = summaries.kept.map(summaryText)
  const summaryTokensRaw = estimateTokens(summaryBlocks.join("\n\n"))

  const history = trimHistory(
    args.messages,
    Math.max(0, budgetAfterSystem - Math.min(summaryTokensRaw, budgetAfterSystem)),
  )
  const budgetAfterHistoryAndSummaries = Math.max(0, budgetAfterSystem - history.tokens - summaryTokensRaw)
  const working = trimWorkingSet(args.workingSet, budgetAfterHistoryAndSummaries)

  const keptWorkingText = working.kept.map(workingSetItemText)
  const summaryTextBody = summaryBlocks.join("\n\n")
  const workingTextBody = keptWorkingText.join("\n\n")
  const contextParts = [
    summaryTextBody ? `Repository summaries:\n${summaryTextBody}` : "",
    workingTextBody ? `Working set:\n${workingTextBody}` : "",
  ].filter(Boolean)

  const summaryTokens = estimateTokens(summaryTextBody)
  const fileTokens = working.kept
    .filter((item) => item.kind === "file" || item.kind === "file-range")
    .reduce((sum, item) => sum + item.estimatedTokens, 0)
  const toolResultTokens = working.kept
    .filter((item) => item.kind === "tool-result")
    .reduce((sum, item) => sum + item.estimatedTokens, 0)
  const trimmedItems = [...summaries.trimmed, ...history.trimmed, ...working.trimmed]
  const savingsEstimate = summaries.savedTokens + history.savedTokens + working.savedTokens
  const plan = buildContextPlan({
    systemTokens,
    historyTokens: history.tokens,
    summaryTokens,
    fileTokens,
    toolResultTokens,
    budget: args.budget,
    trimmedItems,
    savingsEstimate,
  })

  const systemMessage: ModelMessage = {
    role: "system",
    content: args.system,
    ...(args.isAnthropic ? { providerOptions: ANTHROPIC_CACHE } : {}),
  }
  const contextMessages: ModelMessage[] = contextParts.length
    ? [
        {
          role: "user",
          content:
            "Use this compact repository context for the current turn. Prefer these summaries over re-reading full files unless exact code is needed.\n\n" +
            contextParts.join("\n\n"),
        },
      ]
    : []
  const request = [systemMessage, ...contextMessages, ...history.kept]

  return {
    messages: args.isAnthropic ? withMovingAnthropicBreakpoint(request) : request,
    plan,
    workingSetKept: working.kept,
  }
}

function trimSummaries(
  summaries: FileSummary[],
  budget: number,
): {
  kept: FileSummary[]
  trimmed: string[]
  savedTokens: number
} {
  let used = 0
  const kept: FileSummary[] = []
  const trimmed: string[] = []
  let savedTokens = 0
  for (const summary of summaries) {
    const tokens = estimateTokens(summaryText(summary))
    if (used + tokens <= budget) {
      kept.push(summary)
      used += tokens
    } else {
      trimmed.push(`summary ${summary.path}`)
      savedTokens += tokens
    }
  }
  return { kept, trimmed, savedTokens }
}

const ANTHROPIC_CACHE = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
}

function withMovingAnthropicBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message, i) =>
    i === messages.length - 1 ? { ...message, providerOptions: ANTHROPIC_CACHE } : message,
  )
}

function priority(item: WorkingSetItem): number {
  if (item.ttl <= 0) return 100
  if (item.kind === "summary") return 1
  if (item.kind === "file-range") return 2
  if (item.kind === "file") return 3
  return 4
}

function itemLabel(item: WorkingSetItem): string {
  if (item.kind === "file-range")
    return `${item.path ?? "file"} lines ${item.startLine ?? "?"}-${item.endLine ?? "?"}`
  if (item.path) return `${item.kind} ${item.path}`
  return item.kind
}
