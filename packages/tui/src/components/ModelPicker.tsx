import {
  BLESSED_MODELS,
  type Catalog,
  connectedProviders,
  type DawnConfig,
  formatBytes,
  localModelFit,
  type ModelTier,
  modelTier,
  resolveProfile,
} from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import { theme } from "../theme"
import { connectableProviders, type ProviderOption } from "./ProviderConnect"
import { SelectList, type SelectListItem, safeSelection } from "./SelectList"

// ─── Types ───────────────────────────────────────────────────────────────────

export type PriceInfo =
  | { kind: "per-tok"; in: number; out: number }
  | { kind: "free" }
  | { kind: "unknown" }
  | { kind: "premium" }

export interface ModelEntry {
  id: string
  ref: string
  /** Bare display name — no ✓/✦ decorators. */
  name: string
  providerId: string
  tier: ModelTier
  isCurrent: boolean
  /** e.g. "200k" or "" */
  contextLabel: string
  price: PriceInfo
  reasoning: boolean
  vision: boolean
  ram?: { status: "fits" | "tight" | "oversized"; label: string }
}

export type Row =
  | { kind: "header"; label: string; count: number }
  | { kind: "model"; entry: ModelEntry }
  | { kind: "connect"; provider: ProviderOption }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TIER_RANK: Record<ModelTier, number> = { blessed: 0, standard: 1, experimental: 2 }

function buildEntry(
  providerId: string,
  ref: string,
  model: Catalog[string]["models"][string],
  isCurrent: boolean,
  catalog: Catalog,
): ModelEntry {
  const contextLabel = model.limit?.context ? `${Math.round(model.limit.context / 1000)}k` : ""

  let price: PriceInfo
  if (model.access === "premium") {
    price = { kind: "premium" }
  } else if (!model.cost) {
    price = { kind: "unknown" }
  } else if (model.cost.input === 0 && model.cost.output === 0) {
    price = { kind: "free" }
  } else {
    price = { kind: "per-tok", in: model.cost.input ?? 0, out: model.cost.output ?? 0 }
  }

  const profile = resolveProfile(ref, catalog)

  let ram: ModelEntry["ram"] | undefined
  if (model.sizeBytes) {
    const fit = localModelFit(model.sizeBytes)
    ram = {
      status: fit.status === "oversized" ? "oversized" : fit.status === "tight" ? "tight" : "fits",
      label: formatBytes(model.sizeBytes),
    }
  }

  return {
    id: model.id,
    ref,
    name: model.name,
    providerId,
    tier: modelTier(ref, model),
    isCurrent,
    contextLabel,
    price,
    reasoning: profile.capabilities.reasoning,
    vision: profile.capabilities.vision,
    ram,
  }
}

function priceLabel(price: PriceInfo): string {
  if (price.kind === "free") return "free"
  if (price.kind === "premium") return "premium"
  if (price.kind === "unknown") return "?"
  return `$${price.in}/$${price.out}`
}

// ─── Row data builders (exported for tests) ──────────────────────────────────

/**
 * Build model rows for a connected provider, sorted: current → tier → price → name.
 * Excludes models with tool_call === false.
 */
export function buildModelEntries(providerId: string, catalog: Catalog, current: string): ModelEntry[] {
  const models = catalog[providerId]?.models ?? {}
  const entries: ModelEntry[] = []
  for (const model of Object.values(models)) {
    if (model.tool_call === false) continue
    const ref = `${providerId}/${model.id}`
    entries.push(buildEntry(providerId, ref, model, ref === current, catalog))
  }
  entries.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.tier !== b.tier) return TIER_RANK[a.tier] - TIER_RANK[b.tier]
    const aPrice = models[a.id]?.cost?.input ?? Infinity
    const bPrice = models[b.id]?.cost?.input ?? Infinity
    if (aPrice !== bPrice) return aPrice - bPrice
    return a.name.localeCompare(b.name)
  })
  return entries
}

/**
 * Cross-provider "Recommended" list: blessed flagships on any connected provider.
 * Sorted: current first, then cheapest first.
 */
