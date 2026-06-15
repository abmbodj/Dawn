import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { DawnConfig } from "../config/config"

const McpStdioSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

const McpHttpSchema = z.object({
  type: z.enum(["http", "sse"]).optional(),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
})

export const McpServerSchema = z.union([McpStdioSchema, McpHttpSchema])
export type McpServerConfig = z.infer<typeof McpServerSchema>
export type McpStdioConfig = z.infer<typeof McpStdioSchema>
export type McpHttpConfig = z.infer<typeof McpHttpSchema>

export function isMcpStdio(config: McpServerConfig): config is McpStdioConfig {
  return "command" in config
}

/** The shape of a .mcp.json file (Claude Code convention). */
const McpJsonFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
})

function readMcpJson(file: string): Record<string, McpServerConfig> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const parsed = McpJsonFileSchema.safeParse(raw)
    return parsed.success ? (parsed.data.mcpServers ?? {}) : {}
  } catch {
    return {}
  }
}

/**
 * Merge MCP server configs from all sources, increasing precedence:
 *   global config → project dawn.json → project-root .mcp.json → plugin-provided
 *
 * Plugin servers are passed in and have the lowest precedence (project overrides them).
 */
export function loadMcpServers(
  cwd: string,
  config: DawnConfig,
  pluginServers: Record<string, McpServerConfig> = {},
): Record<string, McpServerConfig> {
  const globalServers = config.mcpServers ?? {}
  const projectMcpFile = readMcpJson(path.join(cwd, ".mcp.json"))

  return {
    ...pluginServers,
    ...globalServers,
    ...projectMcpFile,
  }
}
