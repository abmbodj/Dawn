import type { ToolCallRepairFunction, ToolSet } from "ai"
import { InvalidToolInputError, NoSuchToolError } from "ai"

/**
 * Attempts to repair a raw tool-input string from a model that wrapped its
 * JSON in markdown fences, added prose preamble, or double-encoded it.
 * Returns the repaired string on success, null when the string is
 * unrecoverably malformed.
 */
export function repairToolInput(raw: string): string | null {
  let s = raw.trim()

  // Strip surrounding ```json ... ``` or ``` ... ``` fences
  s = s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()

  // Trim prose before the first { and after the last }
  const firstBrace = s.indexOf("{")
  const lastBrace = s.lastIndexOf("}")
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1)
  }

  // Try parsing as-is
  try {
    JSON.parse(s)
    return s
  } catch {
    // fall through
  }

  // Unwrap double-encoded JSON: the whole thing might be a JSON-stringified object
  try {
    const inner = JSON.parse(raw.trim())
    if (typeof inner === "string") {
      const unwrapped = inner.trim()
      JSON.parse(unwrapped)
      return unwrapped
    }
  } catch {
    // fall through
  }

  return null
}

/** Normalizes a tool name for fuzzy matching (lowercase, underscores→hyphens removed). */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "")
}

export function makeRepairToolCall(): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, tools, error }) => {
    if (InvalidToolInputError.isInstance(error)) {
      const repaired = repairToolInput(toolCall.input)
      if (repaired === null) return null
      return { ...toolCall, input: repaired }
    }

    if (NoSuchToolError.isInstance(error)) {
      const target = normalizeName(toolCall.toolName)
      const match = Object.keys(tools).find((name) => normalizeName(name) === target)
      if (!match) return null
      return { ...toolCall, toolName: match }
    }

    return null
  }
}
