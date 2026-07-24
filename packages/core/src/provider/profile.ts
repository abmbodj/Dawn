import type { ContextMode } from "../context/types"
import {
  type Catalog,
  getModelInfo,
  type ModelInfo,
  type ModelTier,
  modelCaches,
  modelTier,
  normalizeModelRef,
  parseModelRef,
} from "./catalog"
/** Tokens used above this threshold are considered "ample" — TTL eviction becomes a last resort. */
export const AMPLE_BUDGET_THRESHOLD = 20_000
/** Lean budget for non-caching providers (matches the original tight default). */
export const LEAN_TOKEN_BUDGET = 8_000

/**
 * Modest fraction of the model window when prompt caching amortizes the stable prefix.
 * Kept small on purpose: a 65%-of-window budget let investigate tasks retain huge tool
 * outputs and lose $ vs `--naive` despite cache reads.
 */
const CACHED_BUDGET_FRACTION: Record<ContextMode, number> = {
  minimal: 0.06,
  balanced: 0.1,
  deep: 0.15,
}

/** Absolute ceiling for caching-model budgets (wins over window×fraction). */
const CACHED_BUDGET_CAP: Record<ContextMode, number> = {
  minimal: 12_000,
  balanced: 20_000,
  deep: 32_000,
}

/** Lean budgets when every re-send is billed at full input price. */
const LEAN_BUDGET_BY_MODE: Record<ContextMode, number> = {
  minimal: 6_000,
  balanced: LEAN_TOKEN_BUDGET,
  deep: 12_000,
}

/**
 * Compute the effective token budget for a model + context mode.
 * Caching models (`promptCaches`) get a modest uplift over lean so cache amortization
 * can help — hard-capped so investigate tasks cannot inflate to tens of thousands of
 * retained tokens. Non-caching / local providers stay lean.
 */
export function budgetFor(
  profile: Pick<ModelProfile, "promptCaches">,
  info?: ModelInfo,
  mode: ContextMode = "balanced",
): number {
  if (!profile.promptCaches) return LEAN_BUDGET_BY_MODE[mode]
  const windowTokens = info?.limit?.context
  if (!windowTokens) return LEAN_BUDGET_BY_MODE[mode]
  return Math.min(CACHED_BUDGET_CAP[mode], Math.floor(windowTokens * CACHED_BUDGET_FRACTION[mode]))
}

/**
 * How a model's "thinking"/reasoning parts are handled in request messages.
 * - "native"  — keep reasoning parts (provider accepts them, e.g. Anthropic).
 * - "strip"   — remove reasoning parts before sending (OpenAI-compatible APIs
 *               like Groq reject reasoning_content even from their own models).
 * - "none"    — the model emits no reasoning; nothing to do.
 */
export type ReasoningHandling = "native" | "strip" | "none"

/** Coarse model family, inferred from provider + model id, used for long-tail defaults. */
export type ModelFamily =
  | "claude"
  | "gpt"
  | "gemini"
  | "gemma"
  | "grok"
  | "llama"
  | "qwen"
  | "mistral"
  | "deepseek"
  | "unknown"

/**
 * Declarative description of how Dawn should drive a given model. Resolved per
 * active model (which can change mid-turn via plan mode or auto-switch), so the
 * agent loop reads behavior from here instead of branching on `isAnthropic`.
 *
 * Blessed models get hand-tuned values; everything else is inferred from family
 * then falls back to a safe generic default.
 */
export interface ModelProfile {
  ref: string
  providerId: string
  modelId: string
  family: ModelFamily
  tier: ModelTier
  /** Reasoning-part handling for request messages. */
  reasoning: ReasoningHandling
  /** Apply the malformed-tool-call repair shim (markdown-fenced / double-encoded JSON, fuzzy names). */
  toolRepair: boolean
  /**
   * Re-sent stable prefix can be amortized via provider prompt cache (catalog `cache_read`
   * pricing and/or Anthropic-style breakpoints). Drives adaptive budget + summary share.
   */
  promptCaches: boolean
  /** Provider accepts explicit Anthropic-style `cacheControl` breakpoints on messages. */
  cacheBreakpoints: boolean
  /**
   * Extra per-turn system guidance, appended AFTER the cached prompt prefix so it
   * never invalidates the cache. Undefined for strong models that need no scaffolding.
   */
  promptDelta?: string
  /**
   * Generation defaults; undefined fields leave the provider/SDK default in place.
   * For reasoning models: temperature is undefined (omit from request), maxTokens
   * is set via max_completion_tokens on OpenAI-compatible providers.
   */
  params: {
    temperature?: number
    maxTokens?: number
    /** True when the model requires max_completion_tokens instead of max_tokens. */
    useMaxCompletionTokens?: boolean
  }
  /** Capability flags surfaced in the picker and used for routing decisions. */
  capabilities: { vision: boolean; reasoning: boolean }
}

