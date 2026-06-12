import type { LanguageModelUsage } from "ai"
import type { StepUsage } from "../bus/bus"
import type { ModelInfo } from "../provider/catalog"

/**
 * Cost in USD for one step. models.dev prices are USD per 1M tokens.
 * `inputTokens` is the total prompt size; cached reads/writes are billed
 * at their own rates, the remainder at the full input rate.
 */
export function computeCost(
  info: ModelInfo | undefined,
  usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    cacheWriteTokens: number
  },
): number {
  const cost = info?.cost
  if (!cost) return 0
  const noCache = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens)
  return (
    (noCache * (cost.input ?? 0) +
      usage.cachedInputTokens * (cost.cache_read ?? 0) +
      usage.cacheWriteTokens * (cost.cache_write ?? cost.input ?? 0) +
      usage.outputTokens * (cost.output ?? 0)) /
    1_000_000
  )
}

export function toStepUsage(
  usage: LanguageModelUsage,
  providerId: string,
  modelId: string,
  info: ModelInfo | undefined,
): StepUsage {
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0
  return {
    providerId,
    modelId,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    cost: computeCost(info, { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens }),
  }
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  cost: number
  steps: number
}

const EMPTY: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  steps: 0,
}

export class UsageLedger {
  private byModel = new Map<string, UsageTotals>()

  record(step: StepUsage): void {
    const key = `${step.providerId}/${step.modelId}`
    const t = this.byModel.get(key) ?? { ...EMPTY }
    t.inputTokens += step.inputTokens
    t.outputTokens += step.outputTokens
    t.cachedInputTokens += step.cachedInputTokens
    t.cacheWriteTokens += step.cacheWriteTokens
    t.cost += step.cost
    t.steps += 1
    this.byModel.set(key, t)
  }

  totals(): UsageTotals {
    const sum = { ...EMPTY }
    for (const t of this.byModel.values()) {
      sum.inputTokens += t.inputTokens
      sum.outputTokens += t.outputTokens
      sum.cachedInputTokens += t.cachedInputTokens
      sum.cacheWriteTokens += t.cacheWriteTokens
      sum.cost += t.cost
      sum.steps += t.steps
    }
    return sum
  }

  perModel(): ReadonlyMap<string, UsageTotals> {
    return this.byModel
  }
}
