import type { ModelMessage } from "ai"

export type ContextMode = "minimal" | "balanced" | "deep"

export interface ContextBudget {
  mode: ContextMode
  budget: number
}

export interface RepoIndexEntry {
  cwd: string
  path: string
  size: number
  mtime: number
  hash: string
  language: string
  imports: string[]
  exports: string[]
  symbols: string[]
}

export interface RepoIndexStatus {
  cwd: string
  indexedFiles: number
  updatedAt?: number
}

export interface FileSummary {
  path: string
  hash: string
  summary: string
  symbols: string[]
  dependencies: string[]
  lastSummarizedAt: number
  tokenEstimate: number
}

export type WorkingSetKind = "file" | "file-range" | "summary" | "tool-result"

export interface WorkingSetItem {
  kind: WorkingSetKind
  path?: string
  startLine?: number
  endLine?: number
  content?: string
  summary?: string
  reason: string
  ttl: number
  estimatedTokens: number
  createdAt: number
}

export type ContextPlanItemKind = WorkingSetKind | "history"

export interface ContextPlanItem {
  kind: ContextPlanItemKind
  label: string
  tokens: number
  reason: string
}

export interface ContextPlan {
  systemTokens: number
  historyTokens: number
  summaryTokens: number
  fileTokens: number
  toolResultTokens: number
  totalEstimatedTokens: number
  budget: number
  mode: ContextMode
  trimmedItems: string[]
  includedItems: ContextPlanItem[]
  skippedItems: ContextPlanItem[]
  savingsEstimate: number
}

export interface RecordedContextPlan {
  id: number
  sessionId?: string
  ts: number
  plan: ContextPlan
}

export interface ContextPlanTotals {
  plans: number
  estimatedSavedTokens: number
  plannedInputTokens: number
  includedItems: number
  skippedItems: number
  highestSavingsPlan?: {
    sessionId?: string
    ts: number
    savedTokens: number
    totalEstimatedTokens: number
    budget: number
    mode: ContextMode
  }
}

export interface BuiltRequest {
  messages: ModelMessage[]
  plan: ContextPlan
}

export interface ContextStats {
  mode: ContextMode
  budget: number
  workingSetTokens: number
  loadedItems: WorkingSetItem[]
  cachedSummaries: number
  repoIndex: RepoIndexStatus
  latestPlan?: ContextPlan
  estimatedSavedTokens: number
  averageInputTokens: number
  highestCostTurn?: {
    providerId: string
    modelId: string
    inputTokens: number
    outputTokens: number
    cost: number
  }
}
