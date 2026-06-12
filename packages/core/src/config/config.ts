import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { configDir } from "../paths"

const CustomProviderSchema = z.object({
  /** Display name */
  name: z.string().optional(),
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 */
  baseURL: z.string().optional(),
  /** Env var holding the API key (preferred over inline keys) */
  apiKeyEnv: z.string().optional(),
})

export const DawnConfigSchema = z.object({
  /** Default model as "provider/model", e.g. "anthropic/claude-opus-4-8" */
  model: z.string().optional(),
  /** Extra OpenAI-compatible providers (local models, routers, …) */
  providers: z.record(z.string(), CustomProviderSchema).optional(),
  /** Per-tool permission overrides: allow | ask | deny */
  permissions: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
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
  const merged = {
    ...(global as object),
    ...(project as object),
    providers: {
      ...((global as DawnConfig).providers ?? {}),
      ...((project as DawnConfig).providers ?? {}),
    },
  }
  return DawnConfigSchema.parse(merged)
}
