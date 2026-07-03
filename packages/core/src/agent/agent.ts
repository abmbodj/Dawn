import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai"
import type { Bus } from "../bus/bus"
import { CheckpointStore } from "../checkpoint/checkpoint"
import type { DawnConfig } from "../config/config"
import {
  buildRequestMessages,
  contextBudget,
  DEFAULT_CONTEXT_MODE,
  estimateTokens,
  stripReasoningParts,
  ttlForKind,
} from "../context/budget"
import { compactViaLlm } from "../context/compact-llm"
import { distillDroppedTurns } from "../context/session-memory"
import { ContextStore } from "../context/store"
import { getFileSummary } from "../context/summarize"
import type { ContextMode, ContextPlan, ContextPlanTotals, ContextStats, FileSummary } from "../context/types"
import { ContextWorkingSet } from "../context/working-set"
import { formatHookResults, runHooks } from "../hooks/hooks"
import type { McpConnection } from "../mcp/client"
import { connectMcpServers } from "../mcp/client"
import type { McpServerConfig } from "../mcp/config"
import { loadMcpServers } from "../mcp/config"
import { mcpToolsToToolSet } from "../mcp/tools"
import type { Asker } from "../permission/asker"
import type { PermissionGate } from "../permission/permission"
import { loadEnabledPlugins, pluginMcpServers } from "../plugins/registry"
import type { Catalog } from "../provider/catalog"
import { BLESSED_MODELS, getModelInfo, normalizeModelRef, parseModelRef } from "../provider/catalog"
import { AMPLE_BUDGET_THRESHOLD, budgetFor, type ModelProfile, resolveProfile } from "../provider/profile"
import { resolveModel } from "../provider/provider"
import type { SessionStore } from "../session/store"
import { SkillBuffer } from "../skills/buffer"
import { buildSkillCatalog, discoverSkills, findSkill, matchAutoTriggers } from "../skills/registry"
import type { Skill } from "../skills/types"
import { createTools, toolPreview, toolResultSummary, toolTitle, visibleTools } from "../tools/index"
import { truncateMiddle } from "../tools/truncate"
import { toStepUsage, UsageLedger } from "../usage/ledger"
import { buildTurnGuidance } from "./answer-style"
import { type ClassifiedFailure, classifyFailure } from "./errors"
import { loadProjectMemory, type ProjectMemory } from "./project-memory"
import { detectProjectProfile, formatProjectProfileSection } from "./project-profile"
import { makeRepairToolCall } from "./repair"
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
  /** Baseline mode: disable summaries, history/working-set trimming, compaction, and caching. */
  naive?: boolean
}

const MAX_STEPS = 100
const MAX_REPEATED_FAILURES = 3
const REPO_OVERVIEW_TOOL = "repo_overview"
const PLAN_MODE_REMINDER =
  "<system-reminder>Plan mode is active. Do not edit files or run side-effecting commands. " +
  "Research the task thoroughly. Before calling exit_plan_mode, present a decision-complete plan " +
  "with goal/success criteria, key files or behaviors to change, tests/acceptance checks, " +
  "assumptions/defaults, and any open questions. If a critical question remains, ask it instead " +
  "of exiting plan mode.</system-reminder>"

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

/**
 * Pick the best fallback model when the active model fails. Priority:
 *   1. provider-suggested slug (e.g. OpenRouter's "use this slug instead"),
 *   2. cheapest accessible tool-capable model on the SAME provider (least surprising),
 *   3. a blessed flagship on another connected provider (only cross providers as a
 *      last resort, and only to a verified-good model).
 * Returns undefined if no accessible alternative exists.
 */
