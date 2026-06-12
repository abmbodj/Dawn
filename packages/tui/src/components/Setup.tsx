import { type Catalog, formatBytes, localModelFit, saveConfig, setApiKey } from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import { theme } from "../theme"
import { Logo } from "./Logo"

interface ProviderOption {
  id: string
  label: string
  url: string
  defaultModel: string
  envVar: string
}

const SETUP_PROVIDERS: ProviderOption[] = [
  {
    id: "groq",
    label: "Groq  (free — no credit card)",
    url: "console.groq.com",
    defaultModel: "groq/llama-4-scout-17b-16e-instruct",
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

interface LocalOption {
  ref: string // "ollama/<model>"
  label: string
  sizeBytes?: number
}

export interface SetupProps {
  onDone: (modelRef: string) => void
  catalog: Catalog
  animate?: boolean
}

export function Setup({ onDone, catalog, animate }: SetupProps) {
  const [phase, setPhase] = useState<"pick" | "key" | "localConfirm">("pick")
  const [selected, setSelected] = useState<ProviderOption>(SETUP_PROVIDERS[0]!)
  const [localPick, setLocalPick] = useState<LocalOption | null>(null)
  const [error, setError] = useState<string | null>(null)

  const localModels: LocalOption[] = Object.values(catalog.ollama?.models ?? {}).map((m) => ({
    ref: `ollama/${m.id}`,
    label: m.name,
    sizeBytes: m.sizeBytes,
  }))

  const confirmLocal = (opt: LocalOption) => {
    saveConfig({ model: opt.ref })
    onDone(opt.ref)
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") process.exit(0)
    if (key.name === "escape" && (phase === "key" || phase === "localConfirm")) {
      setPhase("pick")
      setLocalPick(null)
      setError(null)
    }
    if (phase === "localConfirm" && localPick) {
      if (key.name === "y") confirmLocal(localPick)
      else if (key.name === "n") {
        setPhase("pick")
        setLocalPick(null)
      }
    }
  })

  // biome-ignore lint/suspicious/noExplicitAny: SelectOption value is optional in @opentui/react types
  const handleProviderPick = (_i: number, opt: any) => {
    const value: string | undefined = opt?.value
    if (!value) return
    if (value.startsWith("local:")) {
      const ref = value.slice("local:".length)
      const local = localModels.find((m) => m.ref === ref)
      if (!local) return
      setLocalPick(local)
      setError(null)
      // Big local models can swap-storm a low-RAM machine into a freeze — confirm first.
      if (localModelFit(local.sizeBytes).status === "oversized") setPhase("localConfirm")
      else confirmLocal(local)
      return
    }
    const provider = SETUP_PROVIDERS.find((p) => p.id === value)
    if (!provider) return
    setSelected(provider)
    setPhase("key")
    setError(null)
  }

  const handleKeySubmit = (raw: unknown) => {
    const key = (typeof raw === "string" ? raw : String((raw as any)?.value ?? "")).trim()
    if (!key) {
      setError("Key cannot be empty — paste your API key above and press Enter")
      return
    }
    setApiKey(selected.id, key)
    onDone(selected.defaultModel)
  }

  const pickerOptions = [
    ...SETUP_PROVIDERS.map((p) => ({
      name: p.label,
      value: p.id,
      description: `${p.envVar}  ·  ${p.url}`,
    })),
    ...localModels.map((m) => {
      const fit = localModelFit(m.sizeBytes)
      const warn =
        fit.status === "oversized" ? "  ·  ⚠ exceeds RAM" : fit.status === "tight" ? "  ·  tight on RAM" : ""
      return {
        name: `${m.label}  (local)`,
        value: `local:${m.ref}`,
        description: `Ollama · no key · ${formatBytes(m.sizeBytes)}${warn}`,
      }
    }),
  ]

  return (
    <box
      style={{
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        flexGrow: 1,
        padding: 1,
      }}
    >
      <Logo animate={animate ?? true} />
      <box style={{ flexDirection: "column", width: 60, alignSelf: "center", marginTop: 1 }}>
        {phase === "pick" ? (
          <>
            <text fg={theme.text} style={{ marginBottom: 1 }}>
              {"Welcome! Connect a provider to get started."}
            </text>
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
            <text fg={theme.dim}>{"↑↓ navigate · Enter select · Ctrl+C quit"}</text>
          </>
        ) : phase === "localConfirm" && localPick ? (
          <>
            <box
              style={{
                border: true,
                borderColor: theme.error,
                padding: 1,
                flexDirection: "column",
                marginBottom: 1,
              }}
              title="heads up"
            >
              <text>
                <span fg={theme.error}>{"⚠ "}</span>
                <span
                  fg={theme.text}
                >{`${localPick.ref} needs ~${formatBytes(localPick.sizeBytes)} of RAM`}</span>
              </text>
              <text fg={theme.dim}>
                {`This machine has ${formatBytes(localModelFit(localPick.sizeBytes).totalBytes)} total. ` +
                  "Running it may swap-storm and freeze your system."}
              </text>
            </box>
            <text fg={theme.dim}>{"[y] use it anyway · [n/Esc] pick another"}</text>
          </>
        ) : (
          <>
            <text fg={theme.text} style={{ marginBottom: 1 }}>
              {`Get your free ${selected.id} key → `}
              <a href={`https://${selected.url}`} fg={theme.accent}>
                {selected.url}
              </a>
            </text>
            <box
              style={{ border: true, borderColor: theme.accent, height: 3, marginBottom: 1 }}
              title={`${selected.envVar} — paste and press Enter`}
            >
              <input
                focused
                placeholder="paste API key here…"
                onSubmit={(raw: unknown) => handleKeySubmit(raw)}
              />
            </box>
            {error ? (
              <text fg={theme.error} style={{ marginBottom: 1 }}>
                {error}
              </text>
            ) : null}
            <text fg={theme.dim}>{"Enter to save · Esc to go back"}</text>
          </>
        )}
      </box>
    </box>
  )
}
