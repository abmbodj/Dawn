import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai"
import type { Bus } from "../bus/bus"
import type { DawnConfig } from "../config/config"
import {
  buildRequestMessages,
  contextBudget,
  DEFAULT_CONTEXT_MODE,
  DEFAULT_TOKEN_BUDGET,
  estimateTokens,
  stripReasoningParts,
  ttlForKind,
} from "../context/budget"
import { ContextStore } from "../context/store"
import { getFileSummary } from "../context/summarize"
import type { ContextMode, ContextPlan, ContextPlanTotals, ContextStats, FileSummary } from "../context/types"
import { ContextWorkingSet } from "../context/working-set"
import type { Asker } from "../permission/asker"
import type { PermissionGate } from "../permission/permission"
import type { Catalog } from "../provider/catalog"
import { normalizeModelRef, parseModelRef } from "../provider/catalog"
import { resolveModel } from "../provider/provider"
import type { SessionStore } from "../session/store"
import { createTools, toolPreview, toolResultSummary, toolTitle } from "../tools/index"
import { truncateMiddle } from "../tools/truncate"
import { toStepUsage, UsageLedger } from "../usage/ledger"
import { buildAnswerStyleGuidance } from "./answer-style"
import { loadProjectMemory, type ProjectMemory } from "./project-memory"
import { makeRepairToolCall } from "./repair"
import { isRetryableToolFailure } from "./retry"
import { buildSystemPrompt } from "./system"

export interface AgentOptions {
  cwd: string
  modelRef: string
  /** Model used while in plan mode (gate.mode === "plan"); falls back to modelRef. */
  planModelRef?: string
  bus: Bus
  gate: PermissionGate
  asker?: Asker
  catalog: Catalog
  config: DawnConfig
  store?: SessionStore
  sessionId?: string
  initialMessages?: ModelMessage[]
  contextMode?: ContextMode
  tokenBudget?: number
  contextStore?: ContextStore
}

const MAX_STEPS = 40
const REPO_OVERVIEW_TOOL = "repo_overview"

export function isRepoOverviewQuestion(text: string): boolean {
  const query = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!query) return false

  const asksForOverview =
    /\b(what is|what's|what does|summari[sz]e|explain|describe|overview|tell me about|walk me through)\b/.test(
      query,
    )
  const mentionsRepo = /\b(project|repo|repository|codebase)\b/.test(query)
  const directProjectQuestion = /\bwhat(?:'s| is) this project\b/.test(query)

  return (asksForOverview && mentionsRepo) || directProjectQuestion
}

export class DawnAgent {
  messages: ModelMessage[]
  modelRef: string
  /** Model used while in plan mode; undefined falls back to modelRef. */
  planModelRef: string | undefined
  readonly ledger = new UsageLedger()
  readonly bus: Bus
  private readonly tools: ToolSet
  private readonly system: string
  private readonly contextStore: ContextStore
  private readonly workingSet = new ContextWorkingSet()
  private readonly contextMode: ContextMode
  private readonly tokenBudget: number
  private readonly bgProcs = new Map<
    string,
    { proc: ReturnType<typeof Bun.spawn>; chunks: string[]; done: boolean }
  >()
  readonly projectMemory: ProjectMemory
  private latestContextPlan: ContextPlan | undefined
  private estimatedSavedTokens = 0
  private inputTokenEstimates: number[] = []
  private highestCostTurn: ContextStats["highestCostTurn"]
  private busy = false

  constructor(private opts: AgentOptions) {
    this.bus = opts.bus
    this.modelRef = normalizeModelRef(opts.modelRef)
    this.planModelRef = opts.planModelRef ? normalizeModelRef(opts.planModelRef) : undefined
    this.messages = opts.initialMessages ?? []
    this.contextMode = opts.contextMode ?? DEFAULT_CONTEXT_MODE
    this.tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET
    this.contextStore = opts.contextStore ?? new ContextStore()
    this.tools = createTools({
      cwd: opts.cwd,
      gate: opts.gate,
      bus: opts.bus,
      asker: opts.asker,
      contextStore: this.contextStore,
      workingSet: this.workingSet,
      contextMode: this.contextMode,
      bgProcs: this.bgProcs,
    })
    // Captured once: a byte-stable system prompt is what keeps the provider
    // prompt-cache prefix valid across turns.
    this.projectMemory = loadProjectMemory(opts.cwd)
    this.system = buildSystemPrompt(opts.cwd, this.projectMemory.text || undefined)
  }

  get isBusy(): boolean {
    return this.busy
  }

  close(): void {
    this.contextStore.close()
    for (const entry of this.bgProcs.values()) {
      try {
        entry.proc.kill()
      } catch {
        /* already exited */
      }
    }
    this.bgProcs.clear()
  }

  /** Validates the ref resolves (provider known, key present) before switching. */
  setModel(ref: string): void {
    ref = normalizeModelRef(ref)
    resolveModel(ref, this.opts.catalog, this.opts.config)
    this.modelRef = ref
  }

