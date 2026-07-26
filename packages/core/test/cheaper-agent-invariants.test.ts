import { describe, expect, test } from "bun:test"
import { DawnAgent } from "../src/agent/agent"
import { Bus } from "../src/bus/bus"
import { buildRequestMessages, contextBudget } from "../src/context/budget"
import { PermissionGate } from "../src/permission/permission"
import type { Catalog } from "../src/provider/catalog"
import { budgetFor, resolveProfile } from "../src/provider/profile"
import { createTools, estimateToolSchemaTokens } from "../src/tools/index"

/**
 * PR CI invariants for the cheaper-agent thesis: adaptive budgets must wire when
 * `tokenBudget` is omitted, and cache capability must split breakpoints from promptCaches.
 */
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
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
          limit: { context: 200_000 },
        },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      modelsSource: "live",
      models: {
        "gpt-5.5": {
          id: "gpt-5.5",
          name: "GPT-5.5",
          tool_call: true,
          cost: { input: 1, output: 2, cache_read: 0.1 },
          limit: { context: 400_000 },
        },
      },
    },
    groq: {
      id: "groq",
      name: "Groq",
      env: ["GROQ_API_KEY"],
      modelsSource: "live",
      models: {
        "llama-3.3-70b-versatile": {
          id: "llama-3.3-70b-versatile",
          name: "Llama 3.3 70B",
          tool_call: true,
          cost: { input: 0.5, output: 0.8 },
          limit: { context: 128_000 },
        },
      },
    },
  }
}

function agentFor(ref: string, tokenBudget?: number): DawnAgent {
  return new DawnAgent({
    cwd: process.cwd(),
    modelRef: ref,
    bus: new Bus(),
    gate: new PermissionGate(),
    catalog: catalog(),
    config: {},
    sessionId: "invariant-session",
    contextMode: "balanced",
    tokenBudget,
  })
}

describe("cheaper-agent planner invariants", () => {
  test("omitting tokenBudget uses adaptive budgetFor for caching Claude", () => {
    const profile = resolveProfile("anthropic/claude-opus-4-8", catalog())
    const expected = budgetFor(profile, catalog().anthropic?.models["claude-opus-4-8"], "balanced")
    // 200k × 0.10 = 20k, hard-capped at 20k
    expect(expected).toBe(20_000)
    expect(agentFor("anthropic/claude-opus-4-8").contextStats().budget).toBe(expected)
  })

  test("omitting tokenBudget keeps lean budget for non-caching Groq", () => {
    const profile = resolveProfile("groq/llama-3.3-70b-versatile", catalog())
    expect(profile.promptCaches).toBe(false)
    expect(agentFor("groq/llama-3.3-70b-versatile").contextStats().budget).toBe(
      budgetFor(profile, catalog().groq?.models["llama-3.3-70b-versatile"], "balanced"),
    )
  })

  test("OpenAI with catalog cache_read gets adaptive budget without Anthropic breakpoints", () => {
    const profile = resolveProfile("openai/gpt-5.5", catalog())
    expect(profile.promptCaches).toBe(true)
    expect(profile.cacheBreakpoints).toBe(false)
    expect(agentFor("openai/gpt-5.5").contextStats().budget).toBe(
      budgetFor(profile, catalog().openai?.models["gpt-5.5"], "balanced"),
    )
  })

  test("--budget override wins over adaptive", () => {
    expect(agentFor("anthropic/claude-opus-4-8", 8000).contextStats().budget).toBe(8000)
  })

  test("context mode scales adaptive Claude budget within absolute caps", () => {
    const profile = resolveProfile("anthropic/claude-opus-4-8", catalog())
    const info = catalog().anthropic?.models["claude-opus-4-8"]
    // 200k × 0.06 = 12k → capped at 12k; 200k × 0.15 = 30k → capped at 32k → 30k
    expect(budgetFor(profile, info, "minimal")).toBe(12_000)
    expect(budgetFor(profile, info, "deep")).toBe(30_000)
  })

  test("tool schemas are counted in the context plan's systemTokens", () => {
    const tools = createTools({ cwd: process.cwd(), gate: new PermissionGate(), bus: new Bus() })
    const schemaTokens = estimateToolSchemaTokens(tools)
    // 26 tools of descriptions + JSON Schemas — a real line item, not noise.
    expect(schemaTokens).toBeGreaterThan(1500)

    const base = buildRequestMessages({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      workingSet: [],
      summaries: [],
      budget: contextBudget("balanced", 8000),
    })
    const withSchemas = buildRequestMessages({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      workingSet: [],
      summaries: [],
      budget: contextBudget("balanced", 8000),
      toolSchemaTokens: schemaTokens,
    })
    expect(withSchemas.plan.systemTokens).toBe(base.plan.systemTokens + schemaTokens)
    expect(withSchemas.plan.totalEstimatedTokens).toBeGreaterThan(base.plan.totalEstimatedTokens)
  })
})
