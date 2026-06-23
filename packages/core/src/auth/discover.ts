import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { FALLBACK_CATALOG } from "../provider/catalog"
import { detectLMStudio } from "../provider/lmstudio"
import { detectOllama } from "../provider/ollama"
import { tryGhCliToken } from "./github-oauth"

/**
 * Where a discovered credential came from. Surfaced to the user so they can judge
 * whether to trust it; nothing here is ever used to authenticate without explicit
 * confirmation.
 */
export type CredentialSource =
  | "env"
  | "gh-cli"
  | "local-server"
  | "shell-profile"
  | "opencode"
  | "codex"
  | "claude-code"
  | "aider"

export interface DiscoveredCredential {
  /** Dawn provider id (e.g. "anthropic", "openai", "github-copilot", "ollama"). */
  providerId: string
  source: CredentialSource
  /** Human-readable origin, e.g. "ANTHROPIC_API_KEY in environment" or "~/.zshrc". */
  detail: string
  /** Masked preview for display; empty for keyless local servers. */
  masked: string
  /** The actual key, when one applies. Undefined for keyless local servers. */
  key?: string
  /** True for keyless local providers (Ollama/LM Studio) that need no key. */
  local?: boolean
}

function home(): string {
  return process.env.DAWN_HOME ?? homedir()
}

/** Map of provider env-var name → Dawn provider id, derived from the catalog. */
export function envToProvider(): Map<string, string> {
  const map = new Map<string, string>()
  for (const provider of Object.values(FALLBACK_CATALOG)) {
    for (const env of provider.env ?? []) {
      if (!map.has(env)) map.set(env, provider.id)
    }
  }
  return map
}

/** Mask a secret for display: keep a short head and the last 4 chars. */
export function maskKey(key: string): string {
  const k = key.trim()
  if (k.length <= 8) return "•".repeat(Math.max(3, k.length))
  return `${k.slice(0, 3)}…${k.slice(-4)}`
}

/**
 * Parse `KEY=value` / `export KEY=value` assignments out of a shell profile.
 * Tolerant of quotes, `export`, and inline comments. Pure (no IO) for testing.
 */
export function parseEnvAssignments(content: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$/
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "") // strip trailing comment
    if (!line || line.trimStart().startsWith("#")) continue
    const m = re.exec(line)
    if (!m?.[1]) continue
    const name = m[1]
    let value = m[2] ?? ""
    // Unwrap a single layer of matching quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // Skip values that reference other variables (can't resolve statically)
    if (!value || value.includes("$")) continue
    out.set(name, value)
  }
  return out
}

/** OpenCode stores auth as { providerId: { type, key } } — same shape as Dawn. */
export function parseOpencodeAuth(obj: unknown): Array<{ providerId: string; key: string }> {
  if (!obj || typeof obj !== "object") return []
  const out: Array<{ providerId: string; key: string }> = []
  for (const [providerId, entry] of Object.entries(obj as Record<string, unknown>)) {
    const key = (entry as { key?: unknown })?.key
    if (typeof key === "string" && key) out.push({ providerId, key })
  }
  return out
}

/** Codex stores { OPENAI_API_KEY: "..." } (and sometimes other *_API_KEY fields). */
export function parseCodexAuth(obj: unknown): Array<{ providerId: string; key: string }> {
  if (!obj || typeof obj !== "object") return []
  const map = envToProvider()
  const out: Array<{ providerId: string; key: string }> = []
  for (const [name, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value !== "string" || !value) continue
    const providerId = map.get(name)
    if (providerId) out.push({ providerId, key: value })
  }
  return out
}

