import fs from "node:fs"
import path from "node:path"
import { parseFrontmatter } from "../skills/frontmatter"

export interface PluginCommand {
  /** Slash command name (without leading /). */
  name: string
  description: string
  argHint?: string
  /** Raw markdown body — the prompt template. */
  body: string
  pluginName: string
}

/** Load all plugin slash commands from a plugin's commands/ directory. */
export function loadPluginCommands(pluginDir: string, pluginName: string): PluginCommand[] {
  const commandsDir = path.join(pluginDir, "commands")
  const commands: PluginCommand[] = []
  if (!fs.existsSync(commandsDir)) return commands

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(commandsDir, { withFileTypes: true })
  } catch {
    return commands
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const file = path.join(commandsDir, entry.name)
    let raw: string
    try {
      raw = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    const { frontmatter, body } = parseFrontmatter(raw)
    const name = entry.name.replace(/\.md$/, "")
    const description = (frontmatter.description as string | undefined) ?? `Plugin command: ${name}`
    const argHint = frontmatter["argument-hint"] as string | undefined
    commands.push({ name, description, argHint, body: body.trim(), pluginName })
  }

  return commands
}

/**
 * Render a plugin command body substituting $ARGUMENTS and positional $1, $2, …
 * following Claude Code semantics.
 */
export function renderCommandPrompt(cmd: PluginCommand, args: string): string {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  let result = cmd.body.replaceAll("$ARGUMENTS", args.trim())
  for (let i = 0; i < parts.length; i++) {
    result = result.replaceAll(`$${i + 1}`, parts[i] ?? "")
  }
  return result
}
