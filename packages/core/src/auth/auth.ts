import fs from "node:fs"
import path from "node:path"
import { dataDir } from "../paths"

export type AuthEntry =
  | { type: "api"; key: string }
  | { type: "oauth"; access: string; refresh: string; expires: number }

type AuthFile = Record<string, AuthEntry>

function authPath(): string {
  return path.join(dataDir(), "auth.json")
}

function readAuthFile(): AuthFile {
  try {
    return JSON.parse(fs.readFileSync(authPath(), "utf8"))
  } catch {
    return {}
  }
}

function writeAuthFile(data: AuthFile): void {
  fs.writeFileSync(authPath(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(authPath(), 0o600)
}

export function setApiKey(providerId: string, key: string): void {
  const data = readAuthFile()
  data[providerId] = { type: "api", key }
  writeAuthFile(data)
}

export function removeApiKey(providerId: string): boolean {
  const data = readAuthFile()
  if (!(providerId in data)) return false
  delete data[providerId]
  writeAuthFile(data)
  return true
}

export function listAuthProviders(): string[] {
  return Object.keys(readAuthFile())
}

export function getAuthEntry(providerId: string): AuthEntry | undefined {
  return readAuthFile()[providerId]
}

export function setOAuthTokens(
  providerId: string,
  tokens: { access: string; refresh: string; expires: number },
): void {
  const data = readAuthFile()
  data[providerId] = { type: "oauth", ...tokens }
  writeAuthFile(data)
}

export function hasOAuth(providerId: string): boolean {
  return readAuthFile()[providerId]?.type === "oauth"
}

/**
 * Resolve an API key for a provider: explicit auth store first,
 * then any of the provider's documented env vars. OAuth entries are
 * not API keys — callers check hasOAuth() separately.
 */
export function resolveApiKey(providerId: string, envNames: string[] = []): string | undefined {
  const stored = readAuthFile()[providerId]
  if (stored?.type === "api" && stored.key) return stored.key
  for (const name of envNames) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}
