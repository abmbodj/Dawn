import { type Catalog, connectedProviders, type DawnConfig, formatBytes, localModelFit } from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import { theme } from "../theme"
import { type ProviderOption, SETUP_PROVIDERS } from "./ProviderConnect"

export interface ModelPickerProps {
  catalog: Catalog
  config: DawnConfig
  current: string
  width: number
  /** Preselect a provider on open (e.g., after a /connect round-trip). */
  initialProviderId?: string
  onPick: (ref: string) => void
  onConnect: (provider: ProviderOption) => void
  onClose: () => void
}

interface ProviderEntry {
  kind: "connected"
  id: string
  name: string
  modelCount: number
}

interface ConnectEntry {
  kind: "connect"
  provider: ProviderOption
}

type LeftEntry = ProviderEntry | ConnectEntry

/** Build left-pane entries. Re-reads auth.json on every call via connectedProviders. */
export function buildLeftEntries(catalog: Catalog, config: DawnConfig, current: string): LeftEntry[] {
  const connected = connectedProviders(catalog, config)
  const currentProviderId = current.split("/")[0] ?? ""

  const connectedEntries: LeftEntry[] = connected.map((p) => {
    const models = catalog[p.id]?.models ?? {}
    const count = Object.values(models).filter((m) => m.tool_call !== false).length
    return {
      kind: "connected",
      id: p.id,
      name: p.id === currentProviderId ? `${p.name} ✓` : p.name,
      modelCount: count,
    }
  })

  const connectedIds = new Set(connected.map((p) => p.id))
  const connectEntries: LeftEntry[] = SETUP_PROVIDERS.filter((p) => !connectedIds.has(p.id)).map((p) => ({
    kind: "connect",
    provider: p,
  }))

  return [...connectedEntries, ...connectEntries]
}

interface ModelEntry {
  id: string
  ref: string
  name: string
  description: string
  isCurrent: boolean
}

/** Build right-pane model rows for a connected provider. */
export function buildModelEntries(providerId: string, catalog: Catalog, current: string): ModelEntry[] {
  const models = catalog[providerId]?.models ?? {}
  const entries: ModelEntry[] = []
  for (const model of Object.values(models)) {
    if (model.tool_call === false) continue
    const ref = `${providerId}/${model.id}`
    const isCurrent = ref === current

    let cost: string
    if (!model.cost) {
      cost = "price unknown"
    } else if (model.cost.input === 0 && model.cost.output === 0) {
      cost = "free"
    } else {
      cost = `$${model.cost.input ?? "?"}/$${model.cost.output ?? "?"} per Mtok`
    }

    const ctx = model.limit?.context ? ` · ${Math.round(model.limit.context / 1000)}k ctx` : ""
    const out = model.limit?.output ? ` · ${Math.round(model.limit.output / 1000)}k out` : ""
    const fit = model.sizeBytes ? localModelFit(model.sizeBytes) : undefined
    const ram = fit
      ? ` · ${formatBytes(model.sizeBytes)}${fit.status === "oversized" ? " ⚠ exceeds RAM" : fit.status === "tight" ? " tight on RAM" : ""}`
      : ""

    const nameParts = [model.name, isCurrent ? "✓" : "", model.reasoning ? "✦" : ""].filter(Boolean).join(" ")

    entries.push({
      id: model.id,
      ref,
      name: nameParts,
      description: `${cost}${ctx}${out}${ram}`,
      isCurrent,
    })
  }
  return entries
}

