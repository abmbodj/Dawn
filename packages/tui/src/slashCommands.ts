export interface SlashCommand {
  name: string
  description: string
  aliases?: string[]
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Switch model across connected providers." },
  { name: "plan-model", description: "Set the model used while in plan mode." },
  { name: "connect", description: "Connect a model provider (API key or GitHub OAuth)." },
  { name: "context", description: "Show context budget, working set, and savings." },
  { name: "usage", description: "Show token and cost breakdown for this session." },
  { name: "savings", description: "Show session, project, and lifetime token savings." },
  { name: "new", description: "Start a fresh session." },
  { name: "clear", description: "Clear the visible transcript while keeping the conversation." },
  { name: "reset", description: "Wipe all Dawn data and return to setup wizard." },
  { name: "help", description: "Show TUI help." },
  { name: "quit", description: "Exit Dawn.", aliases: ["exit"] },
]

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
  return SLASH_COMMANDS.find((command) => command.name === name || command.aliases?.includes(name))
}

export function getSlashCommandSuggestions(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return []
  const query = input.slice(1).toLowerCase()
  if (/\s/.test(query)) return []
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query))
}

export function formatSlashCommandHelp(): string {
  const width = Math.max(...SLASH_COMMANDS.map((command) => command.name.length))
  const commands = SLASH_COMMANDS.map(
    (command) => `  /${command.name.padEnd(width)} ${command.description}`,
  ).join("\n")
  return `Commands:
${commands}
Autocomplete: type /, Up/Down navigate, Tab complete, Enter run
Keys: Shift+Tab cycles mode (normal / auto-edit / plan) · Esc interrupts a running turn or closes a picker · Ctrl+C quits`
}
