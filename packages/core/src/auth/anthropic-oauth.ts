import { createHash, randomBytes } from "node:crypto"
import { getAuthEntry, setOAuthTokens } from "./auth"

// Anthropic OAuth (PKCE), same public client Claude Code uses. Two flavors:
// "max"     — log in with a Claude Pro/Max subscription; requests are billed
//             to the subscription and authenticated with a Bearer token.
// "console" — log in to console.anthropic.com to mint a regular API key.
// All endpoint constants live in this one file.

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const SCOPE = "org:create_api_key user:profile user:inference"
const CREATE_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"

/** Beta header Anthropic requires on OAuth-authenticated API requests. */
export const OAUTH_BETA_HEADER = "oauth-2025-04-20"

/**
 * Subscription requests must present as Claude Code; prepended to the system
 * prompt when the anthropic provider is authenticated via OAuth. Static per
 * session, so prompt caching is unaffected.
 */
export const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

export interface OAuthTokens {
  access: string
  refresh: string
  expires: number
}

export function authorizeUrl(mode: "max" | "console"): { url: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const host = mode === "max" ? "claude.ai" : "console.anthropic.com"
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  })
  return { url: `https://${host}/oauth/authorize?${params.toString()}`, verifier }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

function toTokens(data: TokenResponse): OAuthTokens {
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  }
}

/** Exchange the pasted `code#state` for tokens and persist them for anthropic. */
export async function exchangeCode(pasted: string, verifier: string): Promise<OAuthTokens> {
  const [code, state] = pasted.trim().split("#")
  if (!code) throw new Error("Empty authorization code — paste the code shown after login")
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })
  if (!res.ok) throw new Error(`Anthropic code exchange failed (HTTP ${res.status})`)
  const tokens = toTokens((await res.json()) as TokenResponse)
  setOAuthTokens("anthropic", tokens)
  return tokens
}

/** Console flavor: mint a plain API key using a fresh OAuth access token. */
export async function createApiKeyFromOAuth(access: string): Promise<string> {
  const res = await fetch(CREATE_KEY_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "Content-Type": "application/json" },
  })
  if (!res.ok) throw new Error(`API key creation failed (HTTP ${res.status})`)
  const data = (await res.json()) as { raw_key?: string }
  if (!data.raw_key) throw new Error("API key creation returned no key")
  return data.raw_key
}

// Refresh responses rotate the refresh token, so concurrent refreshes would
// invalidate each other — single-flight the refresh across parallel requests.
let refreshInFlight: Promise<string | undefined> | undefined

/** Current access token for anthropic, refreshing (once) when near expiry. */
export async function accessToken(): Promise<string | undefined> {
  const entry = getAuthEntry("anthropic")
  if (entry?.type !== "oauth") return undefined
  if (entry.expires > Date.now() + 60_000) return entry.access
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: entry.refresh,
            client_id: CLIENT_ID,
          }),
        })
        if (!res.ok) return undefined
        const tokens = toTokens((await res.json()) as TokenResponse)
        setOAuthTokens("anthropic", tokens)
        return tokens.access
      } catch {
        return undefined
      } finally {
        refreshInFlight = undefined
      }
    })()
  }
  return refreshInFlight
}

/**
 * fetch wrapper for the AI SDK's anthropic transport when authenticated via
 * OAuth: swaps x-api-key for a Bearer token and adds the OAuth beta header
 * (appending, so SDK-set beta features like prompt caching survive).
 */
export async function anthropicOAuthFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const access = await accessToken()
  if (!access) throw new Error("Anthropic OAuth session expired — run `dawn auth login anthropic`")
  const headers = new Headers(init?.headers)
  headers.delete("x-api-key")
  headers.set("authorization", `Bearer ${access}`)
  const beta = headers.get("anthropic-beta")
  headers.set("anthropic-beta", beta ? `${OAUTH_BETA_HEADER},${beta}` : OAUTH_BETA_HEADER)
  return fetch(input, { ...init, headers })
}
