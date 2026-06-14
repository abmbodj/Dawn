import type { ModelMessage } from "ai"
import type {
  ContextBudget,
  ContextMode,
  ContextPlan,
  ContextPlanItem,
  FileSummary,
  WorkingSetItem,
} from "./types"

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

/**
 * Groups messages so that an assistant message containing tool-call parts is
 * always bundled with the tool-result messages that follow it.  Dropping or
 * keeping any group is then atomic, which prevents orphaned tool pairs that
 * cause OpenAI-compatible providers to return a 400.
 *
 * Leading orphaned role:"tool" messages (corrupt persisted sessions) are
 * silently dropped (returned as empty group) so callers can filter(g => g.length > 0).
 */
export function groupHistory(messages: ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]
    if (!msg) {
      i++
      continue
    }

    if (msg.role === "tool") {
      // Orphaned tool message — drop it
      i++
      continue
    }

    const isToolCallAssistant =
      msg.role === "assistant" &&
      Array.isArray(msg.content) &&
      (msg.content as any[]).some((p: any) => p.type === "tool-call")

    if (isToolCallAssistant) {
      const group: ModelMessage[] = [msg]
      i++
      // Absorb all immediately-following tool messages
      while (i < messages.length && messages[i]?.role === "tool") {
        const toolMessage = messages[i]
        if (toolMessage) group.push(toolMessage)
        i++
      }
      groups.push(group)
    } else {
      groups.push([msg])
      i++
    }
  }

  return groups
}

export function trimWorkingSet(
  items: WorkingSetItem[],
  budgetLeft: number,
): {
  kept: WorkingSetItem[]
  trimmed: string[]
  trimmedDetails: ContextPlanItem[]
  savedTokens: number
} {
  let used = 0
  const kept: WorkingSetItem[] = []
  const trimmed: string[] = []
  const trimmedDetails: ContextPlanItem[] = []
  let savedTokens = 0
  const ordered = [...items].sort((a, b) => priority(a) - priority(b) || b.createdAt - a.createdAt)

  for (const item of ordered) {
    if (used + item.estimatedTokens <= budgetLeft) {
      kept.push(item)
      used += item.estimatedTokens
    } else {
      const label = itemLabel(item)
      trimmed.push(label)
      trimmedDetails.push(
        planItem(item.kind, label, item.estimatedTokens, item.ttl <= 0 ? "expired" : "over budget"),
      )
      savedTokens += item.estimatedTokens
    }
  }

  return {
    kept: kept.sort((a, b) => a.createdAt - b.createdAt),
    trimmed,
    trimmedDetails,
    savedTokens,
  }
}

export function trimHistory(
  messages: ModelMessage[],
  budgetLeft: number,
): {
  kept: ModelMessage[]
  trimmed: string[]
  trimmedDetails: ContextPlanItem[]
  tokens: number
  savedTokens: number
} {
  if (messages.length === 0) return { kept: [], trimmed: [], trimmedDetails: [], tokens: 0, savedTokens: 0 }

  const groups = groupHistory(messages)
  if (groups.length === 0) return { kept: [], trimmed: [], trimmedDetails: [], tokens: 0, savedTokens: 0 }

  // Always keep the last group (latest user message)
  const lastGroup = groups.at(-1)
  if (!lastGroup) return { kept: [], trimmed: [], trimmedDetails: [], tokens: 0, savedTokens: 0 }
  const lastTokens = lastGroup.reduce((sum, m) => sum + messageTokens(m), 0)
  let used = lastTokens
  const keptGroups: ModelMessage[][] = [lastGroup]
  const trimmed: string[] = []
  const trimmedDetails: ContextPlanItem[] = []
  let savedTokens = 0

  for (let i = groups.length - 2; i >= 0; i--) {
    const group = groups[i]
    const first = group?.[0]
    if (!group || !first) continue
    const groupTokens = group.reduce((sum, m) => sum + messageTokens(m), 0)
    if (used + groupTokens <= budgetLeft) {
      keptGroups.unshift(group)
      used += groupTokens
    } else {
      const label =
        group.length > 1 ? `${first.role}+tool group (${group.length} messages)` : `${first.role} message`
      trimmed.push(label)
      trimmedDetails.push(planItem("history", label, groupTokens, "history budget"))
      savedTokens += groupTokens
    }
  }

  return { kept: keptGroups.flat(), trimmed, trimmedDetails, tokens: used, savedTokens }
}

export function buildContextPlan(args: {
  systemTokens: number
  historyTokens: number
  summaryTokens: number
  fileTokens: number
  toolResultTokens: number
  budget: ContextBudget
  trimmedItems: string[]
  includedItems?: ContextPlanItem[]
  skippedItems?: ContextPlanItem[]
  savingsEstimate: number
  substitutionSavings: number
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
    includedItems: args.includedItems ?? [],
    skippedItems: args.skippedItems ?? [],
    savingsEstimate: args.savingsEstimate,
    substitutionSavings: args.substitutionSavings,
  }
}

