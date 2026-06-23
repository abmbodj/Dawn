import {
  type Catalog,
  type DawnConfig,
  type DiscoveredCredential,
  discoverCredentials,
  formatBytes,
  isOllamaReachable,
  type LocalModelRec,
  localModelFit,
  type ModelSelection,
  persistDiscovered,
  pullOllamaModel,
  recommendLocalModel,
  saveConfig,
  selectInitialModel,
  selectProviderInitialModel,
  withAllLiveModels,
  withLiveModels,
  withOllama,
} from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useState } from "react"
import { theme } from "../theme"
import { Logo } from "./Logo"
import { ProviderConnect, type ProviderOption } from "./ProviderConnect"

interface LocalOption {
  ref: string // "ollama/<model>"
  label: string
  sizeBytes?: number
}

type SetupPhase = "discovering" | "confirm" | "manual" | "finishing"

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
  const [phase, setPhase] = useState<SetupPhase>("discovering")
  const [discovered, setDiscovered] = useState<DiscoveredCredential[]>([])
  const [finishStatus, setFinishStatus] = useState<string | null>(null)
  const [localPick, setLocalPick] = useState<LocalOption | null>(null)
  const [providerStatus, setProviderStatus] = useState<string | null>(null)
  const [providerError, setProviderError] = useState<string | null>(null)
  // Ollama running but with no models installed → offer an assisted pull.
  const [pullRec, setPullRec] = useState<LocalModelRec | null>(null)
  const [pullProgress, setPullProgress] = useState<{ status: string; percent?: number } | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)

  const localModels: LocalOption[] = Object.values(catalog.ollama?.models ?? {}).map((m) => ({
    ref: `ollama/${m.id}`,
    label: m.name,
    sizeBytes: m.sizeBytes,
  }))

  // Scan for existing credentials on mount. If any cloud key is found, offer a
  // one-keystroke confirm; otherwise fall back to the manual connect flow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only scan
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const creds = await discoverCredentials()
        const cloud = creds.filter((c) => !c.local && c.key)
        // If Ollama is running but empty, prepare a RAM-sized recommendation to offer.
        if (localModels.length === 0 && (await isOllamaReachable())) {
          if (!cancelled) setPullRec(recommendLocalModel())
        }
        if (cancelled) return
        if (cloud.length > 0) {
          setDiscovered(cloud)
          setPhase("confirm")
        } else {
          setPhase("manual")
        }
      } catch {
        if (!cancelled) setPhase("manual")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const confirmLocal = (opt: LocalOption) => {
    saveConfig({ model: opt.ref })
    onDone(opt.ref)
  }

  const startPull = (rec: LocalModelRec) => {
    setPullError(null)
    setPullProgress({ status: "starting…" })
    ;(async () => {
      try {
        await pullOllamaModel(rec.model, (p) => setPullProgress(p))
        await withOllama(catalog)
        const ref = `ollama/${rec.model}`
        saveConfig({ model: ref })
        onDone(ref)
      } catch (err) {
        setPullProgress(null)
        setPullError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  const confirmDiscovered = () => {
    setPhase("finishing")
    setFinishStatus("Connecting and finding the best model…")
    ;(async () => {
      try {
        for (const cred of discovered) await persistDiscovered(cred)
        await withAllLiveModels(catalog, config)
        const selection = selectInitialModel(catalog, config)
        if (selection) {
          saveConfig({ model: selection.ref })
          onDone(selection.ref)
          return
        }
        setProviderError("Connected, but no tool-capable model is visible yet — pick one below.")
        setPhase("manual")
      } catch (err) {
        setProviderError(err instanceof Error ? err.message : String(err))
        setPhase("manual")
      }
    })()
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") process.exit(0)
    if (phase === "confirm") {
      if (key.name === "return" || key.name === "y") confirmDiscovered()
      else if (key.name === "m" || key.name === "n" || key.name === "escape") setPhase("manual")
      return
    }
    if (key.name === "escape" && localPick) {
      setLocalPick(null)
    }
    if (localPick) {
      if (key.name === "y") confirmLocal(localPick)
      else if (key.name === "n") setLocalPick(null)
    } else if (phase === "manual" && pullRec && !pullProgress && key.name === "p") {
      startPull(pullRec)
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
        {phase === "discovering" ? (
          <text fg={theme.dim}>{"Looking for existing credentials…"}</text>
        ) : phase === "finishing" ? (
          <text fg={theme.dim}>{finishStatus ?? "Setting up…"}</text>
        ) : phase === "confirm" ? (
          <>
            <text fg={theme.text} style={{ marginBottom: 1 }}>
              {`Found ${discovered.length} credential${discovered.length !== 1 ? "s" : ""} already on this machine:`}
            </text>
            <box
              style={{
                border: true,
                borderColor: theme.accent,
                padding: 1,
                flexDirection: "column",
                marginBottom: 1,
              }}
              title="discovered"
            >
              {discovered.map((c) => (
                <text key={`${c.providerId}:${c.source}`}>
                  <span fg={theme.text}>{catalog[c.providerId]?.name ?? c.providerId}</span>
                  <span fg={theme.dim}>{`  ·  ${c.detail}  ·  ${c.masked}`}</span>
                </text>
              ))}
            </box>
            <text fg={theme.dim}>{"[Enter] use these · [m] connect manually instead"}</text>
            {providerError ? (
              <text fg={theme.error} style={{ marginTop: 1 }}>
                {providerError}
              </text>
            ) : null}
          </>
        ) : localPick ? (
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
            {pullProgress ? (
              <text fg={theme.dim} style={{ marginBottom: 1 }}>
                {`Pulling ${pullRec?.model}… ${pullProgress.percent !== undefined ? `${pullProgress.percent}%` : pullProgress.status}`}
              </text>
            ) : pullRec ? (
              <box
                style={{
                  border: true,
                  borderColor: theme.accent,
                  padding: 1,
                  flexDirection: "column",
                  marginBottom: 1,
                }}
                title="local model"
              >
                <text fg={theme.text}>{`Ollama is running but has no models.`}</text>
                <text fg={theme.dim}>
                  {`[p] pull ${pullRec.label} (${formatBytes(pullRec.sizeBytes)}${
                    localModelFit(pullRec.sizeBytes).status === "tight" ? " · tight on RAM" : ""
                  }) — sized to this machine`}
                </text>
              </box>
            ) : null}
            {pullError ? (
              <text fg={theme.error} style={{ marginBottom: 1 }}>
                {pullError}
              </text>
            ) : null}
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
