import { APICallError } from "ai"

/**
 * Returns true when the error is a provider-side tool-call failure that is
 * safe to retry (e.g. Groq's "Failed to call a function / failed_generation"
 * 400).  These are distinct from auth errors, rate-limits, or permanent
 * prompt-validation failures and are usually resolved by re-submitting the
 * same request.
 */
export function isRetryableToolFailure(err: unknown): boolean {
  if (!APICallError.isInstance(err)) {
    // Wrapped: check message text of any Error
    if (err instanceof Error) {
      const msg = err.message
      return msg.includes("failed_generation") || msg.includes("Failed to call a function")
    }
    return false
  }

  const e = err as InstanceType<typeof APICallError>
  if (e.statusCode !== 400) return false

  const haystack = `${e.message ?? ""} ${e.responseBody ?? ""}`.toLowerCase()
  return haystack.includes("failed_generation") || haystack.includes("failed to call a function")
}
