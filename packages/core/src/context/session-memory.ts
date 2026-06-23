import type { ModelMessage } from "ai"
import { groupHistory } from "./budget"

/**
 * Distills conversation turn-groups that are about to be evicted from the context
 * window into a compact "session memory" block. This block is stored as a permanent
 * working-set summary item so the model retains continuity across long sessions
 * without those turns being silently discarded.
 *
 * The distillation is synchronous and template-based (no extra LLM call per turn)
 * to keep latency at zero. The output is a structured plain-English record of:
 *  - what the user asked in each dropped turn
 *  - what files were edited or created
 *  - what commands were run and whether they succeeded
 *  - any errors encountered
 *  - what the assistant concluded
 */

export interface MemoryEntry {
  turnIndex: number
  userAsk: string
  filesEdited: string[]
  commandsRun: string[]
  errors: string[]
  assistantClose: string
}

/** Extract a concise summary from a group of messages (one conversation turn). */
function distillGroup(messages: ModelMessage[], turnIndex: number): MemoryEntry | undefined {
  const userMsg = messages.find((m) => m.role === "user")
  const assistantMsgs = messages.filter((m) => m.role === "assistant")

  const userContent =
    typeof userMsg?.content === "string"
      ? userMsg.content
      : Array.isArray(userMsg?.content)
        ? (userMsg.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join(" ")
        : ""

  if (!userContent.trim()) return undefined

  const filesEdited: string[] = []
  const commandsRun: string[] = []
  const errors: string[] = []
  let assistantClose = ""

  for (const msg of assistantMsgs) {
    if (!Array.isArray(msg.content)) {
      if (typeof msg.content === "string" && msg.content.trim()) {
        assistantClose = firstLines(msg.content, 2)
      }
      continue
    }
    for (const part of msg.content as Array<Record<string, unknown>>) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        assistantClose = firstLines(part.text, 2)
      }
      if (part.type === "tool-call") {
        const name = part.toolName as string
        const input = part.input as Record<string, unknown>
        if ((name === "edit" || name === "write") && typeof input.filePath === "string") {
          if (!filesEdited.includes(input.filePath)) filesEdited.push(input.filePath)
        }
        if (name === "bash" && typeof input.command === "string") {
          commandsRun.push(truncateCmd(input.command))
        }
      }
    }
  }

  // Pick up tool errors from role:"tool" messages
  for (const msg of messages) {
    if (msg.role !== "tool") continue
    const content = Array.isArray(msg.content) ? msg.content : [{ type: "tool-result", content: msg.content }]
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.isError && typeof part.content === "string") {
        errors.push(firstLines(part.content, 1))
      }
    }
  }

  return {
    turnIndex,
    userAsk: firstLines(userContent, 1),
    filesEdited,
    commandsRun,
    errors,
    assistantClose,
  }
}

/** Format a list of MemoryEntry objects into the session memory block. */
export function formatSessionMemory(entries: MemoryEntry[], existingMemory?: string): string {
  const lines: string[] = ["[Session memory — distilled from earlier context]"]

  if (existingMemory) {
    lines.push(existingMemory)
    lines.push("")
    lines.push("[Additional turns compacted]")
  }

  for (const e of entries) {
    lines.push(`\nTurn ${e.turnIndex}: "${e.userAsk}"`)
    if (e.filesEdited.length) lines.push(`  Edited: ${e.filesEdited.join(", ")}`)
    if (e.commandsRun.length) lines.push(`  Ran: ${e.commandsRun.join("; ")}`)
    if (e.errors.length) lines.push(`  Errors: ${e.errors.slice(0, 2).join(" | ")}`)
    if (e.assistantClose) lines.push(`  Result: ${e.assistantClose}`)
  }

  return lines.join("\n")
}

/**
 * Given the full messages list and the set of messages that were KEPT by trimHistory,
 * identify the dropped turn-groups and distill them into a session memory string.
 * Returns undefined when nothing was dropped.
 */
export function distillDroppedTurns(
  allMessages: ModelMessage[],
  keptMessages: ModelMessage[],
  existingMemory?: string,
): string | undefined {
  if (keptMessages.length >= allMessages.length) return undefined

  const keptSet = new Set(keptMessages)
  const droppedMessages = allMessages.filter((m) => !keptSet.has(m))
  if (droppedMessages.length === 0) return undefined

  const groups = groupHistory(droppedMessages)
  const entries: MemoryEntry[] = []

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    if (!group) continue
    const entry = distillGroup(group, i + 1)
    if (entry) entries.push(entry)
  }

  if (entries.length === 0) return undefined
  return formatSessionMemory(entries, existingMemory)
}

function firstLines(text: string, n: number): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(" ")
    .slice(0, 200)
}

function truncateCmd(cmd: string): string {
  return cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd
}
