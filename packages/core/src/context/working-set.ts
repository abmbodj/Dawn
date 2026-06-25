import { estimateTokens } from "./budget"
import type { WorkingSetItem } from "./types"

export class ContextWorkingSet {
  private items: WorkingSetItem[] = []

  add(item: Omit<WorkingSetItem, "createdAt" | "estimatedTokens"> & { estimatedTokens?: number }): void {
    const estimatedTokens = item.estimatedTokens ?? estimateTokens(item.content ?? item.summary ?? "")
    const next: WorkingSetItem = { ...item, estimatedTokens, createdAt: Date.now() }
    const key = keyFor(next)
    this.items = this.items.filter((existing) => keyFor(existing) !== key)
    this.items.push(next)
  }

  all(): WorkingSetItem[] {
    return [...this.items]
  }

  hasFileRange(path: string, startLine: number, endLine: number): boolean {
    const key = ["file-range", path, String(startLine), String(endLine)].join(":")
    return this.items.some((item) => keyFor(item) === key)
  }

  tokens(): number {
    return this.items.reduce((sum, item) => sum + item.estimatedTokens, 0)
  }

  decrementLeases(): void {
    this.items = this.items
      .map((item) => ({ ...item, ttl: item.ttl - 1 }))
      .filter((item) => item.ttl > 0 || item.kind === "summary")
  }

  clear(): void {
    this.items = []
  }
}

function keyFor(item: WorkingSetItem): string {
  return [item.kind, item.path ?? "", item.startLine ?? "", item.endLine ?? ""].join(":")
}
