import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { authorizeUrl } from "../src/auth/anthropic-oauth"
import { getAuthEntry, hasOAuth, resolveApiKey, setApiKey, setOAuthTokens } from "../src/auth/auth"

describe("authorizeUrl", () => {
  test("max mode targets claude.ai with PKCE S256 params", () => {
    const { url, verifier } = authorizeUrl("max")
    const u = new URL(url)
    expect(u.hostname).toBe("claude.ai")
    expect(u.pathname).toBe("/oauth/authorize")
    expect(u.searchParams.get("code_challenge_method")).toBe("S256")
    expect(u.searchParams.get("response_type")).toBe("code")
    expect(u.searchParams.get("state")).toBe(verifier)
    expect(u.searchParams.get("scope")).toContain("user:inference")
    // challenge must be derived, not the raw verifier
    expect(u.searchParams.get("code_challenge")).not.toBe(verifier)
    expect(verifier.length).toBeGreaterThanOrEqual(43)
  })

  test("console mode targets console.anthropic.com", () => {
    const { url } = authorizeUrl("console")
    expect(new URL(url).hostname).toBe("console.anthropic.com")
  })

  test("each call mints a fresh verifier", () => {
    expect(authorizeUrl("max").verifier).not.toBe(authorizeUrl("max").verifier)
  })
})

describe("auth store oauth entries", () => {
  let tmp: string
  let prevData: string | undefined

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-oauth-"))
    prevData = process.env.DAWN_DATA_DIR
    process.env.DAWN_DATA_DIR = tmp
  })

  afterEach(() => {
    if (prevData === undefined) delete process.env.DAWN_DATA_DIR
    else process.env.DAWN_DATA_DIR = prevData
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("setOAuthTokens round-trips and hasOAuth sees it", () => {
    setOAuthTokens("anthropic", { access: "at", refresh: "rt", expires: 123 })
    expect(hasOAuth("anthropic")).toBe(true)
    expect(getAuthEntry("anthropic")).toEqual({
      type: "oauth",
      access: "at",
      refresh: "rt",
      expires: 123,
    })
  })

  test("resolveApiKey ignores oauth entries", () => {
    setOAuthTokens("anthropic", { access: "at", refresh: "rt", expires: 123 })
    expect(resolveApiKey("anthropic", [])).toBeUndefined()
  })

  test("setApiKey overwrites an oauth entry (console flavor)", () => {
    setOAuthTokens("anthropic", { access: "at", refresh: "rt", expires: 123 })
    setApiKey("anthropic", "sk-ant-xxx")
    expect(hasOAuth("anthropic")).toBe(false)
    expect(resolveApiKey("anthropic", [])).toBe("sk-ant-xxx")
  })
})
