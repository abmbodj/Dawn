import fs from "node:fs"
import path from "node:path"
import { z } from "zod"

export const PluginManifestSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
})

export type PluginManifest = z.infer<typeof PluginManifestSchema>

export function readPluginManifest(pluginDir: string): PluginManifest | undefined {
  const file = path.join(pluginDir, ".claude-plugin", "plugin.json")
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const result = PluginManifestSchema.safeParse(raw)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}
