import {
  type Catalog,
  getModelInfo,
  type ModelInfo,
  type ModelTier,
  modelTier,
  normalizeModelRef,
  parseModelRef,
} from "./catalog"

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
  /** Provider supports prompt caching via cacheControl breakpoints (Anthropic-style). */
  supportsCaching: boolean
  /**
   * Extra per-turn system guidance, appended AFTER the cached prompt prefix so it
   * never invalidates the cache. Undefined for strong models that need no scaffolding.
   */
  promptDelta?: string
  /** Generation defaults; undefined fields leave the provider/SDK default in place. */
  params: { temperature?: number; maxTokens?: number }
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
  const supportsCaching = family === "claude" && (providerId === "anthropic" || providerId === "bedrock")

  // Strong flagships need no scaffolding; open-weight / experimental models get structure.
  const wantsStructure = tier === "experimental" || (tier === "standard" && STRUCTURED_FAMILIES.has(family))
  const promptDelta = wantsStructure ? STRUCTURED_DELTA : undefined

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
    supportsCaching,
    promptDelta,
    params: {},
    capabilities: {
      vision: VISION_FAMILIES.has(family),
      reasoning: info?.reasoning ?? false,
    },
  }
}
