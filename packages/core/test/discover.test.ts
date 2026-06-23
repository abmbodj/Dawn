import { describe, expect, test } from "bun:test"
import {
  envToProvider,
  maskKey,
  parseCodexAuth,
  parseEnvAssignments,
  parseOpencodeAuth,
} from "../src/auth/discover"

describe("maskKey", () => {
  test("keeps a short head and last 4", () => {
    expect(maskKey("sk-ant-abcdef1234")).toBe("sk-…1234")
  })
  test("fully masks short secrets", () => {
    expect(maskKey("abc")).toBe("•••")
  })
})

describe("envToProvider", () => {
  test("maps known provider env vars to provider ids", () => {
    const map = envToProvider()
    expect(map.get("ANTHROPIC_API_KEY")).toBe("anthropic")
    expect(map.get("OPENAI_API_KEY")).toBe("openai")
    expect(map.get("GEMINI_API_KEY")).toBe("google")
    expect(map.get("GROQ_API_KEY")).toBe("groq")
  })
})

describe("parseEnvAssignments", () => {
  test("parses export, quotes, and ignores comments / interpolated values", () => {
    const content = [
      "# a comment",
      'export ANTHROPIC_API_KEY="sk-ant-123"',
      "OPENAI_API_KEY=sk-openai-456  # inline comment",
      "GROQ_API_KEY='gsk_789'",
      "PATH=$PATH:/usr/local/bin",
      "EMPTY=",
    ].join("\n")
    const out = parseEnvAssignments(content)
    expect(out.get("ANTHROPIC_API_KEY")).toBe("sk-ant-123")
    expect(out.get("OPENAI_API_KEY")).toBe("sk-openai-456")
    expect(out.get("GROQ_API_KEY")).toBe("gsk_789")
    expect(out.has("PATH")).toBe(false) // references $PATH → skipped
    expect(out.has("EMPTY")).toBe(false)
  })
})

describe("parseOpencodeAuth", () => {
  test("extracts provider/key pairs from { provider: { key } }", () => {
    const out = parseOpencodeAuth({
      anthropic: { type: "api", key: "sk-ant-x" },
      openai: { type: "oauth" }, // no key → skipped
      groq: { type: "api", key: "gsk_y" },
    })
    expect(out).toEqual([
      { providerId: "anthropic", key: "sk-ant-x" },
      { providerId: "groq", key: "gsk_y" },
    ])
  })
  test("tolerates non-object input", () => {
    expect(parseOpencodeAuth(null)).toEqual([])
    expect(parseOpencodeAuth("nope")).toEqual([])
  })
})

describe("parseCodexAuth", () => {
  test("maps *_API_KEY fields to providers", () => {
    const out = parseCodexAuth({ OPENAI_API_KEY: "sk-openai-z", UNRELATED: "x" })
    expect(out).toEqual([{ providerId: "openai", key: "sk-openai-z" }])
  })
})
