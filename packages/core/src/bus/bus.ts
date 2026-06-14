export interface StepUsage {
  providerId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  cost: number
}

export interface TodoItem {
  content: string
  activeForm: string
  status: "pending" | "in_progress" | "completed"
}

export type AgentEvent =
  | { type: "turn-start" }
  | { type: "attempt-reset"; reason: "retryable-tool-failure" | "model-switch" }
  | { type: "text-delta"; text: string }
  | { type: "text-end" }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-start"; id: string; name: string; title: string; preview?: string }
  | { type: "tool-end"; id: string; name: string; title: string; summary: string; isError: boolean }
  | { type: "step-finish"; usage: StepUsage }
  | { type: "turn-end"; aborted?: boolean }
  | { type: "error"; message: string }
  | { type: "status"; message: string }
  | { type: "todos"; items: TodoItem[] }
  | { type: "model-switched"; from: string; to: string; reason: string }

export type AgentEventHandler = (event: AgentEvent) => void

export class Bus {
  private handlers = new Set<AgentEventHandler>()

  subscribe(handler: AgentEventHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emit(event: AgentEvent): void {
    for (const handler of this.handlers) handler(event)
  }
}
