import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai"
import type { Bus } from "../bus/bus"
import type { DawnConfig } from "../config/config"
import type { PermissionGate } from "../permission/permission"
import type { Catalog } from "../provider/catalog"
import { parseModelRef } from "../provider/catalog"
import { resolveModel } from "../provider/provider"
import type { SessionStore } from "../session/store"
import { createTools, toolTitle } from "../tools/index"
import { truncateMiddle } from "../tools/truncate"
import { toStepUsage, UsageLedger } from "../usage/ledger"
import { buildSystemPrompt } from "./system"

export interface AgentOptions {
  cwd: string
  modelRef: string
  bus: Bus
  gate: PermissionGate
  catalog: Catalog
  config: DawnConfig
  store?: SessionStore
  sessionId?: string
  initialMessages?: ModelMessage[]
}

const MAX_STEPS = 40

const ANTHROPIC_CACHE = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
}

export class DawnAgent {
  messages: ModelMessage[]
  modelRef: string
  readonly ledger = new UsageLedger()
  readonly bus: Bus
  private readonly tools: ToolSet
  private readonly system: string
  private busy = false

  constructor(private opts: AgentOptions) {
    this.bus = opts.bus
    this.modelRef = opts.modelRef
    this.messages = opts.initialMessages ?? []
    this.tools = createTools({ cwd: opts.cwd, gate: opts.gate, bus: opts.bus })
    // Captured once: a byte-stable system prompt is what keeps the provider
    // prompt-cache prefix valid across turns.
    this.system = buildSystemPrompt(opts.cwd)
  }

  get isBusy(): boolean {
    return this.busy
  }

  /** Validates the ref resolves (provider known, key present) before switching. */
  setModel(ref: string): void {
    resolveModel(ref, this.opts.catalog, this.opts.config)
    this.modelRef = ref
  }

  /**
   * Build the request messages: stable system prefix first, then history,
   * with Anthropic cache breakpoints on the system message and the final
   * message (the moving breakpoint pattern).
   */
  private requestMessages(isAnthropic: boolean): ModelMessage[] {
    const system: ModelMessage = {
      role: "system",
      content: this.system,
      ...(isAnthropic ? { providerOptions: ANTHROPIC_CACHE } : {}),
    }
    const history = this.messages.map((m, i) =>
      isAnthropic && i === this.messages.length - 1 ? { ...m, providerOptions: ANTHROPIC_CACHE } : m,
    )
    return [system, ...history]
  }

  async send(text: string, signal?: AbortSignal): Promise<void> {
    if (this.busy) throw new Error("Agent is already processing a turn")
    this.busy = true
    const { bus, opts } = this

    this.messages.push({ role: "user", content: text })
    this.persist()
    bus.emit({ type: "turn-start" })

    try {
      const resolved = resolveModel(this.modelRef, opts.catalog, opts.config)
      const { providerId } = parseModelRef(this.modelRef)

      const result = streamText({
        model: resolved.model,
        messages: this.requestMessages(providerId === "anthropic"),
        tools: this.tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: signal,
      })

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
            bus.emit({
              type: "tool-start",
              id: part.toolCallId,
              name: part.toolName,
              title: toolTitle(part.toolName, part.input),
            })
            break
          case "tool-result":
            bus.emit({
              type: "tool-end",
              id: part.toolCallId,
              name: part.toolName,
              title: toolTitle(part.toolName, part.input),
              summary: truncateMiddle(String(part.output ?? ""), 200),
              isError: false,
            })
            break
          case "tool-error":
            bus.emit({
              type: "tool-end",
              id: part.toolCallId,
              name: part.toolName,
              title: toolTitle(part.toolName, part.input),
              summary: part.error instanceof Error ? part.error.message : String(part.error),
              isError: true,
            })
            break
          case "finish-step": {
            const usage = toStepUsage(part.usage, providerId, resolved.modelId, resolved.info)
            this.ledger.record(usage)
            if (opts.store && opts.sessionId) opts.store.recordUsage(opts.sessionId, usage)
            bus.emit({ type: "step-finish", usage })
            break
          }
          case "error":
            bus.emit({
              type: "error",
              message: part.error instanceof Error ? part.error.message : String(part.error),
            })
            break
          default:
            break
        }
      }

      const response = await result.response
      this.messages.push(...response.messages)
      this.persist()
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
}
