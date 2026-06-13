import { describe, expect, test } from "bun:test"
import {
  formatSlashCommandHelp,
  getSlashCommandSuggestions,
  resolveSlashCommand,
  SLASH_COMMANDS,
} from "../src/slashCommands"

describe("slash command suggestions", () => {
  test("/ returns every canonical command in display order", () => {
    expect(getSlashCommandSuggestions("/").map((command) => command.name)).toEqual(
      SLASH_COMMANDS.map((command) => command.name),
    )
  })

  test("filters by prefix", () => {
    expect(getSlashCommandSuggestions("/m").map((command) => command.name)).toEqual(["model"])
    expect(getSlashCommandSuggestions("/s").map((command) => command.name)).toEqual(["savings"])
  })

  test("matching is case-insensitive", () => {
    expect(getSlashCommandSuggestions("/M").map((command) => command.name)).toEqual(["model"])
  })

  test("hides suggestions after whitespace", () => {
    expect(getSlashCommandSuggestions("/model ")).toEqual([])
  })

  test("suggests commands by alias prefix", () => {
    expect(getSlashCommandSuggestions("/e").map((command) => command.name)).toEqual(["quit"])
    expect(getSlashCommandSuggestions("/exit").map((command) => command.name)).toEqual(["quit"])
  })

  test("unknown prefixes return no suggestions", () => {
    expect(getSlashCommandSuggestions("/nope")).toEqual([])
  })
})

describe("slash command resolution", () => {
  test("resolves canonical command names", () => {
    expect(resolveSlashCommand("/help")?.name).toBe("help")
  })

  test("resolves aliases to their canonical command", () => {
    expect(resolveSlashCommand("/exit")?.name).toBe("quit")
  })

  test("rejects commands with arguments for command-only v1", () => {
    expect(resolveSlashCommand("/model anthropic/claude")).toBeUndefined()
  })
})

describe("slash command help", () => {
  test("includes every canonical command and autocomplete guidance", () => {
    const help = formatSlashCommandHelp()
    for (const command of SLASH_COMMANDS) {
      expect(help).toContain(`/${command.name}`)
    }
    expect(help).toContain("Autocomplete:")
  })
})
