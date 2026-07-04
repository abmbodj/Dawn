import {
  type Catalog,
  copyToClipboard,
  type DawnConfig,
  type DeviceFlowStart,
  ENTERPRISE_PROVIDERS,
  openExternalUrl,
  pollForToken,
  resolveGithubClientId,
  setApiKey,
  startDeviceFlow,
  tryGhCliToken,
} from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { theme } from "../theme"
import { optionItem, SelectList } from "./SelectList"

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
    id: "openrouter",
    label: "OpenRouter  (free models · one key, 300+ models)",
    url: "openrouter.ai/keys",
    defaultModel: "openrouter/deepseek/deepseek-chat-v3-0324:free",
    envVar: "OPENROUTER_API_KEY",
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

/**
 * Every provider a key can be pasted for: the curated SETUP_PROVIDERS first
 * (familiar order and labels), then all remaining models.dev catalog providers
 * that declare an auth env var and dispatch through an OpenAI-compatible
 * baseURL (or a native SDK for anthropic/openai/google). Enterprise gateways
 * (bedrock/vertex/azure) are excluded — they authenticate via cloud credential
 * chains, not a pasted key.
 */
export function connectableProviders(catalog: Catalog): ProviderOption[] {
  const curated = new Set(SETUP_PROVIDERS.map((p) => p.id))
  const NATIVE_SDK = new Set(["anthropic", "openai", "google"])
  const extra: ProviderOption[] = []
  for (const info of Object.values(catalog)) {
    if (!info?.id || curated.has(info.id) || ENTERPRISE_PROVIDERS.has(info.id)) continue
    if (!info.env || info.env.length === 0) continue
    if (!info.api && !NATIVE_SDK.has(info.id)) continue // no way to dispatch requests
    const firstModel = Object.keys(info.models ?? {})[0]
    extra.push({
      id: info.id,
      label: info.name || info.id,
      url: (info.doc ?? "models.dev").replace(/^https?:\/\//, ""),
      defaultModel: firstModel ? `${info.id}/${firstModel}` : "",
      envVar: info.env[0] ?? "",
    })
  }
  extra.sort((a, b) => a.label.localeCompare(b.label))
  return [...SETUP_PROVIDERS, ...extra]
}

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
  tryGhCliTokenFn?: typeof tryGhCliToken
  copyToClipboardFn?: typeof copyToClipboard
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
  tryGhCliTokenFn = tryGhCliToken,
  copyToClipboardFn = copyToClipboard,
  onExtraSelect,
  onConnected,
  onCancel,
}: ProviderConnectProps) {
  const githubClientId = resolveGithubClientId(config)
  const [phase, setPhase] = useState<"pick" | "detecting" | "key" | "oauth">(() => {
    if (!fixedProvider) return "pick"
    if (fixedProvider.id === "github-copilot") return "detecting"
    return "key"
  })
  const [selected, setSelected] = useState<ProviderOption>(
    fixedProvider ?? providers[0] ?? SETUP_PROVIDERS[0],
  )
  const [pickIdx, setPickIdx] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [oauthData, setOauthData] = useState<DeviceFlowStart | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [browserOpenStatus, setBrowserOpenStatus] = useState<"opened" | "manual" | null>(null)
  const [clipboardStatus, setClipboardStatus] = useState<"copied" | "failed" | null>(null)
  const oauthAbortRef = useRef<AbortController | null>(null)
  const detectCancelledRef = useRef(false)

  // When a fixed provider is given, start its flow on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect; component is keyed externally
  useEffect(() => {
    if (!fixedProvider) return
    if (fixedProvider.id === "github-copilot") {
      detectAndStartCopilot(fixedProvider)
    }
    // key phase: no auto-start needed, user pastes
  }, [])

  const detectAndStartCopilot = (prov: ProviderOption) => {
    detectCancelledRef.current = false
    setPhase("detecting")
    ;(async () => {
      const ghToken = await tryGhCliTokenFn()
      if (detectCancelledRef.current) return
      if (ghToken) {
        setApiKey("github-copilot", ghToken)
        onConnected(prov)
        return
      }
      if (githubClientId) {
        setPhase("oauth")
        startGithubOAuth(prov)
      } else {
        setPhase("key")
      }
    })()
  }

  const startGithubOAuth = (prov: ProviderOption) => {
    const clientId = githubClientId
    if (!clientId) return
    setOauthData(null)
    setOauthError(null)
    setBrowserOpenStatus(null)
    setClipboardStatus(null)
    const abort = new AbortController()
    oauthAbortRef.current = abort
    ;(async () => {
      try {
        const flow = await startDeviceFlowFn(clientId)
        setOauthData(flow)
        const [opened, copied] = await Promise.all([
          openUrl(flow.verificationUri),
          copyToClipboardFn(flow.userCode),
        ])
        if (!abort.signal.aborted) {
          setBrowserOpenStatus(opened ? "opened" : "manual")
          setClipboardStatus(copied ? "copied" : "failed")
        }
        const token = await pollForTokenFn(clientId, flow.deviceCode, flow.interval, abort.signal)
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
        setClipboardStatus(null)
      }
      if (phase === "detecting") {
        detectCancelledRef.current = true
      }
      if (phase === "key" || phase === "oauth" || phase === "detecting") {
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

  const handleProviderPick = (value: string | undefined) => {
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
      detectAndStartCopilot(prov)
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
    const items = pickerOptions.map((o) => optionItem(o.value, o.name, o.description))
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
          <SelectList
            items={items}
            height={10}
            selectedIndex={pickIdx}
            onSelectIndex={setPickIdx}
            onActivate={(i) => handleProviderPick(pickerOptions[i]?.value)}
          />
        </box>
        <text fg={theme.dim}>{"↑↓ navigate · Enter select · Esc cancel"}</text>
      </box>
    )
  }

  if (phase === "detecting") {
    return (
      <box style={{ flexDirection: "column" }}>
        <text fg={theme.dim}>{"Checking for GitHub CLI authentication…"}</text>
        <text fg={theme.dim}>{"Esc to cancel"}</text>
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
              {browserOpenStatus === "opened" ? (
                <text fg={theme.dim} style={{ marginBottom: 1 }}>
                  {"Your browser is open. Enter the code below when prompted:"}
                </text>
              ) : (
                <>
                  <text fg={theme.dim}>{"Open this URL in your browser:"}</text>
                  <text fg={theme.accent} style={{ marginBottom: 1 }}>
                    {"  github.com/login/device"}
                  </text>
                  <text fg={theme.dim}>{"Then enter this code:"}</text>
                </>
              )}
              <text fg={theme.text} style={{ marginBottom: 1 }}>
                {`  ${oauthData.userCode}`}
              </text>
              {clipboardStatus === "copied" ? (
                <text fg={theme.dim} style={{ marginBottom: 1 }}>
                  {"(copied to clipboard)"}
                </text>
              ) : null}
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
          <text fg={theme.text}>{"Run `gh auth login` and reconnect for automatic sign-in."}</text>
          <text fg={theme.dim} style={{ marginBottom: 1 }}>
            {"Or paste an existing GitHub Copilot token below."}
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
