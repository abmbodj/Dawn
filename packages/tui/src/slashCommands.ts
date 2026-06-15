export interface SlashCommand {
  name: string
  description: string
  aliases?: string[]
  /** Hint for expected arguments, shown dimmed in the suggestion list. */
  args?: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Switch model across connected providers.", args: "[provider/model]" },
  { name: "plan-model", description: "Set the model used while in plan mode.", args: "[provider/model]" },
  { name: "connect", description: "Connect a model provider (API key or GitHub OAuth).", args: "[provider]" },
  { name: "init", description: "Scan the repo and generate an AGENTS.md with project conventions." },
  { name: "skills", description: "Show discovered skills and which are currently loaded in context." },
  { name: "mcp", description: "Show connected MCP servers and their tool counts." },
  { name: "plugin", description: "Show enabled plugins and their commands." },
  { name: "context", description: "Show context budget, working set, and savings." },
  { name: "usage", description: "Show token and cost breakdown for this session." },
  { name: "savings", description: "Show session, project, and lifetime token savings." },
  { name: "new", description: "Start a fresh session." },
  { name: "clear", description: "Clear the visible transcript while keeping the conversation." },
  { name: "reset", description: "Wipe all Dawn data and return to setup wizard." },
  { name: "help", description: "Show TUI help." },
  { name: "quit", description: "Exit Dawn.", aliases: ["exit"] },
]

/** Dynamic commands registered at runtime (e.g., from plugins). */
let dynamicCommands: SlashCommand[] = []

export function registerDynamicCommands(cmds: SlashCommand[]): void {
  dynamicCommands = cmds
}

function allCommands(): SlashCommand[] {
  return [...SLASH_COMMANDS, ...dynamicCommands]
}

export function normalizeSlashCommand(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  const name = trimmed.slice(1).toLowerCase()
  if (!name || /\s/.test(name)) return null
  return name
}

export function resolveSlashCommand(input: string): SlashCommand | undefined {
  const name = normalizeSlashCommand(input)
  if (!name) return undefined
  return allCommands().find((command) => command.name === name || command.aliases?.includes(name))
}

export function getSlashCommandSuggestions(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return []
  const query = input.slice(1).toLowerCase()
  // Once the user types a space they're entering args, not picking a command.
  if (/\s/.test(query)) return []

  // Prefix-match the canonical name OR any alias, so e.g. `/exit` and `/e`
  // surface `quit`. Display order is preserved (filter keeps array order).
  return allCommands().filter((command) =>
    [command.name, ...(command.aliases ?? [])].some((candidate) => candidate.startsWith(query)),
  )
}

export function formatSlashCommandHelp(): string {
  const cmds = allCommands()
  const width = Math.max(...cmds.map((command) => command.name.length))
  const commands = cmds.map((command) => `  /${command.name.padEnd(width)} ${command.description}`).join("\n")
  return `Commands:
${commands}
Autocomplete: type /, Up/Down navigate, Tab complete, Enter run
Keys: Shift+Tab cycles mode (normal / auto-edit / plan) · Esc interrupts a running turn or closes a picker · Ctrl+C quits`
}