  /**
   * Sets the model used while in plan mode. Pass an empty string to clear it
   * (plan mode then falls back to the edit model). Validates the ref resolves
   * before switching, same as setModel.
   */
  setPlanModel(ref: string): void {
    if (!ref) {
      this.planModelRef = undefined
      return
    }
    ref = normalizeModelRef(ref)
    resolveModel(ref, this.opts.catalog, this.opts.config)
    this.planModelRef = ref
  }

  startSession(sessionId: string, messages: ModelMessage[] = []): void {
    if (this.busy) throw new Error("Cannot start a new session while the agent is processing a turn")
    this.opts.sessionId = sessionId
    this.opts.initialMessages = messages
    this.messages = messages
    this.ledger.reset()
    this.workingSet.clear()
    this.latestContextPlan = undefined
    this.estimatedSavedTokens = 0
    this.inputTokenEstimates = []
    this.highestCostTurn = undefined
  }

  contextStats(): ContextStats {
    const repoIndex = this.contextStore.indexStatus(this.opts.cwd)
    return {
      mode: this.contextMode,
      budget: this.tokenBudget,
      workingSetTokens: this.workingSet.tokens(),
      loadedItems: this.workingSet.all(),
      cachedSummaries: this.contextStore.summaryCount(this.opts.cwd),
      repoIndex,
      latestPlan: this.latestContextPlan,
      estimatedSavedTokens: this.estimatedSavedTokens,
      averageInputTokens: average(this.inputTokenEstimates),
      highestCostTurn: this.highestCostTurn,
    }
  }

  contextPlanTotals(sessionIds?: string[]): ContextPlanTotals {
    return this.contextStore.contextPlanTotals(sessionIds)
  }

  private requestMessages(isAnthropic: boolean): {
    system: string | import("../context/budget").SystemModelMessage
    messages: ModelMessage[]
  } {
    const latest = this.messages[this.messages.length - 1]
    const query = typeof latest?.content === "string" ? latest.content : JSON.stringify(latest?.content ?? "")
    const summaries = this.relevantSummaries(query)
    const answerGuidance = buildAnswerStyleGuidance(query)
    const built = buildRequestMessages({
      system: this.system,
      messages: this.messages,
      workingSet: this.workingSet.all(),
      summaries,
      budget: contextBudget(this.contextMode, this.tokenBudget),
      answerGuidance,
      isAnthropic,
    })
    this.latestContextPlan = built.plan
    if (built.plan.totalEstimatedTokens > this.tokenBudget) {
      throw new Error(
        `Context budget exceeded: estimated ${built.plan.totalEstimatedTokens} tokens > budget ${this.tokenBudget}. ` +
          "Raise --budget or narrow the request.",
      )
    }
    this.estimatedSavedTokens += built.plan.savingsEstimate + built.plan.substitutionSavings
    this.inputTokenEstimates.push(built.plan.totalEstimatedTokens)
    this.contextStore.recordContextPlan(this.opts.sessionId, built.plan)
    return { system: built.system, messages: built.messages }
  }