/** Families that are open-weight / smaller and benefit from explicit step-by-step scaffolding. */
const STRUCTURED_FAMILIES: ReadonlySet<ModelFamily> = new Set<ModelFamily>([
  "llama",
  "qwen",
  "mistral",
  "deepseek",
  "gemma",
  "unknown",
])

/** Families with strong native vision support (used only for the picker capability chip). */
const VISION_FAMILIES: ReadonlySet<ModelFamily> = new Set<ModelFamily>(["claude", "gpt", "gemini", "grok"])

/**
 * Per-turn guidance appended for long-tail / experimental models. Strong flagship
 * models (claude/gpt/gemini/grok) get no delta — they already work this way.
 */
const STRUCTURED_DELTA =
  "Work in small, explicit steps: name the file you're about to change before you edit it, " +
  "make one focused tool call at a time, and check the result before moving on. " +
  "Prefer the simplest change that satisfies the request, and don't invent files, flags, or APIs."

export function detectFamily(providerId: string, modelId: string): ModelFamily {
  const id = modelId.toLowerCase()
  if (providerId === "anthropic" || id.includes("claude")) return "claude"
  if (id.includes("gemini")) return "gemini"
  if (id.includes("gemma")) return "gemma"
  if (id.includes("grok")) return "grok"
  if (id.includes("gpt") || /\bo[1345]\b/.test(id) || id.startsWith("o1") || id.startsWith("o3")) return "gpt"
  if (id.includes("llama")) return "llama"
  if (id.includes("qwen") || id.includes("qwq")) return "qwen"
  if (
    id.includes("mistral") ||
    id.includes("mixtral") ||
    id.includes("codestral") ||
    id.includes("magistral")
  )
    return "mistral"
  if (id.includes("deepseek")) return "deepseek"
  return "unknown"
}

/**
 * Whether a model is reasoning-class and needs special request shaping:
 * - Omit temperature (these models don't accept it)
 * - Use max_completion_tokens instead of max_tokens on OpenAI-compatible providers
 * Detected via catalog flag first, then id heuristics for known families.
 */
function isReasoningModel(modelId: string, info: ModelInfo | undefined): boolean {
  if (info?.reasoning === true) return true
  const id = modelId.toLowerCase()
  // OpenAI o-series, GPT-5.x, codex
  if (/\bo[1345](?:-|$)/.test(id) || id.startsWith("o1") || id.startsWith("o3")) return true
  if (id.startsWith("gpt-5") || id.includes("codex")) return true
  // DeepSeek-R1 / Qwen-QwQ reasoning models
  if (id.includes("deepseek-r") || id.includes("qwq")) return true
  return false
}

/**
 * Resolve the behavior profile for a model ref. Order: blessed tier (hand-tuned)
 * → family inference → safe generic default. Pure and data-driven; unit-tested in
 * profile.test.ts.
 */
export function resolveProfile(ref: string, catalog: Catalog): ModelProfile {
  ref = normalizeModelRef(ref)
  const { providerId, modelId } = parseModelRef(ref)
  const info: ModelInfo | undefined = getModelInfo(catalog, ref)
  const tier = modelTier(ref, info)
  const family = detectFamily(providerId, modelId)

  // Claude accepts reasoning parts and supports Anthropic-style prompt caching —
  // true whether served by Anthropic directly or via Bedrock. OpenAI-compatible
  // transports (incl. Vertex/Azure for non-Claude) reject reasoning_content, so strip.
  const reasoning: ReasoningHandling = family === "claude" ? "native" : "strip"
  const cacheBreakpoints = family === "claude" && (providerId === "anthropic" || providerId === "bedrock")
  // Catalog `cache_read` means the provider bills cached input separately (OpenAI, Google, …).
  // Combined with explicit breakpoints, this drives budget + summary share — not breakpoint markup.
  const promptCaches = cacheBreakpoints || modelCaches(info)

  // Strong flagships need no scaffolding; open-weight / experimental models get structure.
  const wantsStructure = tier === "experimental" || (tier === "standard" && STRUCTURED_FAMILIES.has(family))
  const promptDelta = wantsStructure ? STRUCTURED_DELTA : undefined

  const isReasoning = isReasoningModel(modelId, info)
  // Reasoning models (o-series, codex, deepseek-r1, etc.) reject temperature and
  // expect max_completion_tokens on OpenAI-compatible transports.
  const params: ModelProfile["params"] = isReasoning ? { useMaxCompletionTokens: true } : {}

  return {
    ref,
    providerId,
    modelId,
    family,
    tier,
    reasoning,
    // Repair is cheap and harmless; keep it on everywhere. The flag lets a future
    // profile disable it for a model that never malforms.
    toolRepair: true,
    promptCaches,
    cacheBreakpoints,
    promptDelta,
    params,
    capabilities: {
      vision: VISION_FAMILIES.has(family),
      reasoning: isReasoning,
    },
  }
}
