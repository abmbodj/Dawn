import { APICallError } from "ai"

export type FailureKind =
  | "free-tier-deprecated" // provider suggests a replacement slug
  | "model-unavailable" // model not found / not supported / decommissioned
  | "plan-restricted" // model exists but is not in the user's plan/subscription
  | "no-output" // stream finished with nothing produced
  | "auth" // bad / missing API key
  | "rate-limit" // 429 / quota exceeded
  | "context-overflow" // prompt too long for model
  | "retryable-tool" // Groq-style tool-call 400 — safe to retry same model
  | "unknown"

export interface ClassifiedFailure {
  kind: FailureKind
  message: string
  /** Only set for "free-tier-deprecated" — the provider-suggested replacement model id. */
  suggestedSlug?: string
}

function haystack(err: InstanceType<typeof APICallError>): string {
  return `${err.message ?? ""} ${err.responseBody ?? ""}`.toLowerCase()
}

export function classifyFailure(err: unknown): ClassifiedFailure {
  // --- APICallError (from Vercel AI SDK) ---
  if (APICallError.isInstance(err)) {
    const e = err as InstanceType<typeof APICallError>
    const h = haystack(e)
    const status = e.statusCode ?? 0

    // Auth
    if (status === 401 || status === 403 || h.includes("invalid api key") || h.includes("unauthorized")) {
      return {
        kind: "auth",
        message: "Authentication failed — check your API key (`dawn auth login <provider>`).",
      }
    }

    // Rate limit
    if (status === 429 || h.includes("rate limit") || h.includes("quota exceeded")) {
      return { kind: "rate-limit", message: "Rate limit or quota exceeded — wait a moment and try again." }
    }

    // Context overflow
    if (
      h.includes("context length") ||
      h.includes("context window") ||
      h.includes("too many tokens") ||
      h.includes("maximum context")
    ) {
      return {
        kind: "context-overflow",
        message:
          "Prompt exceeds this model's context window. Try a model with a larger context or clear some history.",
      }
    }

    // Retryable tool failure (Groq failed_generation)
    if (status === 400 && (h.includes("failed_generation") || h.includes("failed to call a function"))) {
      return { kind: "retryable-tool", message: e.message }
    }

    // Free-tier deprecated (OpenRouter: "use this slug instead: X")
    const slugMatch = /use (?:this )?slug instead[:\s]+([^\s,.'"\]]+)/i.exec(
      `${e.message ?? ""} ${e.responseBody ?? ""}`,
    )
    if (slugMatch?.[1]) {
      const slug = slugMatch[1]
      return {
        kind: "free-tier-deprecated",
        message: `This model is no longer available on the free tier — auto-switching to ${slug}.`,
        suggestedSlug: slug,
      }
    }

    // Model exists but not in the user's plan/subscription (e.g. Copilot integrator restriction)
    if (h.includes("not available for integrator") || h.includes("not available for your plan")) {
      return {
        kind: "plan-restricted",
        message: `This model is not included in your current plan or subscription — ${e.message ?? `HTTP ${status}`}.`,
      }
    }

    // Model unavailable / not found
    if (
      status === 404 ||
      h.includes("model not found") ||
      h.includes("model does not exist") ||
      h.includes("not supported") ||
      h.includes("unavailable") ||
      h.includes("decommissioned") ||
      h.includes("deprecated")
    ) {
      return {
        kind: "model-unavailable",
        message: `Model unavailable (${e.message ?? `HTTP ${status}`}) — switching to an available alternative.`,
      }
    }

    return { kind: "unknown", message: e.message ?? `Provider error (HTTP ${status})` }
  }

  // --- Plain Error (e.g. thrown from the SDK wrapper) ---
  if (err instanceof Error) {
    const msg = err.message
    const lower = msg.toLowerCase()

    if (lower.includes("failed_generation") || lower.includes("failed to call a function")) {
      return { kind: "retryable-tool", message: msg }
    }

    const slugMatch = /use (?:this )?slug instead[:\s]+([^\s,.'"\]]+)/i.exec(msg)
    if (slugMatch?.[1]) {
      return {
        kind: "free-tier-deprecated",
        message: `Auto-switching to ${slugMatch[1]}.`,
        suggestedSlug: slugMatch[1],
      }
    }

    if (lower.includes("no output") || lower.includes("no content") || lower.includes("empty response")) {
      return { kind: "no-output", message: "Model returned an empty response. Check that this model is available on your account and that your API key has access to it." }
    }

    if (lower.includes("unauthorized") || lower.includes("invalid api key")) {
      return {
        kind: "auth",
        message: "Authentication failed — check your API key (`dawn auth login <provider>`).",
      }
    }

    if (lower.includes("rate limit") || lower.includes("quota")) {
      return { kind: "rate-limit", message: "Rate limit or quota exceeded — wait a moment and try again." }
    }

    if (lower.includes("context length") || lower.includes("too many tokens")) {
      return { kind: "context-overflow", message: "Prompt exceeds this model's context window." }
    }

    if (lower.includes("not supported") || lower.includes("not found") || lower.includes("unavailable")) {
      return {
        kind: "model-unavailable",
        message: `Model unavailable: ${msg} — switching to an alternative.`,
      }
    }

    return { kind: "unknown", message: msg }
  }

  return { kind: "unknown", message: String(err) }
}

/** Convenience wrapper kept for backward compatibility. */
export function isRetryableToolFailure(err: unknown): boolean {
  return classifyFailure(err).kind === "retryable-tool"
}
