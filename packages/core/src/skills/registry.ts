import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { estimateTokens } from "../context/budget"
import { configDir } from "../paths"
import { parseFrontmatter } from "./frontmatter"
import type { Skill } from "./types"

interface DiscoverOptions {
  importClaude?: boolean
  pluginSkills?: Skill[]
}

function readSkillDir(dir: string, source: Skill["source"], pluginName?: string): Skill[] {
  const skills: Skill[] = []
  if (!fs.existsSync(dir)) return skills
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return skills
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
    if (!description) {
      // skip skills without a description — they'd be useless in the catalog
      continue
    }
    const allowedToolsRaw = frontmatter["allowed-tools"]
    const allowedTools = Array.isArray(allowedToolsRaw)
      ? allowedToolsRaw
      : typeof allowedToolsRaw === "string" && allowedToolsRaw
        ? [allowedToolsRaw]
        : undefined
    skills.push({
      name,
      description,
      body,
      dir: path.join(dir, entry.name),
      source,
      pluginName,
      allowedTools,
      estimatedBodyTokens: estimateTokens(body),
    })
  }
  return skills
}

/**
 * Discover skills from all configured sources. Sources are scanned lowest→highest
 * precedence so later entries win on name collision:
 *   personal (~/.config/dawn/skills) → plugin-provided → project (.dawn/skills) → claude (~/.claude/skills, opt-in)
 */
export function discoverSkills(cwd: string, opts: DiscoverOptions = {}): Skill[] {
  const map = new Map<string, Skill>()

  function addAll(skills: Skill[]) {
    for (const skill of skills) map.set(skill.name, skill)
  }

  addAll(readSkillDir(path.join(configDir(), "skills"), "personal"))
  if (opts.pluginSkills) addAll(opts.pluginSkills)
  addAll(readSkillDir(path.join(cwd, ".dawn", "skills"), "project"))
  if (opts.importClaude) {
    addAll(readSkillDir(path.join(homedir(), ".claude", "skills"), "claude"))
  }

  return [...map.values()]
}

/**
 * Renders the cheap catalog block injected into the (cached) system prompt.
 * Returns "" when there are no skills so no-skill users get a byte-identical prompt.
 */
export function buildSkillCatalog(skills: Skill[]): string {
  if (skills.length === 0) return ""
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  return [
    "# Skills",
    "You can load a skill's full instructions on demand with the skill(name) tool. Available skills:",
    ...lines,
  ].join("\n")
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  return skills.find((s) => s.name === name)
}

/**
 * Returns skills whose autoTrigger patterns match the given user turn text.
 * Patterns are matched as case-insensitive substrings or simple glob path tokens.
 */
export function matchAutoTriggers(
  text: string,
  skills: Skill[],
  autoTrigger: Record<string, string[]>,
): Skill[] {
  const matched: Skill[] = []
  for (const [skillName, patterns] of Object.entries(autoTrigger)) {
    const skill = skills.find((s) => s.name === skillName)
    if (!skill) continue
    for (const pattern of patterns) {
      if (matchesPattern(text, pattern)) {
        matched.push(skill)
        break
      }
    }
  }
  return matched
}

function matchesPattern(text: string, pattern: string): boolean {
  const lower = text.toLowerCase()
  // Glob-style: *.ext → check for .ext anywhere in the text
  if (pattern.startsWith("*.")) {
    return lower.includes(pattern.slice(1).toLowerCase())
  }
  // Path glob: path/** → check if text contains the prefix
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3).toLowerCase()
    return lower.includes(prefix)
  }
  // Plain keyword/substring match
  return lower.includes(pattern.toLowerCase())
}
