import { estimateTokens } from "../context/budget"
import type { Skill } from "./types"

const MAX_BUFFER_TOKENS = 4000 // cap for dynamically-loaded skill bodies

export interface LoadedSkill {
  name: string
  body: string
  loadedAt: number
}

/**
 * Per-agent, session-persistent buffer for dynamically-loaded skill bodies.
 * Unlike the TTL-based working set, loaded skills stay for the entire session.
 * Always-load bodies are embedded in the cached system prompt and never go here.
 */
export class SkillBuffer {
  private skills = new Map<string, LoadedSkill>()

  load(skill: Skill): void {
    if (this.skills.has(skill.name)) return
    // Evict oldest if we'd exceed the token cap
    while (this.tokens() + skill.estimatedBodyTokens > MAX_BUFFER_TOKENS && this.skills.size > 0) {
      const oldest = [...this.skills.values()].sort((a, b) => a.loadedAt - b.loadedAt)[0]
      if (oldest) this.skills.delete(oldest.name)
    }
    this.skills.set(skill.name, { name: skill.name, body: skill.body, loadedAt: Date.now() })
  }

  loaded(): LoadedSkill[] {
    return [...this.skills.values()]
  }

  clear(): void {
    this.skills.clear()
  }

  tokens(): number {
    let total = 0
    for (const s of this.skills.values()) total += estimateTokens(s.body)
    return total
  }

  has(name: string): boolean {
    return this.skills.has(name)
  }
}
