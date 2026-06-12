import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { setApiKey } from "@dawn/core"
import { theme } from "../theme"

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

export interface SetupProps {
  onDone: (modelRef: string) => void
}

export function Setup({ onDone }: SetupProps) {
  const [phase, setPhase] = useState<"pick" | "key">("pick")
  const [selected, setSelected] = useState<ProviderOption>(SETUP_PROVIDERS[0]!)
  const [error, setError] = useState<string | null>(null)

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") process.exit(0)
    if (key.name === "escape" && phase === "key") {
      setPhase("pick")
      setError(null)
    }
  })

  // biome-ignore lint/suspicious/noExplicitAny: SelectOption value is optional in @opentui/react types
  const handleProviderPick = (_i: number, opt: any) => {
    const id: string | undefined = opt?.value
    if (!id) return
    const provider = SETUP_PROVIDERS.find((p) => p.id === id)
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

  const pickerOptions = SETUP_PROVIDERS.map((p) => ({
    name: p.label,
    value: p.id,
    description: `${p.envVar}  ·  ${p.url}`,
  }))

  return (
    <box style={{ flexDirection: "column", alignItems: "center", justifyContent: "center", flexGrow: 1, padding: 2 }}>
      <box style={{ flexDirection: "column", width: 60 }}>
        <text fg={theme.sunCore} style={{ marginBottom: 1 }}>
          {"  D  A  W  N"}
        </text>
        <text fg={theme.dim} style={{ marginBottom: 2 }}>
          {"  reasoning, not memory"}
        </text>

        {phase === "pick" ? (
          <>
            <text fg={theme.text} style={{ marginBottom: 1 }}>
              {"Welcome! Connect a provider to get started."}
            </text>
            <box
              style={{ border: true, borderColor: theme.accent, height: 12, flexDirection: "column", marginBottom: 1 }}
              title="choose provider"
            >
              <select
                focused
                showScrollIndicator
                options={pickerOptions}
                onChange={handleProviderPick}
                style={{ flexGrow: 1 }}
              />
            </box>
            <text fg={theme.dim}>{"↑↓ navigate · Enter select · Ctrl+C quit"}</text>
          </>
        ) : (
          <>
            <text fg={theme.text} style={{ marginBottom: 1 }}>
              {`Get your free ${selected.id} key → `}
              <span fg={theme.accent}>{selected.url}</span>
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