export function buildRecommendedEntries(catalog: Catalog, config: DawnConfig, current: string): ModelEntry[] {
  const connectedIds = new Set(connectedProviders(catalog, config).map((p) => p.id))
  const entries: ModelEntry[] = []
  for (const ref of BLESSED_MODELS) {
    const [providerId, ...rest] = ref.split("/")
    const modelId = rest.join("/")
    if (!providerId || !connectedIds.has(providerId)) continue
    const model = catalog[providerId]?.models?.[modelId]
    if (!model || model.tool_call === false) continue
    entries.push(buildEntry(providerId, ref, model, ref === current, catalog))
  }
  entries.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    const ap = catalog[a.providerId]?.models?.[a.id]?.cost?.input ?? Infinity
    const bp = catalog[b.providerId]?.models?.[b.id]?.cost?.input ?? Infinity
    if (ap !== bp) return ap - bp
    return a.name.localeCompare(b.name)
  })
  return entries
}

/**
 * Build the unified flat Row list: Recommended → per-provider → "More providers".
 * When `query` is set, fuzzy-filters model rows and hides the connect section.
 */
export function buildPickerRows(catalog: Catalog, config: DawnConfig, current: string, query: string): Row[] {
  const rows: Row[] = []
  const connected = connectedProviders(catalog, config)
  const connectedIds = new Set(connected.map((p) => p.id))

  const q = query.toLowerCase().trim()
  const filter = (entries: ModelEntry[]): ModelEntry[] =>
    q
      ? entries.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.id.toLowerCase().includes(q) ||
            e.providerId.toLowerCase().includes(q),
        )
      : entries

  // Recommended section
  const recEntries = filter(buildRecommendedEntries(catalog, config, current))
  if (recEntries.length > 0) {
    rows.push({ kind: "header", label: "RECOMMENDED", count: recEntries.length })
    for (const e of recEntries) rows.push({ kind: "model", entry: e })
  }

  // Per-provider sections
  for (const p of connected) {
    const entries = filter(buildModelEntries(p.id, catalog, current))
    if (entries.length === 0) continue
    rows.push({ kind: "header", label: p.name.toUpperCase(), count: entries.length })
    for (const e of entries) rows.push({ kind: "model", entry: e })
  }

  // "More providers" section — every connectable catalog provider; the
  // search query filters it by name instead of hiding it (the full
  // models.dev list is ~60 entries).
  let unconnected = connectableProviders(catalog).filter((p) => !connectedIds.has(p.id))
  if (q) {
    unconnected = unconnected.filter(
      (p) => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    )
  }
  if (unconnected.length > 0) {
    rows.push({ kind: "header", label: "MORE PROVIDERS", count: unconnected.length })
    for (const p of unconnected) rows.push({ kind: "connect", provider: p })
  }

  return rows
}

// ─── Navigation helpers ───────────────────────────────────────────────────────

function isSelectable(row: Row | undefined): boolean {
  return row?.kind === "model" || row?.kind === "connect"
}

function rowKey(row: Row): string {
  if (row.kind === "model") return `model-${row.entry.ref}`
  if (row.kind === "connect") return `connect-${row.provider.id}`
  return `header-${row.label}`
}

// ─── Row renderer ─────────────────────────────────────────────────────────────

const VISIBLE_HEIGHT = 11

interface PickerRowProps {
  row: Row
  selected: boolean
  wide: boolean
}