function readJsonSafe(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

function readTextSafe(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Discover credentials Dawn could use, from the broadest safe set of sources:
 * provider env vars, the gh CLI (Copilot), running local servers, shell profiles,
 * and other agents' config files. READ-ONLY — never writes auth. Returns one entry
 * per provider (highest-priority source wins). The caller surfaces these for the
 * user to confirm before anything is persisted.
 */
export async function discoverCredentials(): Promise<DiscoveredCredential[]> {
  const byProvider = new Map<string, DiscoveredCredential>()
  // Priority: a provider already seen from a higher source is not overwritten.
  const add = (cred: DiscoveredCredential) => {
    if (!byProvider.has(cred.providerId)) byProvider.set(cred.providerId, cred)
  }

  const envMap = envToProvider()

  // 1. Provider env vars (highest priority — already active at runtime).
  for (const [name, providerId] of envMap) {
    const value = process.env[name]
    if (value) {
      add({
        providerId,
        source: "env",
        detail: `${name} in environment`,
        masked: maskKey(value),
        key: value,
      })
    }
  }

  // 2. gh CLI token → GitHub Copilot.
  try {
    const token = await tryGhCliToken()
    if (token) {
      add({
        providerId: "github-copilot",
        source: "gh-cli",
        detail: "GitHub CLI (gh auth token)",
        masked: maskKey(token),
        key: token,
      })
    }
  } catch {
    /* gh not installed / not logged in */
  }

  // 3. Other agents' config files.
  const h = home()
  const opencodePaths = [
    path.join(h, ".local", "share", "opencode", "auth.json"),
    path.join(h, ".config", "opencode", "auth.json"),
  ]
  for (const file of opencodePaths) {
    for (const { providerId, key } of parseOpencodeAuth(readJsonSafe(file))) {
      add({ providerId, source: "opencode", detail: shorten(file), masked: maskKey(key), key })
    }
  }
  for (const { providerId, key } of parseCodexAuth(readJsonSafe(path.join(h, ".codex", "auth.json")))) {
    add({
      providerId,
      source: "codex",
      detail: shorten(path.join(h, ".codex", "auth.json")),
      masked: maskKey(key),
      key,
    })
  }
  // Claude Code: settings.json may carry an `env` block.
  const claudeSettings = readJsonSafe(path.join(h, ".claude", "settings.json")) as
    | { env?: Record<string, string> }
    | undefined
  if (claudeSettings?.env) {
    for (const [name, value] of Object.entries(claudeSettings.env)) {
      const providerId = envMap.get(name)
      if (providerId && typeof value === "string" && value) {
        add({
          providerId,
          source: "claude-code",
          detail: shorten(path.join(h, ".claude", "settings.json")),
          masked: maskKey(value),
          key: value,
        })
      }
    }
  }

  // 4. Shell profiles + project .env-style files.
  const profiles = [".zshrc", ".bashrc", ".bash_profile", ".profile", ".aider.conf.yml"]
  for (const name of profiles) {
    const file = path.join(h, name)
    const content = readTextSafe(file)
    if (!content) continue
    const source: CredentialSource = name === ".aider.conf.yml" ? "aider" : "shell-profile"
    for (const [envName, value] of parseEnvAssignments(content)) {
      const providerId = envMap.get(envName)
      if (providerId) {
        add({ providerId, source, detail: shorten(file), masked: maskKey(value), key: value })
      }
    }
  }

  // 5. Running local servers (keyless). Lowest priority; surfaced even if cloud keys exist.
  const [ollama, lmstudio] = await Promise.all([
    detectOllama().catch(() => undefined),
    detectLMStudio().catch(() => undefined),
  ])
  if (ollama)
    add({
      providerId: "ollama",
      source: "local-server",
      detail: "Ollama (running locally)",
      masked: "",
      local: true,
    })
  if (lmstudio)
    add({
      providerId: "lmstudio",
      source: "local-server",
      detail: "LM Studio (running locally)",
      masked: "",
      local: true,
    })

  return [...byProvider.values()]
}

/**
 * Persist a confirmed discovered credential so it survives future sessions.
 * Env-sourced and local-server credentials are already active and need no write;
 * file/CLI-sourced keys are copied into Dawn's auth store. Returns true if a write
 * happened. Imported lazily to avoid a static cycle through auth.ts.
 */
export async function persistDiscovered(cred: DiscoveredCredential): Promise<boolean> {
  if (cred.local || cred.source === "env" || !cred.key) return false
  const { setApiKey } = await import("./auth")
  setApiKey(cred.providerId, cred.key)
  return true
}

function shorten(file: string): string {
  const h = home()
  return file.startsWith(h) ? `~${file.slice(h.length)}` : file
}
