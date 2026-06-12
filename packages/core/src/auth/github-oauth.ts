// client_id is intentionally public — device flow has no client_secret.
// Register a GitHub OAuth App at github.com/settings/applications and replace this value.
export const GITHUB_CLIENT_ID = "REPLACE_WITH_REGISTERED_CLIENT_ID"

const DEVICE_CODE_URL = "https://github.com/login/device/code"
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export async function startDeviceFlow(clientId: string): Promise<DeviceFlowStart> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "read:user" }),
  })
  if (!res.ok) throw new Error(`GitHub device flow failed: ${res.status} ${res.statusText}`)
  const data = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
    error?: string
    error_description?: string
  }
  if (data.error) throw new Error(data.error_description ?? data.error)
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
  }
}

export async function pollForToken(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  signal?: AbortSignal,
): Promise<string> {
  let waitMs = intervalSeconds * 1000
  while (true) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, waitMs)
      signal?.addEventListener("abort", () => {
        clearTimeout(t)
        reject(new Error("OAuth cancelled"))
      })
    })
    if (signal?.aborted) throw new Error("OAuth cancelled")

    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal,
    })
    if (!res.ok) throw new Error(`Token poll failed: ${res.status} ${res.statusText}`)
    const data = (await res.json()) as {
      access_token?: string
      error?: string
      error_description?: string
      interval?: number
    }

    if (data.access_token) return data.access_token
    switch (data.error) {
      case "authorization_pending":
        break
      case "slow_down":
        waitMs = (data.interval ?? intervalSeconds + 5) * 1000
        break
      case "expired_token":
        throw new Error("Device code expired — please try again")
      case "access_denied":
        throw new Error("Authorization denied by user")
      default:
        if (data.error) throw new Error(data.error_description ?? data.error)
    }
  }
}
