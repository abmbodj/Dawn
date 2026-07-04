import { generateText, type ModelMessage } from "ai"
import { CLAUDE_CODE_SYSTEM_PREFIX } from "../auth/anthropic-oauth"
import type { DawnConfig } from "../config/config"
import type { Catalog } from "../provider/catalog"
import { resolveModel, usesOAuth } from "../provider/provider"
import { resolveRoleModel } from "../provider/roles"
import { groupHistory } from "./budget"
import { distillDroppedTurns } from "./session-memory"

/**
 * Summarizes the oldest half of conversation history using the cheap utility model,
 * then splices those turns out of the messages array in place, returning the summary
 * text and the modified messages.
 *
 * Falls back to zero-cost template distillation if the LLM call fails.
 */
export async function compactViaLlm(
  messages: ModelMessage[],
  primaryRef: string,
  catalog: Catalog,
  config: DawnConfig,
): Promise<{ summary: string; messages: ModelMessage[] }> {
  const groups = groupHistory(messages)
  if (groups.length < 2) {
    return { summary: "", messages }
  }

  // Summarize the oldest half, keep the newest half verbatim.
  const cutPoint = Math.ceil(groups.length / 2)
  const toSummarize = groups.slice(0, cutPoint).flat()
  const toKeep = groups.slice(cutPoint).flat()

  let summary: string

  try {
    const utilityRef = resolveRoleModel("utility", primaryRef, catalog, config)
    const resolved = resolveModel(utilityRef, catalog, config)

    const historyText = renderHistoryForSummary(toSummarize)
    const { text } = await generateText({
      model: resolved.model,
      // Subscription-OAuth Anthropic requests must present as Claude Code.
      ...(resolved.providerId === "anthropic" && usesOAuth("anthropic", catalog, config)
        ? { system: CLAUDE_CODE_SYSTEM_PREFIX }
        : {}),
      messages: [
        {
          role: "user",
          content:
            "Summarize the following conversation turns concisely. Preserve: what the user asked, " +
            "which files were edited or created, commands run, errors encountered, and the final outcome. " +
            "Write in plain text, no markdown headers.\n\n" +
            historyText,
        },
      ],
    })
    summary = `[Session memory — LLM-compacted from earlier context]\n${text.trim()}`
  } catch {
    // Fallback: zero-cost template distillation
    summary = distillDroppedTurns(toSummarize, [], undefined) ?? ""
  }

  return { summary, messages: toKeep }
}

/** Flatten messages into a readable transcript for the summarization prompt. */
function renderHistoryForSummary(messages: ModelMessage[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string; text?: string }>)
                .filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join(" ")
            : ""
      lines.push(`User: ${text.slice(0, 500)}`)
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        lines.push(`Assistant: ${msg.content.slice(0, 300)}`)
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === "text" && typeof part.text === "string") {
            lines.push(`Assistant: ${(part.text as string).slice(0, 300)}`)
          } else if (part.type === "tool-call") {
            const name = part.toolName as string
            const input = part.input as Record<string, unknown>
            if ((name === "edit" || name === "write") && typeof input.filePath === "string") {
              lines.push(`  [tool: ${name} ${input.filePath}]`)
            } else if (name === "bash" && typeof input.command === "string") {
              lines.push(`  [tool: bash ${String(input.command).slice(0, 100)}]`)
            }
          }
        }
      }
    }
  }
  return lines.join("\n")
}
