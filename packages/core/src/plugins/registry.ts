import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { DawnConfig } from "../config/config"
import { estimateTokens } from "../context/budget"
import type { McpServerConfig } from "../mcp/config"
import { McpServerSchema } from "../mcp/config"
import { configDir } from "../paths"
import { parseFrontmatter } from "../skills/frontmatter"
import type { Skill } from "../skills/types"
import { loadPluginCommands, type PluginCommand } from "./commands"
import { type PluginManifest, readPluginManifest } from "./manifest"

export interface InstalledPlugin {
  name: string
  dir: string
  manifest: PluginManifest
  skills: Skill[]
  commands: PluginCommand[]
  mcpServers: Record<string, McpServerConfig>
}

export function pluginsDir(): string {
  const dir = path.join(configDir(), "plugins")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function readPluginMcpServers(pluginDir: string): Record<string, McpServerConfig> {
  const file = path.join(pluginDir, ".mcp.json")
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const schema = z.object({ mcpServers: z.record(z.string(), McpServerSchema).optional() })
    const parsed = schema.safeParse(raw)
    return parsed.success ? (parsed.data.mcpServers ?? {}) : {}
  } catch {
    return {}
  }
}

function loadPlugin(pluginDir: string): InstalledPlugin | undefined {
  const manifest = readPluginManifest(pluginDir)
  if (!manifest) return undefined

  // Skills live under <pluginDir>/skills/<name>/SKILL.md
  // Use readSkillDir from registry to scan that specific directory directly.
  // We re-export a minimal version here to avoid circular dependency.
  const pluginSkillsDir = path.join(pluginDir, "skills")
  const rawSkills = discoverSkillsFromDir(pluginSkillsDir)
  const skills = rawSkills.map((s) => ({ ...s, source: "plugin" as const, pluginName: manifest.name }))

  return {
    name: manifest.name,
    dir: pluginDir,
    manifest,
    skills,
    commands: loadPluginCommands(pluginDir, manifest.name),
    mcpServers: readPluginMcpServers(pluginDir),
  }
}

/** Read skills from a flat skills directory (each subdirectory = one skill). */
function discoverSkillsFromDir(dir: string): Skill[] {
  if (!fs.existsSync(dir)) return []
  const skills: Skill[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(dir, entry.name, "SKILL.md")
    if (!fs.existsSync(skillFile)) continue
    let raw: string
    try {
      raw = fs.readFileSync(skillFile, "utf8")
    } catch {
      continue
    }
    const { frontmatter, body } = parseFrontmatter(raw)
    const name = (frontmatter.name as string | undefined) ?? entry.name
    const description = frontmatter.description as string | undefined
    if (!description) continue
    skills.push({
      name,
      description,
      body,
      dir: path.join(dir, entry.name),
      source: "plugin" as const,
      estimatedBodyTokens: estimateTokens(body),
    })
  }
  return skills
}

/** Scan pluginsDir() for installed plugins (have a .claude-plugin/plugin.json). */
export function listInstalledPlugins(): InstalledPlugin[] {
  const dir = pluginsDir()
  const plugins: InstalledPlugin[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return plugins
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const plugin = loadPlugin(path.join(dir, entry.name))
    if (plugin) plugins.push(plugin)
  }
  return plugins
}

/**
 * Load only the plugins listed in config.plugins.enabled.
 * Union merge: a plugin enabled globally is also active in projects that don't override it.
 */
export function loadEnabledPlugins(config: DawnConfig): InstalledPlugin[] {
  const enabled = config.plugins?.enabled ?? []
  if (enabled.length === 0) return []
  const all = listInstalledPlugins()
  return all.filter((p) => enabled.includes(p.name))
}

/**
 * Collect all plugin MCP servers for merging into the global MCP config.
 * Plugin servers have the lowest precedence (global/project config overrides them).
 */
export function pluginMcpServers(plugins: InstalledPlugin[]): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {}
  for (const plugin of plugins) {
    for (const [name, config] of Object.entries(plugin.mcpServers)) {
      result[name] = config
    }
  }
  return result
}

/**
 * Clone a git repository or symlink a local path into pluginsDir() as a new plugin.
 * Returns the loaded plugin on success.
 */
export async function addPlugin(source: string): Promise<InstalledPlugin> {
  const isLocalPath = source.startsWith("/") || source.startsWith("./") || source.startsWith("../")
  const dest = isLocalPath ? path.resolve(source) : undefined

  if (isLocalPath && dest) {
    // For local paths, read manifest to get canonical name
    const manifest = readPluginManifest(dest)
    if (!manifest) throw new Error(`No .claude-plugin/plugin.json found at ${dest}`)
    const link = path.join(pluginsDir(), manifest.name)
    if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true })
    fs.symlinkSync(dest, link, "dir")
    const plugin = loadPlugin(link)
    if (!plugin) throw new Error(`Failed to load plugin from ${dest}`)
    return plugin
  }

  // Git URL: clone into pluginsDir/<repo-name>
  const repoName =
    source
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") ?? "plugin"
  const cloneDest = path.join(pluginsDir(), repoName)
  if (fs.existsSync(cloneDest)) fs.rmSync(cloneDest, { recursive: true, force: true })

  const proc = Bun.spawn(["git", "clone", "--depth", "1", source, cloneDest], {
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`git clone failed with exit code ${exitCode}`)

  const plugin = loadPlugin(cloneDest)
  if (!plugin) throw new Error(`No .claude-plugin/plugin.json found in cloned repo at ${cloneDest}`)
  return plugin
}

/** Remove a plugin by name from pluginsDir(). */
export function removePlugin(name: string): void {
  const dir = path.join(pluginsDir(), name)
  if (!fs.existsSync(dir)) throw new Error(`Plugin "${name}" not found in ${pluginsDir()}`)
  fs.rmSync(dir, { recursive: true, force: true })
}
