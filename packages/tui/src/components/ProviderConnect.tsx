import {
  type DawnConfig,
  type DeviceFlowStart,
  openExternalUrl,
  pollForToken,
  resolveGithubClientId,
  setApiKey,
  startDeviceFlow,
} from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { theme } from "../theme"

export interface ProviderOption {
  id: string
  label: string
  url: string
  defaultModel: string
  envVar: string
}

export const SETUP_PROVIDERS: [ProviderOption, ...ProviderOption[]] = [
  {
    id: "github-copilot",
    label: "GitHub Copilot  (login with GitHub)",
    url: "github.com/settings/copilot",
    defaultModel: "github-copilot/gpt-4o",
    envVar: "GITHUB_COPILOT_TOKEN",
  },
  {
    id: "groq",
    label: "Groq  (free — no credit card)",
    url: "console.groq.com",
    defaultModel: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
    envVar: "GROQ_API_KEY",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    url: "console.anthropic.com",
    defaultModel: "anthropic/claude-opus-4-8",
    envVar: "ANTHROPIC_API_KEY",
  },
  {
    id: "openai",
    label: "OpenAI",
    url: "platform.openai.com",
    defaultModel: "openai/gpt-5.5",
    envVar: "OPENAI_API_KEY",
  },
  {
    id: "google",
    label: "Google AI",
    url: "aistudio.google.com",
    defaultModel: "google/gemini-3.5-flash",
    envVar: "GOOGLE_API_KEY",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    url: "x.ai/api",
    defaultModel: "xai/grok-3",
    envVar: "XAI_API_KEY",
  },
  {
    id: "mistral",
    label: "Mistral",
    url: "console.mistral.ai",
    defaultModel: "mistral/mistral-large-latest",
    envVar: "MISTRAL_API_KEY",
  },
]

export interface ProviderConnectProps {
  /** When set, skip the pick phase and go straight to key/oauth for this provider. */
  provider?: ProviderOption
  /** Providers to offer in the pick phase (default: SETUP_PROVIDERS). Caller pre-filters. */
  providers?: ProviderOption[]
  /** Extra entries appended to the pick list (Setup uses this for local Ollama models). */
  extraOptions?: { name: string; value: string; description: string }[]
  config?: DawnConfig
  openUrl?: (url: string) => Promise<boolean>
  startDeviceFlowFn?: typeof startDeviceFlow
  pollForTokenFn?: typeof pollForToken
  onExtraSelect?: (value: string) => void
  /** API key saved / OAuth completed. setApiKey already called — NO saveConfig here. */
  onConnected: (provider: ProviderOption) => void
  onCancel: () => void
}