  async send(text: string, signal?: AbortSignal): Promise<void> {
    if (this.busy) throw new Error("Agent is already processing a turn")
    this.busy = true
    const { bus, opts } = this

    const effectiveText =
      opts.gate.mode === "plan"
        ? `${text}\n\n<system-reminder>Plan mode is active. Do not edit files or run side-effecting commands. Research the task thoroughly, present a complete plan, then call exit_plan_mode for user approval.</system-reminder>`
        : text
    this.messages.push({ role: "user", content: effectiveText })
    this.persist()
    bus.emit({ type: "turn-start" })

    try {
      // Plan mode runs on the dedicated plan model when one is set; everything
      // else (normal / acceptEdits) runs on the edit model.
      const activeRef = opts.gate.mode === "plan" && this.planModelRef ? this.planModelRef : this.modelRef
      const resolved = resolveModel(activeRef, opts.catalog, opts.config)
      const { providerId } = parseModelRef(activeRef)
      const forceRepoOverview = isRepoOverviewQuestion(text)

      const isAnthropic = providerId === "anthropic"
      // Non-Anthropic providers (e.g. Groq) reject reasoning_content in messages
      // even when their own models produced it in a previous step.  prepareStep
      // lets us strip those parts from the SDK's internally-accumulated messages
      // before each subsequent step — the same filter applied to inter-turn history
      // in buildRequestMessages, but applied intra-turn here.
      const needsReasoningStrip = !isAnthropic
      const buildRequest = () => this.requestMessages(isAnthropic)

      // One-shot retry on provider tool-call 400s (e.g. Groq failed_generation).
      // We attempt the stream twice at most; only the completing attempt persists messages.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { system, messages: requestMsgs } = buildRequest()

        const result = streamText({
          model: resolved.model,
          system: system as any,
          messages: requestMsgs,
          tools: this.tools,
          experimental_repairToolCall: makeRepairToolCall(),
          prepareStep:
            needsReasoningStrip || forceRepoOverview
              ? ({ stepNumber, messages }) => {
                  const overrides: {
                    activeTools?: string[]
                    toolChoice?: { type: "tool"; toolName: string }
                    messages?: ModelMessage[]
                  } = {}

                  if (forceRepoOverview && stepNumber === 0) {
                    overrides.activeTools = [REPO_OVERVIEW_TOOL]
                    overrides.toolChoice = { type: "tool", toolName: REPO_OVERVIEW_TOOL }
                  }

                  if (needsReasoningStrip && stepNumber > 0) {
                    const stripped = stripReasoningParts(messages)
                    if (stripped !== messages) overrides.messages = stripped
                  }

                  return Object.keys(overrides).length > 0 ? overrides : undefined
                }
              : undefined,
          stopWhen: stepCountIs(MAX_STEPS),
          abortSignal: signal,
        })

        let retryableFailure: unknown
        // Stash inputs at tool-call time so tool-result can build a semantic summary
        // even when the SDK's tool-result part doesn't carry input.
        const toolInputs = new Map<string, unknown>()

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              bus.emit({ type: "text-delta", text: part.text })
              break
            case "text-end":
              bus.emit({ type: "text-end" })
              break
            case "reasoning-delta":
              bus.emit({ type: "reasoning-delta", text: part.text })
              break
            case "tool-call":
              toolInputs.set(part.toolCallId, part.input)
              bus.emit({
                type: "tool-start",
                id: part.toolCallId,
                name: part.toolName,
                title: toolTitle(part.toolName, part.input),
                preview: toolPreview(part.toolName, part.input),
              })
              break
            case "tool-result": {
              const storedInput = toolInputs.get(part.toolCallId)
              this.workingSet.add({
                kind: "tool-result",
                content: truncateMiddle(String(part.output ?? ""), 4000),
                reason: `${part.toolName} output`,
                ttl: ttlForKind(this.contextMode, "tool-result"),
                estimatedTokens: estimateTokens(part.output),
              })
              bus.emit({
                type: "tool-end",
                id: part.toolCallId,
                name: part.toolName,
                title: toolTitle(part.toolName, storedInput ?? part.input),
                summary: toolResultSummary(part.toolName, storedInput ?? part.input, part.output),
                isError: false,
              })
              break
            }
            case "tool-error":
              bus.emit({
                type: "tool-end",
                id: part.toolCallId,
                name: part.toolName,
                title: toolTitle(part.toolName, toolInputs.get(part.toolCallId) ?? part.input),
                summary: part.error instanceof Error ? part.error.message : String(part.error),
                isError: true,
              })
              break
            case "finish-step": {
              const usage = toStepUsage(part.usage, providerId, resolved.modelId, resolved.info)
              this.ledger.record(usage)
              if (!this.highestCostTurn || usage.cost > this.highestCostTurn.cost) {
                this.highestCostTurn = {
                  providerId: usage.providerId,
                  modelId: usage.modelId,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cost: usage.cost,
                }
              }
              if (opts.store && opts.sessionId) opts.store.recordUsage(opts.sessionId, usage)
              bus.emit({ type: "step-finish", usage })
              break
            }
            case "error": {
              if (isRetryableToolFailure(part.error)) {
                retryableFailure = part.error
              } else {
                bus.emit({
                  type: "error",
                  message: part.error instanceof Error ? part.error.message : String(part.error),
                })
              }
              break
            }
            default:
              break
          }
        }

        if (retryableFailure !== undefined) {
          bus.emit({ type: "attempt-reset", reason: "retryable-tool-failure" })
          if (attempt === 0) {
            bus.emit({ type: "status", message: "provider rejected a tool call — retrying…" })
            continue
          }
          bus.emit({
            type: "error",
            message: retryableFailure instanceof Error ? retryableFailure.message : String(retryableFailure),
          })
          this.workingSet.decrementLeases()
          bus.emit({ type: "turn-end" })
          return
        }

        const response = await result.response
        this.messages.push(...response.messages)
        this.persist()
        this.workingSet.decrementLeases()
        bus.emit({ type: "turn-end" })
        return
      }

      // Both attempts exhausted without completing — turn ends without response messages
      this.workingSet.decrementLeases()
      bus.emit({ type: "turn-end" })
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        bus.emit({ type: "turn-end", aborted: true })
      } else {
        bus.emit({ type: "error", message: err instanceof Error ? err.message : String(err) })
        bus.emit({ type: "turn-end" })
      }
    } finally {
      this.busy = false
    }
  }

  private persist(): void {
    if (this.opts.store && this.opts.sessionId) {
      this.opts.store.saveMessages(this.opts.sessionId, this.messages)
    }
  }

  private relevantSummaries(query: string): FileSummary[] {
    const entries = this.contextStore.relevantEntries(
      this.opts.cwd,
      query,
      this.contextMode === "deep" ? 12 : 6,
    )
    const summaries: FileSummary[] = []
    for (const entry of entries) {
      try {
        summaries.push(getFileSummary({ cwd: this.opts.cwd, path: entry.path, store: this.contextStore }))
      } catch {
        // Ignore stale index rows for files that disappeared; the next `dawn index`
        // refresh will remove them.
      }
    }
    return summaries
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}
