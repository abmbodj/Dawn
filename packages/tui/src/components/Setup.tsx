import {
  type Catalog,
  type DawnConfig,
  formatBytes,
  localModelFit,
  type ModelSelection,
  saveConfig,
  selectProviderInitialModel,
  withLiveModels,
} from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import { theme } from "../theme"
import { Logo } from "./Logo"
import { ProviderConnect, type ProviderOption } from "./ProviderConnect"

interface LocalOption {
  ref: string // "ollama/<model>"
  label: string
  sizeBytes?: number
}

export interface SetupProps {
  onDone: (modelRef: string) => void
  catalog: Catalog
  config: DawnConfig
  animate?: boolean
}

export async function selectConnectedProviderSetupModel(
  provider: ProviderOption,
  catalog: Catalog,
  config: DawnConfig,
): Promise<ModelSelection | undefined> {
  await withLiveModels(catalog, provider.id, config)
  return selectProviderInitialModel(provider.id, catalog, config)
}

export async function completeConnectedProviderSetup(
  provider: ProviderOption,
  catalog: Catalog,
  config: DawnConfig,
): Promise<ModelSelection | undefined> {
  const selection = await selectConnectedProviderSetupModel(provider, catalog, config)
  if (selection) saveConfig({ model: selection.ref })
  return selection
}

export function Setup({ onDone, catalog, config, animate }: SetupProps) {
  const [localPick, setLocalPick] = useState<LocalOption | null>(null)
  const [providerStatus, setProviderStatus] = useState<string | null>(null)
  const [providerError, setProviderError] = useState<string | null>(null)

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
    if (key.name === "escape" && localPick) {
      setLocalPick(null)
    }
    if (localPick) {
      if (key.name === "y") confirmLocal(localPick)
      else if (key.name === "n") setLocalPick(null)
    }
  })

  const handleExtraSelect = (value: string) => {
    const local = localModels.find((m) => m.ref === value)
    if (!local) return
    setLocalPick(local)
    if (localModelFit(local.sizeBytes).status !== "oversized") {
      confirmLocal(local)
    }
  }

  const handleConnected = (provider: ProviderOption) => {
    setProviderError(null)
    setProviderStatus(`Checking available ${provider.id} models...`)
    ;(async () => {
      const selection = await completeConnectedProviderSetup(provider, catalog, config)
      if (!selection) {
        setProviderStatus(null)
        setProviderError("No tool-capable models are visible. Fix provider access or pick another provider.")
        return
      }
      onDone(selection.ref)
    })()
  }

  const localOptions = localModels.map((m) => {
    const fit = localModelFit(m.sizeBytes)
    const warn =
      fit.status === "oversized" ? "  ·  ⚠ exceeds RAM" : fit.status === "tight" ? "  ·  tight on RAM" : ""
    return {
      name: `${m.label}  (local)`,
      value: m.ref,
      description: `Ollama · no key · ${formatBytes(m.sizeBytes)}${warn}`,
    }
  })

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
        {localPick ? (
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
              {"Welcome! Connect a provider to get started."}
            </text>
            <ProviderConnect
              config={config}
              extraOptions={localOptions}
              onExtraSelect={handleExtraSelect}
              onConnected={handleConnected}
              onCancel={() => {}}
            />
            {providerStatus ? (
              <text fg={theme.dim} style={{ marginTop: 1 }}>
                {providerStatus}
              </text>
            ) : null}
            {providerError ? (
              <text fg={theme.error} style={{ marginTop: 1 }}>
                {providerError}
              </text>
            ) : null}
          </>
        )}
      </box>
    </box>
  )
}