export function ModelPicker({
  catalog,
  config,
  current,
  width,
  initialProviderId,
  onPick,
  onConnect,
  onClose,
}: ModelPickerProps) {
  const entries = buildLeftEntries(catalog, config, current)
  const currentProviderId = current.split("/")[0] ?? ""

  const initialLeftIndex = (() => {
    if (initialProviderId) {
      const idx = entries.findIndex((e) => e.kind === "connected" && e.id === initialProviderId)
      if (idx >= 0) return idx
    }
    const idx = entries.findIndex((e) => e.kind === "connected" && e.id === currentProviderId)
    return Math.max(0, idx)
  })()

  const [pane, setPane] = useState<"providers" | "models">("providers")
  const [highlightedIndex, setHighlightedIndex] = useState(initialLeftIndex)
  const [leftIndex] = useState(initialLeftIndex)

  const highlighted = entries[highlightedIndex]
  const isConnectEntry = highlighted?.kind === "connect"
  const highlightedProviderId = highlighted?.kind === "connected" ? highlighted.id : null

  const modelEntries = highlightedProviderId ? buildModelEntries(highlightedProviderId, catalog, current) : []
  const currentModelIndex = Math.max(
    0,
    modelEntries.findIndex((m) => m.isCurrent),
  )

  useKeyboard((key) => {
    const name = key.name
    if (name === "right" || name === "tab") {
      if (!isConnectEntry && pane === "providers") setPane("models")
    } else if (name === "left" || (key.shift && name === "tab")) {
      setPane("providers")
    } else if (name === "escape") {
      if (pane === "models") {
        setPane("providers")
      } else {
        onClose()
      }
    }
  })

  const leftOptions = entries.map((e) => {
    if (e.kind === "connected") {
      return {
        name: e.name,
        value: `p:${e.id}`,
        description: `${e.modelCount} model${e.modelCount !== 1 ? "s" : ""}`,
      }
    }
    const authHint =
      e.provider.id === "github-copilot" ? "OAuth (GitHub device flow)" : `API key · ${e.provider.envVar}`
    return {
      name: `+ Connect ${e.provider.label.split("  ")[0]}`,
      value: `c:${e.provider.id}`,
      description: authHint,
    }
  })

  const rightOptions = modelEntries.map((m) => ({
    name: m.name,
    description: m.description,
    value: m.ref,
  }))

  const narrow = width < 70

  const handleLeftSelect = (_i: number, opt: any) => {
    const value: string | undefined = opt?.value
    if (!value) return
    if (value.startsWith("p:")) {
      setPane("models")
    } else if (value.startsWith("c:")) {
      const providerId = value.slice(2)
      const prov = SETUP_PROVIDERS.find((p) => p.id === providerId)
      if (prov) onConnect(prov)
    }
  }

  const handleLeftChange = (i: number) => {
    setHighlightedIndex(i)
    if (entries[i]?.kind === "connect") setPane("providers")
  }

  const handleRightSelect = (_i: number, opt: any) => {
    if (opt?.value) onPick(opt.value)
  }

  const noConnected = entries.every((e) => e.kind === "connect")

  if (narrow) {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, height: 16, flexDirection: "column" }}
        title={
          pane === "models" && highlightedProviderId
            ? `${catalog[highlightedProviderId]?.name ?? highlightedProviderId} models · Esc back`
            : "switch model · Enter select · Esc close"
        }
      >
        {pane === "providers" || !highlightedProviderId ? (
          <>
            {noConnected ? (
              <text fg={theme.dim} style={{ paddingLeft: 1 }}>
                {"No providers connected yet"}
              </text>
            ) : null}
            <select
              focused
              showScrollIndicator
              options={leftOptions}
              selectedIndex={leftIndex}
              onChange={handleLeftChange}
              onSelect={handleLeftSelect}
              style={{ flexGrow: 1 }}
            />
            <text fg={theme.dim} style={{ paddingLeft: 1 }}>
              {"Pick a provider to connect — or run /connect anytime"}
            </text>
          </>
        ) : (
          <select
            key={highlightedProviderId}
            focused
            showScrollIndicator
            options={rightOptions}
            selectedIndex={currentModelIndex}
            onSelect={handleRightSelect}
            style={{ flexGrow: 1 }}
          />
        )}
      </box>
    )
  }

  // Wide two-pane layout
  return (
    <box
      style={{ border: true, borderColor: theme.accent, height: 16, flexDirection: "row" }}
      title="switch model · ←→ panes · Enter select · Esc close"
    >
      <box
        style={{
          width: 26,
          flexShrink: 0,
          flexDirection: "column",
          paddingRight: 1,
        }}
      >
        {noConnected ? (
          <text fg={theme.dim} style={{ paddingLeft: 1, paddingTop: 1 }}>
            {"No providers yet"}
          </text>
        ) : null}
        <select
          focused={pane === "providers"}
          showScrollIndicator
          options={leftOptions}
          selectedIndex={leftIndex}
          onChange={handleLeftChange}
          onSelect={handleLeftSelect}
          style={{ flexGrow: 1 }}
        />
      </box>
      <box
        style={{
          flexGrow: 1,
          flexDirection: "column",
          paddingLeft: 1,
        }}
      >
        {isConnectEntry && highlighted.kind === "connect" ? (
          <box style={{ flexDirection: "column", padding: 1 }}>
            <text fg={theme.text}>{highlighted.provider.label}</text>
            <text fg={theme.dim}>{`Sign up: ${highlighted.provider.url}`}</text>
            <text fg={theme.dim}>{`Env var: ${highlighted.provider.envVar}`}</text>
            <text fg={theme.dim} style={{ marginTop: 1 }}>
              {"Enter to connect"}
            </text>
          </box>
        ) : highlightedProviderId ? (
          <select
            key={highlightedProviderId}
            focused={pane === "models"}
            showScrollIndicator
            options={rightOptions}
            selectedIndex={currentModelIndex}
            onSelect={handleRightSelect}
            style={{ flexGrow: 1 }}
          />
        ) : (
          <text fg={theme.dim} style={{ padding: 1 }}>
            {"← select a provider"}
          </text>
        )}
        {noConnected ? (
          <text fg={theme.dim} style={{ paddingLeft: 1, paddingBottom: 1 }}>
            {"Pick a provider to connect — or run /connect anytime"}
          </text>
        ) : null}
      </box>
    </box>
  )
}