const ANTHROPIC_CACHE = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
}

export type SystemModelMessage = {
  role: "system"
  content: string
  providerOptions?: Record<string, unknown>
}

export function buildRequestMessages(args: {
  system: string
  messages: ModelMessage[]
  workingSet: WorkingSetItem[]
  summaries: FileSummary[]
  budget: ContextBudget
  answerGuidance?: string
  isAnthropic?: boolean
}): {
  system: SystemModelMessage
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
  const includedItems: ContextPlanItem[] = [
    ...summaries.kept.map((summary) =>
      planItem(
        "summary",
        `summary ${summary.path}`,
        estimateTokens(summaryText(summary)),
        "relevant summary",
      ),
    ),
    ...(history.tokens > 0
      ? [planItem("history", "conversation history", history.tokens, "recent history")]
      : []),
    ...working.kept.map((item) => planItem(item.kind, itemLabel(item), item.estimatedTokens, item.reason)),
  ]
  const skippedItems = [...summaries.trimmedDetails, ...history.trimmedDetails, ...working.trimmedDetails]
  const savingsEstimate = summaries.savedTokens + history.savedTokens + working.savedTokens
  // Tokens saved by sending a summary instead of reading the full source file
  const substitutionSavings = summaries.kept.reduce(
    (sum, s) => sum + Math.max(0, s.sourceTokens - s.tokenEstimate),
    0,
  )
  const plan = buildContextPlan({
    systemTokens,
    historyTokens: history.tokens,
    summaryTokens,
    fileTokens,
    toolResultTokens,
    budget: args.budget,
    trimmedItems,
    includedItems,
    skippedItems,
    savingsEstimate,
    substitutionSavings,
  })

  // Context message placed immediately before the latest user message so it
  // doesn't invalidate the Anthropic history-cache prefix on every turn.
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
  const answerGuidanceMessages: ModelMessage[] = args.answerGuidance
    ? [
        {
          role: "user",
          content: `Answer guidance for this turn:\n${args.answerGuidance}`,
        },
      ]
    : []

  // Strip reasoning parts from assistant messages before sending to non-Anthropic
  // providers — e.g. Groq's OpenAI-compatible API rejects 'reasoning_content' in
  // request messages even though its own models emit it.
  const kept = args.isAnthropic ? history.kept : stripReasoningParts(history.kept)
  const historyInit = kept.slice(0, -1)
  const historyLatest = kept[kept.length - 1]
  const requestMessages: ModelMessage[] = historyLatest
    ? [...historyInit, ...contextMessages, ...answerGuidanceMessages, historyLatest]
    : [...contextMessages, ...answerGuidanceMessages]

  const systemMessage: SystemModelMessage = {
    role: "system",
    content: args.system,
    ...(args.isAnthropic ? { providerOptions: ANTHROPIC_CACHE } : {}),
  }

  return {
    system: systemMessage,
    messages: args.isAnthropic ? withMovingAnthropicBreakpoint(requestMessages) : requestMessages,
    plan,
    workingSetKept: working.kept,
  }
}

/**
 * Removes reasoning content parts from assistant messages.  Required for
 * OpenAI-compatible providers (e.g. Groq) that reject reasoning_content in
 * the request body even when their own models produced it.  Exported so
 * agent.ts can apply the same strip inside prepareStep for intra-turn steps.
 */
export function stripReasoningParts(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
    const filtered = (msg.content as any[]).filter((p: any) => p.type !== "reasoning")
    if (filtered.length === (msg.content as any[]).length) return msg
    // Ensure assistant message is never completely empty (some providers reject that)
    return { ...msg, content: filtered.length > 0 ? filtered : " " }
  })
}

function trimSummaries(
  summaries: FileSummary[],
  budget: number,
): {
  kept: FileSummary[]
  trimmed: string[]
  trimmedDetails: ContextPlanItem[]
  savedTokens: number
} {
  let used = 0
  const kept: FileSummary[] = []
  const trimmed: string[] = []
  const trimmedDetails: ContextPlanItem[] = []
  let savedTokens = 0
  for (const summary of summaries) {
    const tokens = estimateTokens(summaryText(summary))
    if (used + tokens <= budget) {
      kept.push(summary)
      used += tokens
    } else {
      const label = `summary ${summary.path}`
      trimmed.push(label)
      trimmedDetails.push(planItem("summary", label, tokens, "summary budget"))
      savedTokens += tokens
    }
  }
  return { kept, trimmed, trimmedDetails, savedTokens }
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

function planItem(
  kind: ContextPlanItem["kind"],
  label: string,
  tokens: number,
  reason: string,
): ContextPlanItem {
  return { kind, label, tokens, reason }
}
