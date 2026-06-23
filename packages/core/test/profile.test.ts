import { describe, expect, test } from "bun:test"
import type { Catalog } from "../src/provider/catalog"
import { FLOOR_CONTEXT_TOKENS, meetsFloor, modelTier } from "../src/provider/catalog"
import { detectFamily, resolveProfile } from "../src/provider/profile"

function catalog(): Catalog {
  return {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      modelsSource: "live",
      models: {
        "claude-opus-4-8": {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          tool_call: true,
          reasoning: true,
          limit: { context: 1_000_000 },
        },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      modelsSource: "live",
      models: {
        "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", tool_call: true, limit: { context: 400_000 } },
      },
    },
    groq: {
      id: "groq",
      name: "Groq",
      env: ["GROQ_API_KEY"],
      api: "https://api.groq.com/openai/v1",
      modelsSource: "live",
      models: {
        "llama-3.3-70b-versatile": {
          id: "llama-3.3-70b-versatile",
          name: "Llama 3.3 70B",
          tool_call: true,
          limit: { context: 128_000 },
        },
        "tiny-ctx": { id: "tiny-ctx", name: "Tiny", tool_call: true, limit: { context: 8_000 } },
        "no-tools": { id: "no-tools", name: "No Tools", tool_call: false, limit: { context: 128_000 } },
      },
    },
  }
}

describe("capability floor & tier", () => {
  test("meetsFloor requires tool-calling and a coding-viable context", () => {
    expect(
      meetsFloor({ id: "a", name: "a", tool_call: true, limit: { context: FLOOR_CONTEXT_TOKENS } }),
    ).toBe(true)
    expect(meetsFloor({ id: "a", name: "a", tool_call: true, limit: { context: 8_000 } })).toBe(false)
    expect(meetsFloor({ id: "a", name: "a", tool_call: false, limit: { context: 200_000 } })).toBe(false)
    // Unknown context gets the benefit of the doubt (live listings often omit limits)
    expect(meetsFloor({ id: "a", name: "a", tool_call: true })).toBe(true)
    expect(meetsFloor(undefined)).toBe(false)
  })

  test("tier: blessed allowlist → standard (floor) → experimental", () => {
    const c = catalog()
    expect(modelTier("anthropic/claude-opus-4-8", c.anthropic?.models["claude-opus-4-8"])).toBe("blessed")
    expect(modelTier("groq/llama-3.3-70b-versatile", c.groq?.models["llama-3.3-70b-versatile"])).toBe(
      "standard",
    )
    expect(modelTier("groq/tiny-ctx", c.groq?.models["tiny-ctx"])).toBe("experimental")
    expect(modelTier("groq/no-tools", c.groq?.models["no-tools"])).toBe("experimental")
  })
})

describe("detectFamily", () => {
  test("maps provider/model ids to families", () => {
    expect(detectFamily("anthropic", "claude-opus-4-8")).toBe("claude")
    expect(detectFamily("openai", "gpt-5.5")).toBe("gpt")
    expect(detectFamily("google", "gemini-3.5-pro")).toBe("gemini")
    expect(detectFamily("groq", "llama-3.3-70b-versatile")).toBe("llama")
    expect(detectFamily("groq", "qwen/qwen3-32b")).toBe("qwen")
    expect(detectFamily("mistral", "mistral-large-latest")).toBe("mistral")
    expect(detectFamily("deepseek", "deepseek-chat")).toBe("deepseek")
    expect(detectFamily("custom", "some-unknown-model")).toBe("unknown")
  })
})

describe("resolveProfile", () => {
  test("blessed Anthropic flagship: native reasoning, caching, no scaffolding", () => {
    const p = resolveProfile("anthropic/claude-opus-4-8", catalog())
    expect(p.tier).toBe("blessed")
    expect(p.family).toBe("claude")
    expect(p.reasoning).toBe("native")
    expect(p.supportsCaching).toBe(true)
    expect(p.promptDelta).toBeUndefined()
    expect(p.capabilities.reasoning).toBe(true)
    expect(p.capabilities.vision).toBe(true)
  })

  test("blessed OpenAI flagship: strip reasoning, no caching, no scaffolding", () => {
    const p = resolveProfile("openai/gpt-5.5", catalog())
    expect(p.tier).toBe("blessed")
    expect(p.reasoning).toBe("strip")
    expect(p.supportsCaching).toBe(false)
    expect(p.promptDelta).toBeUndefined()
  })

  test("standard open-weight model: strip, structured prompt delta", () => {
    const p = resolveProfile("groq/llama-3.3-70b-versatile", catalog())
    expect(p.tier).toBe("standard")
    expect(p.family).toBe("llama")
    expect(p.reasoning).toBe("strip")
    expect(p.supportsCaching).toBe(false)
    expect(p.promptDelta).toBeDefined()
  })

  test("experimental (below floor) model gets scaffolding", () => {
    const p = resolveProfile("groq/tiny-ctx", catalog())
    expect(p.tier).toBe("experimental")
    expect(p.promptDelta).toBeDefined()
  })

  test("repair is always on; unknown model still resolves to a safe generic profile", () => {
    const p = resolveProfile("groq/brand-new-model", catalog())
    expect(p.toolRepair).toBe(true)
    expect(p.tier).toBe("experimental") // not in catalog → fails floor
    expect(p.family).toBe("unknown")
    expect(p.promptDelta).toBeDefined()
  })
})