function PickerRow({ row, selected, wide }: PickerRowProps) {
  if (row.kind === "header") {
    return (
      <text fg={theme.dim} style={{ paddingLeft: 1 }}>
        {`─ ${row.label} (${row.count})`}
      </text>
    )
  }

  if (row.kind === "connect") {
    const { provider } = row
    return (
      <box style={{ flexDirection: "row", backgroundColor: selected ? theme.statusBg : undefined }}>
        <text fg={selected ? theme.accent : theme.dim}>{selected ? "❯ " : "  "}</text>
        <text fg={theme.dim}>{`+ Connect ${provider.label.split("  ")[0]}`}</text>
      </box>
    )
  }

  const { entry } = row
  const bg = selected ? theme.statusBg : undefined
  const caret = selected ? "❯ " : "  "
  const caretColor = selected ? theme.accent : theme.dim

  const tierBadge = entry.tier === "blessed" ? "★ " : entry.tier === "experimental" ? "⚠ " : "  "
  const tierColor =
    entry.tier === "blessed" ? theme.accent : entry.tier === "experimental" ? theme.error : theme.dim

  const ctx = entry.contextLabel ? entry.contextLabel.padStart(5) : "     "

  if (!wide) {
    return (
      <box style={{ flexDirection: "row", backgroundColor: bg }}>
        <text fg={caretColor}>{caret}</text>
        <text fg={tierColor}>{tierBadge}</text>
        <text fg={theme.text} style={{ flexGrow: 1 }}>
          {entry.name}
        </text>
        {entry.isCurrent ? <text fg={theme.toolOk}>{"✓ "}</text> : null}
        <text fg={theme.dim}>{ctx}</text>
      </box>
    )
  }

  const priceStr = priceLabel(entry.price).padEnd(12)
  const thinkColor = entry.reasoning ? theme.accent : theme.dim
  const visionColor = entry.vision ? theme.accent : theme.dim

  const ramEl = entry.ram ? (
    <text
      fg={
        entry.ram.status === "oversized"
          ? theme.error
          : entry.ram.status === "tight"
            ? theme.accent
            : theme.toolOk
      }
    >
      {entry.ram.status === "oversized" ? " ⚠RAM" : entry.ram.status === "tight" ? " ~RAM" : " ✓RAM"}
    </text>
  ) : null

  return (
    <box style={{ flexDirection: "row", backgroundColor: bg }}>
      <text fg={caretColor}>{caret}</text>
      <text fg={tierColor}>{tierBadge}</text>
      <text fg={theme.text} style={{ flexGrow: 1 }}>
        {entry.name}
      </text>
      {entry.isCurrent ? <text fg={theme.toolOk}>{"✓ "}</text> : null}
      <text fg={theme.dim}>{`${ctx} `}</text>
      <text fg={theme.dim}>{priceStr}</text>
      <text fg={thinkColor}>{"think "}</text>
      <text fg={visionColor}>{"vision"}</text>
      {ramEl}
    </box>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ModelPickerProps {
  catalog: Catalog
  config: DawnConfig
  current: string
  width: number
  /** Unused in unified layout; kept for prop-compatibility with app.tsx. */
  initialProviderId?: string
  onPick: (ref: string) => void
  onConnect: (provider: ProviderOption) => void
  onClose: () => void
}

// ─── Main component ──────────────────────────────────────────────────────────

export function ModelPicker({
  catalog,
  config,
  current,
  width,
  onPick,
  onConnect,
  onClose,
}: ModelPickerProps) {
  const [query, setQuery] = useState("")
  const [selectedFlatIdx, setSelectedFlatIdx] = useState(() => {
    const r = buildPickerRows(catalog, config, current, "")
    const i = r.findIndex((row) => row.kind === "model" && row.entry.ref === current)
    return i >= 0 ? i : 0
  })

  const rows = buildPickerRows(catalog, config, current, query)
  const wide = width >= 70

  const items: SelectListItem[] = rows.map((row) => ({
    key: rowKey(row),
    selectable: isSelectable(row),
    render: (selected) => <PickerRow row={row} selected={selected} wide={wide} />,
  }))
  const sel = safeSelection(items, selectedFlatIdx)

  const activate = (i: number) => {
    const row = rows[i]
    if (row?.kind === "model") onPick(row.entry.ref)
    else if (row?.kind === "connect") onConnect(row.provider)
  }

  // Arrow/PgUp/PgDn/Enter and all mouse interaction live in SelectList.
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") process.exit(0)
    if (key.name === "escape") {
      if (query) {
        setQuery("")
        setSelectedFlatIdx(0)
        return
      }
      onClose()
      return
    }
  })

  const handleInput = (val: unknown) => {
    const q = typeof val === "string" ? val : String((val as any)?.value ?? "")
    setQuery(q)
    setSelectedFlatIdx(0)
  }

  const title = query
    ? `model · searching: ${query} · Esc clear`
    : `model · ${current} · ↑↓ move · Enter pick · Esc close`

  const footer = wide
    ? "★ recommended · ⚠ exp · think/vision dim=no · ✓ active"
    : "↑↓ navigate · Enter pick · Esc close"

  return (
    <box
      style={{ border: true, borderColor: theme.accent, height: 16, flexDirection: "column" }}
      title={title}
    >
      <box style={{ height: 1 }}>
        <input focused value={query} placeholder="search models…" onInput={handleInput} />
      </box>
      <SelectList
        items={items}
        height={VISIBLE_HEIGHT}
        selectedIndex={sel}
        onSelectIndex={setSelectedFlatIdx}
        onActivate={activate}
      />
      <text fg={theme.dim} style={{ paddingLeft: 1 }}>
        {footer}
      </text>
    </box>
  )
}
