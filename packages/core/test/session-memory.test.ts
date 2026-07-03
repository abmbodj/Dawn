import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import {
  distillDroppedTurns,
  formatSessionMemory,
  MAX_MEMORY_CHARS,
  type MemoryEntry,
} from "../src/context/session-memory"

function entry(i: number): MemoryEntry {
  return {
    turnIndex: i,
    userAsk: `ask number ${i}`,
    filesEdited: [`src/file-${i}.ts`],
    commandsRun: [`bun test ${i}`],
    errors: [],
    assistantClose: `done with ${i}`,
  }
}

describe("formatSessionMemory", () => {
  test("does not nest its own previous output when re-distilled", () => {
    const first = formatSessionMemory([entry(1), entry(2)])
    // Re-distillation passes only spliced LLM memory as existingMemory — never `first`.
    // Formatting the same dropped turns again must be stable, not compounding.
    const second = formatSessionMemory([entry(1), entry(2), entry(3)])
    expect(second.match(/ask number 1/g)?.length).toBe(1)
    expect(second.match(/\[Session memory/g)?.length).toBe(1)
    expect(second.length).toBeGreaterThan(first.length)
  })

  test("embeds spliced memory once with a label", () => {
    const block = formatSessionMemory([entry(5)], "LLM summary of spliced turns")
    expect(block).toContain("LLM summary of spliced turns")
    expect(block).toContain("[Additional turns compacted]")
    expect(block.match(/\[Additional turns compacted\]/g)?.length).toBe(1)
  })

  test("caps the block and keeps the newest entries", () => {
    const many = Array.from({ length: 200 }, (_, i) => entry(i + 1))
    const block = formatSessionMemory(many)
    // Entries average >80 chars, so 200 of them exceed the cap by a lot; allow one
    // entry of slop past the cap boundary.
    expect(block.length).toBeLessThan(MAX_MEMORY_CHARS + 400)
    expect(block).toContain("ask number 200")
    expect(block).not.toContain('"ask number 1"')
  })

  test("caps oversized spliced memory", () => {
    const block = formatSessionMemory([entry(1)], "y".repeat(MAX_MEMORY_CHARS * 3))
    expect(block.length).toBeLessThan(MAX_MEMORY_CHARS + 400)
    expect(block).toContain("ask number 1")
  })
})

describe("distillDroppedTurns", () => {
  test("returns undefined when nothing was dropped", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }]
    expect(distillDroppedTurns(messages, messages)).toBeUndefined()
  })

  test("distills dropped turns without duplicating across calls", () => {
    const dropped: ModelMessage[] = [
      { role: "user", content: "first ask" },
      { role: "assistant", content: "first answer" },
    ]
    const kept: ModelMessage[] = [{ role: "user", content: "latest ask" }]
    const all = [...dropped, ...kept]

    const memory1 = distillDroppedTurns(all, kept)
    expect(memory1).toContain("first ask")

    // Next turn: same dropped turns re-distilled; spliced memory (none) unchanged.
    const memory2 = distillDroppedTurns(all, kept, undefined)
    expect(memory2).toBe(memory1)
  })
})
