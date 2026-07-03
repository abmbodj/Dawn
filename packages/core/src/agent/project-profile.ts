import fs from "node:fs"
import path from "node:path"

export interface CheckCommand {
  label: string
  command: string
  /** "fast" commands run automatically after edits; "slow" only when explicitly requested. */
  speed: "fast" | "slow"
}

export interface ProjectProfile {
  checkCommands: CheckCommand[]
}

interface PackageJson {
  scripts?: Record<string, string>
}

const FAST_SCRIPT_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /^(type[:-]?check|tsc)$/i, label: "typecheck" },
  { regex: /^lint(:.*)$/i, label: "lint" },
  { regex: /^check$/i, label: "check" },
  { regex: /^(validate|verify)$/i, label: "validate" },
]

const SLOW_SCRIPT_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /^(test|tests)$/i, label: "test" },
  { regex: /^test:affected$/i, label: "test:affected" },
  { regex: /^test:unit$/i, label: "test:unit" },
  { regex: /^build$/i, label: "build" },
]

function detectFromPackageJson(cwd: string): CheckCommand[] {
  const pkgPath = path.join(cwd, "package.json")
  try {
    const raw = fs.readFileSync(pkgPath, "utf8")
    const pkg = JSON.parse(raw) as PackageJson
    const scripts = pkg.scripts ?? {}
    const commands: CheckCommand[] = []
    const seen = new Set<string>()

    for (const [name] of Object.entries(scripts)) {
      if (seen.has(name)) continue
      for (const { regex, label } of FAST_SCRIPT_PATTERNS) {
        if (regex.test(name)) {
          seen.add(name)
          commands.push({ label, command: `bun run ${name}`, speed: "fast" })
          break
        }
      }
      for (const { regex, label } of SLOW_SCRIPT_PATTERNS) {
        if (regex.test(name)) {
          seen.add(name)
          commands.push({ label, command: `bun run ${name}`, speed: "slow" })
          break
        }
      }
    }

    // Fallback: if no typecheck found but tsc is available, add it directly
    if (!commands.some((c) => c.label === "typecheck")) {
      const tscPath = path.join(cwd, "node_modules", ".bin", "tsc")
      const hasTsConfig = fs.existsSync(path.join(cwd, "tsconfig.json"))
      if (hasTsConfig && fs.existsSync(tscPath)) {
        commands.unshift({ label: "typecheck", command: "tsc --noEmit", speed: "fast" })
      }
    }
    return commands
  } catch {
    return []
  }
}

function detectFromBiome(cwd: string): CheckCommand[] {
  const biomePath = path.join(cwd, "biome.json")
  if (!fs.existsSync(biomePath)) return []
  const binPath = path.join(cwd, "node_modules", ".bin", "biome")
  if (!fs.existsSync(binPath)) return []
  return [{ label: "lint (biome)", command: "biome check .", speed: "fast" }]
}

/**
 * Discover the project's check commands from package.json scripts and tooling
 * config files. Returns a prioritized list: fast (typecheck/lint) first, slow
 * (tests, build) last. Called once at session start; result is stable.
 */
export function detectProjectProfile(cwd: string): ProjectProfile {
  const commands: CheckCommand[] = []
  const seen = new Set<string>()

  for (const cmd of detectFromPackageJson(cwd)) {
    if (!seen.has(cmd.label)) {
      seen.add(cmd.label)
      commands.push(cmd)
    }
  }

  // Biome is common in the TS ecosystem; if package.json has no lint entry, add it
  if (!seen.has("lint (biome)") && !seen.has("lint")) {
    for (const cmd of detectFromBiome(cwd)) {
      seen.add(cmd.label)
      commands.push(cmd)
    }
  }

  return { checkCommands: commands }
}

/**
 * Format the project profile into a system-prompt section describing which
 * commands to run after edits. Injected into the stable system prompt so the
 * model always knows the right commands without re-detecting each turn.
 */
export function formatProjectProfileSection(profile: ProjectProfile): string | undefined {
  if (profile.checkCommands.length === 0) return undefined
  const fast = profile.checkCommands.filter((c) => c.speed === "fast")
  const slow = profile.checkCommands.filter((c) => c.speed === "slow")
  const lines: string[] = ["# Project checks"]
  if (fast.length > 0) {
    lines.push("After making code changes, run these fast checks automatically before closing the turn:")
    for (const cmd of fast) lines.push(`- ${cmd.label}: \`${cmd.command}\``)
    lines.push("Fix any failures before finishing.")
  }
  if (slow.length > 0) {
    lines.push("These slower checks exist but run only when explicitly requested:")
    for (const cmd of slow) lines.push(`- ${cmd.label}: \`${cmd.command}\``)
  }
  return lines.join("\n")
}