export function ProviderConnect({
  provider: fixedProvider,
  providers = SETUP_PROVIDERS,
  extraOptions = [],
  config,
  openUrl = openExternalUrl,
  startDeviceFlowFn = startDeviceFlow,
  pollForTokenFn = pollForToken,
  onExtraSelect,
  onConnected,
  onCancel,
}: ProviderConnectProps) {
  const githubClientId = resolveGithubClientId(config)
  const [phase, setPhase] = useState<"pick" | "key" | "oauth">(() => {
    if (!fixedProvider) return "pick"
    return fixedProvider.id === "github-copilot" && githubClientId ? "oauth" : "key"
  })
  const [selected, setSelected] = useState<ProviderOption>(
    fixedProvider ?? providers[0] ?? SETUP_PROVIDERS[0],
  )
  const [error, setError] = useState<string | null>(null)
  const [oauthData, setOauthData] = useState<DeviceFlowStart | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [browserOpenStatus, setBrowserOpenStatus] = useState<"opened" | "manual" | null>(null)
  const oauthAbortRef = useRef<AbortController | null>(null)

  // When a fixed provider is given, start its flow on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect; component is keyed externally
  useEffect(() => {
    if (!fixedProvider) return
    if (fixedProvider.id === "github-copilot" && githubClientId) {
      startGithubOAuth(fixedProvider)
    }
    // key phase: no auto-start needed, user pastes
  }, [])

  const startGithubOAuth = (prov: ProviderOption) => {
    if (!githubClientId) {
      setPhase("key")
      return
    }
    setOauthData(null)
    setOauthError(null)
    setBrowserOpenStatus(null)
    const abort = new AbortController()
    oauthAbortRef.current = abort
    ;(async () => {
      try {
        const flow = await startDeviceFlowFn(githubClientId)
        setOauthData(flow)
        const opened = await openUrl(flow.verificationUri)
        if (!abort.signal.aborted) {
          setBrowserOpenStatus(opened ? "opened" : "manual")
        }
        const token = await pollForTokenFn(githubClientId, flow.deviceCode, flow.interval, abort.signal)
        setApiKey("github-copilot", token)
        onConnected(prov)
      } catch (err: unknown) {
        if (!abort.signal.aborted) {
          setOauthError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (phase === "oauth") {
        oauthAbortRef.current?.abort()
        oauthAbortRef.current = null
        setOauthData(null)
        setOauthError(null)
        setBrowserOpenStatus(null)
      }
      if (phase === "key" || phase === "oauth") {
        if (fixedProvider) {
          onCancel()
        } else {
          setPhase("pick")
          setError(null)
        }
      } else {
        onCancel()
      }
    }
  })

  const handleProviderPick = (_i: number, opt: any) => {
    const value: string | undefined = opt?.value
    if (!value) return
    if (value.startsWith("extra:")) {
      onExtraSelect?.(value.slice("extra:".length))
      return
    }
    const prov = providers.find((p) => p.id === value)
    if (!prov) return
    setSelected(prov)
    setError(null)

    if (value === "github-copilot") {
      if (githubClientId) {
        setPhase("oauth")
        startGithubOAuth(prov)
      } else {
        setPhase("key")
      }
      return
    }
    setPhase("key")
  }

  const handleKeySubmit = (raw: unknown) => {
    const key = (typeof raw === "string" ? raw : String((raw as any)?.value ?? "")).trim()
    if (!key) {
      setError("Key cannot be empty — paste your API key above and press Enter")
      return
    }
    setApiKey(selected.id, key)
    onConnected(selected)
  }

  const pickerOptions = [
    ...providers.map((p) => ({
      name: p.label,
      value: p.id,
      description: `${p.envVar}  ·  ${p.url}`,
    })),
    ...extraOptions.map((o) => ({ ...o, value: `extra:${o.value}` })),
  ]

  if (phase === "pick") {
    return (
      <box style={{ flexDirection: "column" }}>
        <box
          style={{
            border: true,
            borderColor: theme.accent,
            height: 12,
            flexDirection: "column",
            marginBottom: 1,
          }}
          title="choose provider"
        >
          <select
            focused
            showScrollIndicator
            options={pickerOptions}
            onSelect={handleProviderPick}
            style={{ flexGrow: 1 }}
          />
        </box>
        <text fg={theme.dim}>{"↑↓ navigate · Enter select · Esc cancel"}</text>
      </box>
    )
  }

  if (phase === "oauth") {
    return (
      <box style={{ flexDirection: "column" }}>
        <text fg={theme.text} style={{ marginBottom: 1 }}>
          {"Connect your GitHub Copilot subscription"}
        </text>
        <box
          style={{
            border: true,
            borderColor: theme.accent,
            padding: 1,
            flexDirection: "column",
            marginBottom: 1,
          }}
          title="GitHub device authorization"
        >
          {oauthData ? (
            <>
              <text fg={theme.dim}>{"1. Open this URL in your browser:"}</text>
              <text fg={theme.accent} style={{ marginBottom: 1 }}>
                {"   github.com/login/device"}
              </text>
              {browserOpenStatus ? (
                <text fg={theme.dim} style={{ marginBottom: 1 }}>
                  {browserOpenStatus === "opened"
                    ? "Browser opened automatically. Use the code below if prompted."
                    : "Open the URL manually if your browser did not launch."}
                </text>
              ) : null}
              <text fg={theme.dim}>{"2. Enter this code:"}</text>
              <text fg={theme.text} style={{ marginBottom: 1 }}>
                {`   ${oauthData.userCode}`}
              </text>
              <text fg={theme.dim}>{"Waiting for authorization…"}</text>
            </>
          ) : oauthError ? null : (
            <text fg={theme.dim}>{"Starting GitHub authorization…"}</text>
          )}
        </box>
        {oauthError ? (
          <text fg={theme.error} style={{ marginBottom: 1 }}>
            {oauthError}
          </text>
        ) : null}
        <text fg={theme.dim}>{"Esc to go back"}</text>
      </box>
    )
  }

  // phase === "key"
  const githubTokenFallback = selected.id === "github-copilot" && !githubClientId
  return (
    <box style={{ flexDirection: "column" }}>
      {githubTokenFallback ? (
        <>
          <text fg={theme.text}>{"GitHub OAuth client id is not configured."}</text>
          <text fg={theme.dim} style={{ marginBottom: 1 }}>
            {"Paste an existing GitHub Copilot token, or set DAWN_GITHUB_CLIENT_ID to enable device login."}
          </text>
        </>
      ) : (
        <text fg={theme.text} style={{ marginBottom: 1 }}>
          {`Get your free ${selected.id} key → `}
          <a href={`https://${selected.url}`} fg={theme.accent}>
            {selected.url}
          </a>
        </text>
      )}
      <box
        style={{ border: true, borderColor: theme.accent, height: 3, marginBottom: 1 }}
        title={`${selected.envVar} — paste and press Enter`}
      >
        <input focused placeholder="paste API key here…" onSubmit={(raw: unknown) => handleKeySubmit(raw)} />
      </box>
      {error ? (
        <text fg={theme.error} style={{ marginBottom: 1 }}>
          {error}
        </text>
      ) : null}
      <text fg={theme.dim}>{"Enter to save · Esc to go back"}</text>
    </box>
  )
}
