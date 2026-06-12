import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { isRetryableToolFailure } from "../src/agent/retry"

function makeAPICallError(statusCode: number, message: string, responseBody?: string) {
  return new APICallError({
    message,
    url: "https://api.groq.com/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody,
    isRetryable: false,
  })
}

describe("isRetryableToolFailure", () => {
  test("true for 400 with failed_generation in message", () => {
    const err = makeAPICallError(400, "Failed to call a function. See failed_generation for details.")
    expect(isRetryableToolFailure(err)).toBe(true)
  })

  test("true for 400 with failed_generation in responseBody", () => {
    const err = makeAPICallError(400, "bad request", '{"error": {"failed_generation": "..."}}')
    expect(isRetryableToolFailure(err)).toBe(true)
  })

  test("true for 400 with 'Failed to call a function' in message", () => {
    const err = makeAPICallError(400, "Failed to call a function. Please adjust your prompt.")
    expect(isRetryableToolFailure(err)).toBe(true)
  })

  test("false for 429 rate limit", () => {
    const err = makeAPICallError(429, "rate limit exceeded")
    expect(isRetryableToolFailure(err)).toBe(false)
  })

  test("false for 500 server error", () => {
    const err = makeAPICallError(500, "internal server error")
    expect(isRetryableToolFailure(err)).toBe(false)
  })

  test("false for generic Error", () => {
    expect(isRetryableToolFailure(new Error("something broke"))).toBe(false)
  })

  test("false for non-error values", () => {
    expect(isRetryableToolFailure(null)).toBe(false)
    expect(isRetryableToolFailure("string error")).toBe(false)
    expect(isRetryableToolFailure(undefined)).toBe(false)
  })
})