export function chooseFallback(
  activeRef: string,
  catalog: Catalog,
  config: import("../config/config").DawnConfig,
  suggestedSlug?: string,
): string | undefined {
  const { providerId } = parseModelRef(activeRef)

  // 1. Provider-suggested slug
  if (suggestedSlug) {
    const normalized = suggestedSlug.includes("/") ? suggestedSlug : `${providerId}/${suggestedSlug}`
    try {
      resolveModel(normalized, catalog, config)
      if (normalized !== activeRef) return normalized
    } catch {
      /* not resolvable */
    }
  }

  // 2. Cheapest accessible tool-capable model on the same provider
  const models = catalog[providerId]?.models ?? {}
  const candidates = Object.values(models)
    .filter((m) => m.tool_call !== false)
    .filter((m) => `${providerId}/${m.id}` !== activeRef)
    .sort((a, b) => {
      const ap = a.cost?.input ?? Infinity
      const bp = b.cost?.input ?? Infinity
      return ap - bp
    })

  for (const model of candidates) {
    const ref = `${providerId}/${model.id}`
    try {
      resolveModel(ref, catalog, config)
      return ref
    } catch {
      /* key missing or provider broken */
    }
  }

  // 3. Last resort: a blessed flagship on another connected provider
  for (const ref of BLESSED_MODELS) {
    if (ref === activeRef || parseModelRef(ref).providerId === providerId) continue
    try {
      resolveModel(ref, catalog, config)
      return ref
    } catch {
      /* provider not connected */
    }
  }

  return undefined
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
  /** When true, run a naive baseline: no summaries, trimming, compaction, or caching. */
  private readonly naive: boolean
  private readonly bgProcs = new Map<
    string,
    { proc: ReturnType<typeof Bun.spawn>; chunks: string[]; done: boolean }
  >()
  /** Maps absolute path → content hash at last read; enforces read-before-edit discipline. */
  private readonly readRegistry = new Map<string, string>()
  readonly projectMemory: ProjectMemory
  private latestContextPlan: ContextPlan | undefined
  private estimatedSavedTokens = 0
  private inputTokenEstimates: number[] = []
  /**
   * Append-only, insertion-ordered set of summaries injected this session. Kept stable
   * (no re-sort, no eviction) so the rendered summary block is byte-identical across turns
   * and lands in the provider's cacheable prefix instead of being re-billed every turn.
   */
  private readonly sessionSummaries = new Map<string, FileSummary>()
  /** Summary paths whose substitution saving has been credited (once per file per session). */
  private readonly creditedSummaryPaths = new Set<string>()
  private highestCostTurn: ContextStats["highestCostTurn"]
  private busy = false
  /** Running tally of tokens saved by compacting tool outputs this session. */
  private compaction = { savedTokens: 0, outputs: 0 }
  /** Rendered session-memory block currently in the working set (for change detection). */
  private sessionMemoryText: string | undefined
  /**
   * LLM summaries of turns spliced OUT of this.messages by overflow compaction — the
   * only memory that cannot be re-derived from the live message list. Template
   * distillation re-derives everything else fresh each turn, so only this part is
   * embedded as `existingMemory` (prevents nesting/duplication).
   */
  private splicedMemoryText: string | undefined
  /** Shadow checkpoint store for /rewind support. */
  readonly checkpoints: CheckpointStore
  /** Running turn counter (incremented at the start of each send). */
  private turnIndex = 0
  /** Mark of compaction savings already folded into a recorded context plan. */
  private compactionPlanMark = 0
  /** Discovered skills for this working directory. */
  readonly skills: Skill[]
  /** Session-persistent buffer for dynamically loaded skill bodies. */
  readonly skillBuffer: SkillBuffer
  /** Active MCP server connections (populated by initMcp). */
  private mcpConnections: McpConnection[] = []
  /** Dynamic tools from MCP servers (merged into streamText per-turn). */
  private mcpTools: ToolSet = {}
  /** The ToolContext object, captured so initMcp can build MCP tools with the same context. */
  private readonly toolCtx: Parameters<typeof createTools>[0]
  /** Plugin commands available as dynamic slash commands. */
  readonly pluginCommands: import("../plugins/commands").PluginCommand[]

  constructor(private opts: AgentOptions) {
    this.bus = opts.bus
    this.modelRef = normalizeModelRef(opts.modelRef)
    this.planModelRef = opts.planModelRef ? normalizeModelRef(opts.planModelRef) : undefined
    this.messages = opts.initialMessages ?? []
    this.contextMode = opts.contextMode ?? DEFAULT_CONTEXT_MODE
    this.naive = opts.naive ?? false
    // Adaptive budget: caching providers get a large fraction of the real context window
    // (the stable prefix is billed at ~10% cost via cache-reads), so the model sees full
    // files and recent history. Non-caching / local providers keep the lean default.
    if (opts.tokenBudget !== undefined) {
      this.tokenBudget = opts.tokenBudget
    } else {
      const initialProfile = resolveProfile(this.modelRef, opts.catalog)
      const modelInfo = getModelInfo(opts.catalog, this.modelRef)
      this.tokenBudget = budgetFor(initialProfile, modelInfo)
    }
    this.contextStore = opts.contextStore ?? new ContextStore()
    this.checkpoints = new CheckpointStore(opts.cwd)

    // Load enabled plugins (skills, commands, MCP servers)
    const enabledPlugins = loadEnabledPlugins(opts.config)
    const pluginSkills = enabledPlugins.flatMap((p) => p.skills)
    this.pluginCommands = enabledPlugins.flatMap((p) => p.commands)

    // Discover skills from all configured sources (including plugin-provided)
    const skillConfig = opts.config.skills
    this.skills = discoverSkills(opts.cwd, {
      importClaude: skillConfig?.importClaude ?? false,
      pluginSkills,
    })
    this.skillBuffer = new SkillBuffer()

    // Resolve always-load skill bodies (pinned into the cached system prompt)
    const alwaysLoad = skillConfig?.alwaysLoad ?? []
    const pinnedSkillBodies = alwaysLoad
      .map((name) => findSkill(this.skills, name))
      .filter((s): s is Skill => s !== undefined)
      .map((s) => ({ name: s.name, body: s.body }))

    this.toolCtx = {
      cwd: opts.cwd,
      gate: opts.gate,
      bus: opts.bus,
      asker: opts.asker,
      contextStore: this.contextStore,
      workingSet: this.workingSet,
      contextMode: this.contextMode,
      ampleBudget: this.tokenBudget >= AMPLE_BUDGET_THRESHOLD,
      readRegistry: this.readRegistry,
      bgProcs: this.bgProcs,
      sessionId: opts.sessionId,
      onCompaction: (before, after) => {
        this.compaction.savedTokens += before - after
        this.compaction.outputs += 1
      },
      naive: this.naive,
      skills: this.skills,
      skillBuffer: this.skillBuffer,
    }
    this.tools = createTools(this.toolCtx)
    // Captured once: a byte-stable system prompt is what keeps the provider
    // prompt-cache prefix valid across turns.
    this.projectMemory = loadProjectMemory(opts.cwd)
    const projectProfile = detectProjectProfile(opts.cwd)
    const projectProfileSection = formatProjectProfileSection(projectProfile) || undefined
    this.system = buildSystemPrompt(
      opts.cwd,
      this.projectMemory.text || undefined,
      buildSkillCatalog(this.skills) || undefined,
      pinnedSkillBodies.length > 0 ? pinnedSkillBodies : undefined,
      projectProfileSection,
    )
  }

  /** Summary of skills for the /skills command. */
  skillStats(): Array<{ name: string; description: string; source: Skill["source"]; loaded: boolean }> {
    return this.skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      loaded: this.skillBuffer.has(s.name),
    }))
  }

  /**
   * Resolve the full MCP server map for this agent (config + plugins), ready to pass to initMcp.
   * Convenience for callers that just want "all servers Dawn should connect to".
   */
  resolveMcpServers(): Record<string, McpServerConfig> {
    return loadMcpServers(
      this.opts.cwd,
      this.opts.config,
      pluginMcpServers(loadEnabledPlugins(this.opts.config)),
    )
  }

  /**
   * Connect MCP servers and register their tools. Call after constructing the agent,
   * before the first turn. A server that fails to connect is recorded but never throws.
   */
  async initMcp(servers: Record<string, McpServerConfig>): Promise<McpConnection[]> {
    this.mcpConnections = await connectMcpServers(servers)
    this.mcpTools = mcpToolsToToolSet(this.mcpConnections, this.toolCtx)
    return this.mcpConnections
  }

  /** Summary of MCP connections for the /mcp command. */
  mcpStatus(): Array<{ name: string; toolCount: number; error?: string }> {
    return this.mcpConnections.map((c) => ({
      name: c.name,
      toolCount: c.tools.length,
      error: c.error,
    }))
  }

  get cwd(): string {
    return this.opts.cwd
  }

  get isBusy(): boolean {
    return this.busy
  }

  async close(): Promise<void> {
    this.contextStore.close()
    for (const entry of this.bgProcs.values()) {
      try {
        entry.proc.kill()
      } catch {
        /* already exited */
      }
    }
    this.bgProcs.clear()
    await Promise.all(this.mcpConnections.filter((c) => !c.error).map((c) => c.close().catch(() => {})))
    this.mcpConnections = []
    this.mcpTools = {}
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
    this.skillBuffer.clear()
    this.latestContextPlan = undefined
    this.estimatedSavedTokens = 0
    this.inputTokenEstimates = []
    this.highestCostTurn = undefined
    this.compaction = { savedTokens: 0, outputs: 0 }
    this.compactionPlanMark = 0
    this.sessionSummaries.clear()
    this.creditedSummaryPaths.clear()
    this.sessionMemoryText = undefined
    this.splicedMemoryText = undefined
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
      compactionSavedTokens: this.compaction.savedTokens,
      compactedOutputs: this.compaction.outputs,
      averageInputTokens: average(this.inputTokenEstimates),
      highestCostTurn: this.highestCostTurn,
    }
  }

  contextPlanTotals(sessionIds?: string[]): ContextPlanTotals {
    return this.contextStore.contextPlanTotals(sessionIds)
  }

  private requestMessages(profile: ModelProfile): {
    system: string | import("../context/budget").SystemModelMessage
    messages: ModelMessage[]
  } {
    const latest = this.messages[this.messages.length - 1]
    const query = typeof latest?.content === "string" ? latest.content : JSON.stringify(latest?.content ?? "")
    const summaries = this.relevantSummaries(query)
    const turnGuidance = buildTurnGuidance(query, { currentDate: new Date().toISOString().slice(0, 10) })
    // The model-profile delta rides along with per-turn guidance (after the cached
    // prompt prefix) so it never invalidates the prompt cache and tracks plan/build
    // model switches correctly.
    const answerGuidance = [turnGuidance, profile.promptDelta].filter(Boolean).join("\n\n") || undefined
    // Fold compaction savings accrued since the last plan into this one (persisted for /savings).
    const compactionSavings = this.compaction.savedTokens - this.compactionPlanMark
    this.compactionPlanMark = this.compaction.savedTokens
    const buildArgs = {
      system: this.system,
      messages: this.messages,
      workingSet: this.workingSet.all(),
      summaries,
      budget: contextBudget(this.contextMode, this.tokenBudget),
      answerGuidance,
      isAnthropic: profile.supportsCaching,
      caches: profile.supportsCaching,
      stripReasoning: profile.reasoning === "strip",
      compactionSavings,
      loadedSkills: this.skillBuffer.loaded(),
      naive: this.naive,
      creditedSummaryPaths: this.creditedSummaryPaths,
    }
    let built = buildRequestMessages(buildArgs)
    if (!this.naive && built.plan.totalEstimatedTokens > this.tokenBudget) {
      // Degrade instead of failing closed: retry bare (no working set, no summaries).
      // If even that overflows the estimate, send anyway — chars/4 is approximate and
      // a real provider overflow is already handled by compaction + retry downstream.
      built = buildRequestMessages({ ...buildArgs, workingSet: [], summaries: [] })
      if (built.plan.totalEstimatedTokens > this.tokenBudget) {
        this.bus.emit({
          type: "status",
          message: `context estimate ${built.plan.totalEstimatedTokens} tokens exceeds budget ${this.tokenBudget} — sending trimmed request anyway`,
        })
      }
    }
    this.latestContextPlan = built.plan
    for (const p of built.keptSummaryPaths) this.creditedSummaryPaths.add(p)
    this.estimatedSavedTokens += built.plan.savingsEstimate + built.plan.substitutionSavings
    this.inputTokenEstimates.push(built.plan.totalEstimatedTokens)
    this.contextStore.recordContextPlan(this.opts.sessionId, built.plan)

    // If history turns were dropped, distill them into session memory so the thread isn't lost.
    if (!this.naive && built.keptHistoryMessages.length < this.messages.length) {
      const newMemory = distillDroppedTurns(this.messages, built.keptHistoryMessages, this.splicedMemoryText)
      if (newMemory && newMemory !== this.sessionMemoryText) {
        this.sessionMemoryText = newMemory
        this.workingSet.add({
          kind: "summary",
          summary: newMemory,
          reason: "session memory",
          ttl: 9999,
          estimatedTokens: estimateTokens(newMemory),
        })
        this.bus.emit({ type: "status", message: "compacted earlier turns into session memory" })
      }
    }

    return { system: built.system, messages: built.messages }
  }

  async send(
    text: string,
    signal?: AbortSignal,
    images?: Array<{ base64: string; mimeType: string }>,
  ): Promise<void> {
    if (this.busy) throw new Error("Agent is already processing a turn")
    this.busy = true
    const { bus, opts } = this

    this.turnIndex++
    const effectiveText = opts.gate.mode === "plan" ? `${text}\n\n${PLAN_MODE_REMINDER}` : text

    if (images && images.length > 0) {
      const content: Array<
        { type: "text"; text: string } | { type: "image"; image: string; mediaType: string }
      > = [
        { type: "text", text: effectiveText },
        ...images.map((img) => ({
          type: "image" as const,
          image: img.base64,
          mediaType: img.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
        })),
      ]
      this.messages.push({ role: "user", content })
    } else {
      this.messages.push({ role: "user", content: effectiveText })
    }
    this.persist()
    bus.emit({ type: "turn-start" })
    // Snapshot working tree before this turn makes any changes
    const label = text.slice(0, 60).replace(/\n/g, " ")
    this.checkpoints.snapshot(this.turnIndex, label, this.messages)

    try {
      // Auto-trigger: load skill bodies whose patterns match this turn before building the request
      const autoTrigger = this.opts.config.skills?.autoTrigger
      if (autoTrigger) {
        const triggered = matchAutoTriggers(text, this.skills, autoTrigger)
        for (const s of triggered) this.skillBuffer.load(s)
      }

      const forceRepoOverview = isRepoOverviewQuestion(text)

      // pre-send hooks: run shell commands, inject output as context
      const preSendCmds = opts.config.hooks?.["pre-send"]
      if (preSendCmds && preSendCmds.length > 0) {
        const hookResults = await runHooks(preSendCmds, this.cwd)
        const hookOutput = formatHookResults(hookResults)
        if (hookOutput.trim()) {
          this.workingSet.add({
            kind: "summary",
            content: `Hook output (pre-send):\n${hookOutput}`,
            reason: "pre-send hook",
            ttl: 1,
            estimatedTokens: estimateTokens(hookOutput),
          })
        }
      }

      // Active model ref — may change on auto-switch; updated on this.modelRef/planModelRef too.
      let activeRef = opts.gate.mode === "plan" && this.planModelRef ? this.planModelRef : this.modelRef
      let resolved = resolveModel(activeRef, opts.catalog, opts.config)

      let switchCount = 0
      const MAX_SWITCHES = 2
      // 2 retries (same model) + up to MAX_SWITCHES model switches
      const MAX_ATTEMPTS = 2 + MAX_SWITCHES
      // Count empty-stream occurrences to allow one retry before surfacing the error.
      let noOutputRetries = 0
      // Compaction retries: on context-overflow we compact history and retry (max 2 times).
      let compactionRetries = 0
      const MAX_COMPACTIONS = 2

      // Hoisted outside the attempt loop so all paths can unsubscribe
      let latestTodos: import("../bus/bus").TodoItem[] = []
      const unsubTodos = bus.subscribe((ev) => {
        if (ev.type === "todos") latestTodos = ev.items
      })

      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const { providerId } = parseModelRef(activeRef)
          // Behavior (reasoning handling, tool repair, caching, prompt scaffolding)
          // is driven by the model's profile, resolved per attempt so an auto-switch
          // to a different model picks up the right behavior.
          const profile = resolveProfile(activeRef, opts.catalog)
          // Models on OpenAI-compatible providers (e.g. Groq) reject reasoning_content
          // in messages even when their own models produced it in a previous step.
          const needsReasoningStrip = profile.reasoning === "strip"

          const { system, messages: requestMsgs } = this.requestMessages(profile)

          // Thread reasoning-aware params. Reasoning models (o-series, codex, deepseek-r1, …)
          // reject temperature and expect max_completion_tokens on OpenAI-compatible transports.
          const streamParams: Parameters<typeof streamText>[0] = {
            model: resolved.model,
            system: system as any,
            messages: requestMsgs,
            // Errors surface as fullStream "error" parts and are classified below; the SDK
            // default onError would ALSO dump the raw stack to the console (ugly in the TUI).
            onError: () => {},
            tools: visibleTools({ ...this.tools, ...this.mcpTools }, opts.gate.mode, opts.config.permissions),
            experimental_repairToolCall: profile.toolRepair ? makeRepairToolCall() : undefined,
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
            onStepFinish: (step) => {
              // Persist after every clean step boundary so a crash/abort never loses completed work.
              this.messages.push(...step.response.messages)
              stepMsgsPushed += step.response.messages.length
              this.persist()
            },
          }
          if (profile.params.temperature !== undefined) {
            streamParams.temperature = profile.params.temperature
          }
          if (profile.params.maxTokens !== undefined) {
            streamParams.maxOutputTokens = profile.params.maxTokens
          }
          if (profile.params.useMaxCompletionTokens) {
            // OpenAI reasoning models require max_completion_tokens; pass via providerOptions
            // so it reaches the underlying SDK without conflicting with maxOutputTokens.
            streamParams.providerOptions = {
              ...streamParams.providerOptions,
              openai: {
                ...(streamParams.providerOptions?.openai as object | undefined),
                maxCompletionTokens: 16384,
              },
              "openai-compatible": {
                ...(streamParams.providerOptions?.["openai-compatible"] as object | undefined),
                max_completion_tokens: 16384,
              },
            }
          }
          const result = streamText(streamParams)

          let retryableFailure: unknown
          let switchFailure: ClassifiedFailure | undefined
          let overflowFailure = false
          let hasOutput = false
          let stepMsgsPushed = 0
          // Set when a stream error is emitted directly (not retryable, not a switch trigger).
          // Prevents falling through to the success path after a visible error.
          let hadStreamError = false
          // Stash inputs at tool-call time so tool-result can build a semantic summary
          const toolInputs = new Map<string, unknown>()
          // Loop-detection: count failures per unique (tool, input) signature
          const failureCounts = new Map<string, number>()
          let stepCount = 0

          for await (const part of result.fullStream) {
            switch (part.type) {
              case "text-delta":
                hasOutput = true
                bus.emit({ type: "text-delta", text: part.text })
                break
              case "text-end":
                bus.emit({ type: "text-end" })
                break
              case "reasoning-delta":
                hasOutput = true
                bus.emit({ type: "reasoning-delta", text: part.text })
                break
              case "tool-call":
                hasOutput = true
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
                const echo = truncateMiddle(String(part.output ?? ""), 4000)
                this.workingSet.add({
                  kind: "tool-result",
                  content: echo,
                  reason: `${part.toolName} output`,
                  ttl: ttlForKind(this.contextMode, "tool-result"),
                  estimatedTokens: estimateTokens(echo),
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
              case "tool-error": {
                const errMsg = part.error instanceof Error ? part.error.message : String(part.error)
                // Track repeated failures: same tool + same input args = same signature
                const sig = `${part.toolName}:${JSON.stringify(toolInputs.get(part.toolCallId) ?? part.input)}`
                const prevCount = failureCounts.get(sig) ?? 0
                failureCounts.set(sig, prevCount + 1)
                bus.emit({
                  type: "tool-end",
                  id: part.toolCallId,
                  name: part.toolName,
                  title: toolTitle(part.toolName, toolInputs.get(part.toolCallId) ?? part.input),
                  summary: errMsg,
                  isError: true,
                })
                // Edit multi-match: inject re-read guidance immediately on first failure, don't wait for MAX_REPEATED_FAILURES
                if (part.toolName === "edit" && errMsg.includes("matches") && errMsg.includes("times")) {
                  const input = toolInputs.get(part.toolCallId) ?? part.input
                  const fp = (input as Record<string, unknown>)?.filePath ?? "the file"
                  this.workingSet.add({
                    kind: "tool-result",
                    content:
                      `[Dawn edit-hint] oldString appears multiple times in ${fp}. ` +
                      `You must re-read the file around the target lines, then expand oldString to include ` +
                      `3–5 lines of surrounding context that uniquely identify the location.`,
                    reason: "edit multi-match hint",
                    ttl: 1,
                    estimatedTokens: 60,
                  })
                }
                if (prevCount + 1 >= MAX_REPEATED_FAILURES) {
                  // Break the loop — inject a reconsider message so the model can try a different approach
                  bus.emit({
                    type: "status",
                    message: `${part.toolName} failed ${prevCount + 1} times in a row — asking the model to reconsider`,
                  })
                  // This surfaces as a visible error to the model in its next step
                  this.workingSet.add({
                    kind: "tool-result",
                    content:
                      `[Dawn loop-break] "${part.toolName}" has failed ${prevCount + 1} times with the same arguments. ` +
                      `Stop repeating this call. Step back, reconsider your approach, and try a meaningfully different strategy. ` +
                      `If you're stuck, surface the blocker to the user with ask_user instead of retrying.`,
                    reason: "loop-break injection",
                    ttl: 2,
                    estimatedTokens: 100,
                  })
                }
                break
              }
              case "finish-step": {
                stepCount++
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
                const classified = classifyFailure(part.error)
                if (classified.kind === "retryable-tool") {
                  retryableFailure = part.error
                } else if (
                  classified.kind === "free-tier-deprecated" ||
                  classified.kind === "model-unavailable" ||
                  classified.kind === "rate-limit"
                ) {
                  // Trigger silent switch when the provider says the model is gone, suggests a
                  // replacement, or has rate-limited this model — switching providers is the
                  // correct recovery for all three cases.
                  switchFailure = classified
                } else if (classified.kind === "context-overflow" && compactionRetries < MAX_COMPACTIONS) {
                  // Context overflow: attempt LLM-backed compaction then retry rather than dying.
                  overflowFailure = true
                } else {
                  // plan-restricted, auth, context-overflow (retries exhausted), unknown: surface
                  // directly and mark that we had a real stream error so we don't fall
                  // through to the success path after this.
                  bus.emit({ type: "error", message: classified.message })
                  hadStreamError = true
                }
                break
              }
              default:
                break
            }
          }

          // Context-overflow recovery: compact history via LLM and retry.
          if (overflowFailure) {
            compactionRetries++
            bus.emit({ type: "status", message: "context overflow — compacting history and retrying…" })
            try {
              const { summary, messages: compacted } = await compactViaLlm(
                this.messages,
                this.modelRef,
                opts.catalog,
                opts.config,
              )
              this.messages = compacted
              if (summary) {
                // Accumulate: a later compaction summarizes only the current messages,
                // not the turns an earlier compaction already spliced out.
                this.splicedMemoryText = this.splicedMemoryText
                  ? `${this.splicedMemoryText}\n${summary}`
                  : summary
                this.sessionMemoryText = summary
                this.workingSet.add({
                  kind: "summary",
                  summary,
                  reason: "overflow compaction",
                  ttl: 9999,
                  estimatedTokens: estimateTokens(summary),
                })
              }
              this.persist()
            } catch {
              // Compaction itself failed; surface the original overflow error.
              bus.emit({
                type: "error",
                message:
                  "Context window is full and compaction failed. Try a model with a larger context or clear history.",
              })
              this.workingSet.decrementLeases()
              bus.emit({ type: "turn-end" })
              unsubTodos()
              return
            }
            bus.emit({ type: "attempt-reset", reason: "retryable-tool-failure" })
            continue
          }

          // A real stream error was already emitted — don't fall through to the success path.
          if (hadStreamError) {
            unsubTodos()
            this.workingSet.decrementLeases()
            bus.emit({ type: "turn-end" })
            return
          }

          // A clean stream that produced nothing: retry the same model once, then surface
          // a diagnostic error. Empty responses are almost always a request-shaping issue
          // (missing headers, wrong params) — not a reason to silently swap models.
          if (!hasOutput && !retryableFailure && !switchFailure) {
            if (noOutputRetries === 0) {
              noOutputRetries++
              bus.emit({ type: "attempt-reset", reason: "retryable-tool-failure" })
              bus.emit({ type: "status", message: `${activeRef} returned an empty response — retrying…` })
              continue
            }
            // Second empty response: gather diagnostics and surface a real error.
            let finishReason: string | undefined
            let warnings: string | undefined
            try {
              finishReason = (await result.finishReason) ?? undefined
              const w = await result.warnings
              if (w && w.length > 0) {
                warnings = w.map((x) => ("message" in x ? x.message : JSON.stringify(x))).join("; ")
              }
            } catch {
              // Diagnostics are best-effort; don't let them block the error path.
            }
            const parts = [`\`${activeRef}\` returned an empty response`]
            if (finishReason && finishReason !== "unknown") parts.push(`finish reason: ${finishReason}`)
            if (warnings) parts.push(`provider warnings: ${warnings}`)
            parts.push(
              "Check that this model is available on your account and that your API key has access to it.",
            )
            unsubTodos()
            bus.emit({ type: "error", message: parts.join(" — ") })
            this.workingSet.decrementLeases()
            bus.emit({ type: "turn-end" })
            return
          }

          // ── Same-model retry (Groq tool-call 400) ────────────────────────────
          if (retryableFailure !== undefined) {
            bus.emit({ type: "attempt-reset", reason: "retryable-tool-failure" })
            if (attempt === 0) {
              bus.emit({ type: "status", message: "provider rejected a tool call — retrying…" })
              continue
            }
            unsubTodos()
            bus.emit({
              type: "error",
              message:
                retryableFailure instanceof Error ? retryableFailure.message : String(retryableFailure),
            })
            this.workingSet.decrementLeases()
            bus.emit({ type: "turn-end" })
            return
          }

          // ── Auto-switch to a different model ─────────────────────────────────
          if (switchFailure !== undefined) {
            // Reproducibility-sensitive teams can opt out of silent model switching.
            if (opts.config.autoFallback !== false && switchCount < MAX_SWITCHES) {
              const fallback = chooseFallback(
                activeRef,
                opts.catalog,
                opts.config,
                switchFailure.suggestedSlug,
              )
              if (fallback) {
                const fromRef = activeRef
                activeRef = fallback
                resolved = resolveModel(fallback, opts.catalog, opts.config)
                if (opts.gate.mode === "plan" && this.planModelRef) {
                  this.planModelRef = fallback
                } else {
                  this.modelRef = fallback
                }
                switchCount++
                bus.emit({ type: "attempt-reset", reason: "model-switch" })
                bus.emit({
                  type: "model-switched",
                  from: fromRef,
                  to: fallback,
                  reason: switchFailure.message,
                })
                continue
              }
            }
            // No fallback available or cap reached
            unsubTodos()
            bus.emit({ type: "error", message: switchFailure.message })
            this.workingSet.decrementLeases()
            bus.emit({ type: "turn-end" })
            return
          }

          // ── Success ───────────────────────────────────────────────────────────
          unsubTodos()
          const response = await result.response
          // onStepFinish persists incrementally; push any messages it didn't cover
          // (e.g., single-step providers that don't fire onStepFinish for the last step).
          const remaining = response.messages.slice(stepMsgsPushed)
          if (remaining.length > 0) {
            this.messages.push(...remaining)
            this.persist()
          }
          this.workingSet.decrementLeases()
          // If the model ran out of steps with unfinished work, surface it so the user can continue
          const hasOpenTodos = latestTodos.some((t) => t.status === "pending" || t.status === "in_progress")
          if (stepCount >= MAX_STEPS) {
            bus.emit({ type: "step-limit", stepCount, hasOpenTodos })
          }
          // on-turn-end hooks: run after turn completes, show output in transcript
          const onTurnEndCmds = opts.config.hooks?.["on-turn-end"]
          if (onTurnEndCmds && onTurnEndCmds.length > 0) {
            const hookResults = await runHooks(onTurnEndCmds, this.cwd)
            const hookOutput = formatHookResults(hookResults)
            if (hookOutput.trim()) {
              bus.emit({ type: "status", message: hookOutput })
            }
          }
          bus.emit({ type: "turn-end" })
          return
        }

        // All attempts exhausted without completing
        this.workingSet.decrementLeases()
        bus.emit({ type: "turn-end" })
      } finally {
        unsubTodos()
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        bus.emit({ type: "turn-end", aborted: true })
      } else {
        const classified = classifyFailure(err)
        bus.emit({ type: "error", message: classified.message })
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
    const cap = this.contextMode === "deep" ? 12 : 6
    // Grow the stable session set with newly-relevant files (append-only, capped, no eviction
    // or re-sort) so the rendered block stays byte-identical across turns. Once full, freeze it
    // — keeping the cached prefix intact — and let the model read anything beyond the cap.
    if (this.sessionSummaries.size < cap) {
      const entries = this.contextStore.relevantEntries(this.opts.cwd, query, cap)
      for (const entry of entries) {
        if (this.sessionSummaries.size >= cap) break
        if (this.sessionSummaries.has(entry.path)) continue
        try {
          this.sessionSummaries.set(
            entry.path,
            getFileSummary({ cwd: this.opts.cwd, path: entry.path, store: this.contextStore }),
          )
        } catch {
          // Ignore stale index rows for files that disappeared; the next `dawn index`
          // refresh will remove them.
        }
      }
    }
    return [...this.sessionSummaries.values()]
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}
