import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { McpServerSchema } from "../mcp/config"
import { configDir } from "../paths"
import type { Catalog } from "../provider/catalog"
import { connectedProviders } from "../provider/provider"

const CustomProviderSchema = z.object({
  /** Display name */
  name: z.string().optional(),
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 */
  baseURL: z.string().optional(),
  /** Env var holding the API key (preferred over inline keys) */
  apiKeyEnv: z.string().optional(),
})

const SkillsConfigSchema = z.object({
  /** Skill names to load into every session (embedded in the cached system prompt). */
  alwaysLoad: z.array(z.string()).optional(),
  /** Map of skill name → glob/keyword patterns; load the skill when a user turn matches. */
  autoTrigger: z.record(z.string(), z.array(z.string())).optional(),
  /** Opt-in: also discover skills from ~/.claude/skills (Claude Code's skill directory). */
  importClaude: z.boolean().optional(),
})

export const DawnConfigSchema = z.object({
  /** Default model as "provider/model", e.g. "anthropic/claude-opus-4-8" */
  model: z.string().optional(),
  /** Model used while in plan mode, as "provider/model". */
  planModel: z.string().optional(),
  /**
   * Model for cheap background/housekeeping work (summarization, compaction, titles,
   * skill-trigger classification), as "provider/model". Defaults to the cheapest
   * blessed model on the primary's provider when unset.
   */
  utilityModel: z.string().optional(),
  /**
   * Whether to silently switch to a fallback model when the active model fails
   * mid-task. Defaults to true; set false for reproducible, single-model runs.
   */
  autoFallback: z.boolean().optional(),
  /** GitHub OAuth App client id for Copilot device authorization. */
  githubOAuthClientId: z.string().optional(),
  /** Extra OpenAI-compatible providers (local models, routers, …) */
  providers: z.record(z.string(), CustomProviderSchema).optional(),
  /** Per-tool permission overrides: allow | ask | deny */
  permissions: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
  /** Skills configuration: always-load, auto-trigger, and import options. */
  skills: SkillsConfigSchema.optional(),
  /** MCP server definitions (Claude Code .mcp.json format). */
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
  /** Plugin configuration. */
  plugins: z.object({ enabled: z.array(z.string()).optional() }).optional(),
})

export type DawnConfig = z.infer<typeof DawnConfigSchema>
export type CustomProvider = z.infer<typeof CustomProviderSchema>

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error(`Failed to parse ${file}: ${err instanceof Error ? err.message : err}`)
  }
}

/** Global config (~/.config/dawn/config.json) overridden by project dawn.json. */
export function loadConfig(cwd: string): DawnConfig {
  const global = readJson(path.join(configDir(), "config.json")) ?? {}
  const project = readJson(path.join(cwd, "dawn.json")) ?? {}
  const g = global as DawnConfig
  const p = project as DawnConfig
  // Union-merge plugins.enabled so project adds to (rather than replaces) personal plugins
  const globalEnabled = g.plugins?.enabled ?? []
  const projectEnabled = p.plugins?.enabled ?? []
  const mergedEnabled = [...new Set([...globalEnabled, ...projectEnabled])]
  const hasMcp = g.mcpServers !== undefined || p.mcpServers !== undefined
  const mergedPlugins =
    mergedEnabled.length > 0
      ? { ...(g.plugins ?? {}), ...(p.plugins ?? {}), enabled: mergedEnabled }
      : (p.plugins ?? g.plugins)
  const merged = {
    ...g,
    ...p,
    providers: { ...(g.providers ?? {}), ...(p.providers ?? {}) },
    ...(hasMcp ? { mcpServers: { ...(g.mcpServers ?? {}), ...(p.mcpServers ?? {}) } } : {}),
    ...(mergedPlugins !== undefined ? { plugins: mergedPlugins } : {}),
  }
  return DawnConfigSchema.parse(merged)
}

/** Merge a patch into the global config (~/.config/dawn/config.json). */
export function saveConfig(patch: Partial<DawnConfig>): void {
  const file = path.join(configDir(), "config.json")
  const current = (readJson(file) as DawnConfig | undefined) ?? {}
  const next = { ...current, ...patch }
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * Whether the user has a model ready to use without further setup: an explicit
 * runtime `config.model`, or a cloud (key-requiring) provider with a live
 * tool-capable model. A reachable local provider (Ollama) alone does NOT count
 * — we still want to run onboarding so the user consciously picks it rather
 * than silently landing on a model their machine may not be able to run.
 */
export function hasConfiguredModel(catalog: Catalog, config: DawnConfig): boolean {
  if (config.model) return true
  return connectedProviders(catalog, config).some((p) => {
    if (!p.hasKey) return false
    const provider = catalog[p.id]
    return (
      provider?.modelsSource === "live" && Object.values(provider.models).some((m) => m.tool_call !== false)
    )
  })
}
