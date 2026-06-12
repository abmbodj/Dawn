import type {
  AgentEvent,
  Catalog,
  DawnAgent,
  DawnConfig,
  ModelMessage,
  PermissionGate,
  PermissionRequest,
  SessionMeta,
  SessionStore,
  UsageTotals,
} from "@dawn/core"
import { connectedProviders, formatBytes, hasConfiguredModel, localModelFit } from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { Logo } from "./components/Logo"
import { Setup } from "./components/Setup"
import { theme } from "./theme"

// ---------- transcript state ----------

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool"
      id: string
      name: string
      title: string
      summary?: string
      isError?: boolean
      done: boolean
    }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }

type Action =
  | { type: "push"; item: Item }
  | { type: "agent"; event: AgentEvent }
  | { type: "reset"; items: Item[] }

function reduceItems(items: Item[], action: Action): Item[] {
  switch (action.type) {
    case "push":
      return [...items, action.item]
    case "reset":
      return action.items
    case "agent": {
      const ev = action.event
      switch (ev.type) {
        case "text-delta": {
          const last = items[items.length - 1]
          if (last?.kind === "assistant") {
            return [...items.slice(0, -1), { ...last, text: last.text + ev.text }]
          }
          return [...items, { kind: "assistant", text: ev.text }]
        }
        case "tool-start":
          return [...items, { kind: "tool", id: ev.id, name: ev.name, title: ev.title, done: false }]
        case "tool-end":
          return items.map((it) =>
            it.kind === "tool" && it.id === ev.id
              ? { ...it, done: true, summary: ev.summary, isError: ev.isError }
              : it,
          )
        case "error":
          return [...items, { kind: "error", text: ev.message }]
        case "turn-end":
          return ev.aborted ? [...items, { kind: "info", text: "(interrupted)" }] : items
        default:
          return items
      }
    }
  }
}

/** Rebuild transcript items from persisted messages on --continue. */
export function itemsFromMessages(messages: ModelMessage[]): Item[] {
  const items: Item[] = []
  for (const msg of messages) {
    const content = msg.content
    if (msg.role === "user" && typeof content === "string") {
      items.push({ kind: "user", text: content })
    } else if (msg.role === "assistant") {
      const parts = typeof content === "string" ? [{ type: "text", text: content }] : content
      for (const part of parts as any[]) {
        if (part.type === "text" && part.text.trim()) {
          items.push({ kind: "assistant", text: part.text })
        } else if (part.type === "tool-call") {
          items.push({
            kind: "tool",
            id: part.toolCallId,
            name: part.toolName,
            title: "",
            done: true,
          })
        }
      }
    }
  }
  return items
}

// ---------- helpers ----------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatCost(usd: number): string {
  return usd >= 0.995 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`
}

const HELP = `Commands:
  /model   switch model (multi-provider)
  /usage   token + cost breakdown for this session
  /new     start a fresh session
  /clear   clear the screen (keeps the conversation)
  /help    this help
  /quit    exit
Keys: Esc interrupts a running turn · Ctrl+C quits`

// ---------- subviews ----------

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <text>
          <span fg={theme.user}>❯ </span>
          <span fg={theme.text}>{item.text}</span>
        </text>
      )
    case "assistant":
      return <text fg={theme.text}>{item.text}</text>
    case "tool": {
      const color = !item.done ? theme.accent : item.isError ? theme.toolErr : theme.toolOk
      const mark = !item.done ? "⚒" : item.isError ? "✗" : "✓"
      return (
        <text>
          <span fg={color}>{`${mark} ${item.name}`}</span>
          <span fg={theme.dim}>{item.title ? ` ${item.title}` : ""}</span>
          <span fg={item.isError ? theme.toolErr : theme.dim}>
            {item.done && item.summary ? ` — ${firstLine(item.summary)}` : ""}
          </span>
        </text>
      )
    }
    case "info":
      return <text fg={theme.dim}>{item.text}</text>
    case "error":
      return <text fg={theme.error}>{`error: ${item.text}`}</text>
  }
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? ""
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

interface PendingPermission {
  req: PermissionRequest
  resolve: (d: "allow" | "always" | "deny") => void
}

function PermissionView({ pending }: { pending: PendingPermission }) {
  return (
    <box
      style={{ border: true, borderColor: theme.accent, padding: 1, flexDirection: "column" }}
      title="permission"
    >
      <text>
        <span fg={theme.accent}>{`${pending.req.tool}: `}</span>
        <span fg={theme.text}>{pending.req.title}</span>
      </text>
      {pending.req.detail ? <text fg={theme.dim}>{pending.req.detail}</text> : null}
      <text fg={theme.dim}>[y] allow once · [a] always for this tool · [n/Esc] deny</text>
    </box>
  )
}

function ModelFitWarning({ modelRef, sizeBytes }: { modelRef: string; sizeBytes?: number }) {
  const fit = localModelFit(sizeBytes)
  return (
    <box
      style={{ border: true, borderColor: theme.error, padding: 1, flexDirection: "column" }}
      title="heads up"
    >
      <text>
        <span fg={theme.error}>⚠ </span>
        <span fg={theme.text}>{`${modelRef} needs ~${formatBytes(sizeBytes)} of RAM`}</span>
      </text>
      <text fg={theme.dim}>
        {`This machine has ${formatBytes(fit.totalBytes)} total (${formatBytes(fit.freeBytes)} free). ` +
          "Running it may swap-storm and freeze your system."}
      </text>
      <text fg={theme.dim}>[y] use it anyway · [n/Esc] cancel</text>
    </box>
  )
}

// ---------- main app ----------

export interface AppProps {
  agent: DawnAgent
  store: SessionStore
  session: SessionMeta
  catalog: Catalog
  config: DawnConfig
  gate: PermissionGate
  animate: boolean
}

export function App(props: AppProps) {
  const { agent, store, catalog, config, gate } = props
  const [needsSetup, setNeedsSetup] = useState(() => !hasConfiguredModel(catalog, config))
  const [session, setSession] = useState(props.session)
  const [items, dispatch] = useReducer(reduceItems, undefined, () => itemsFromMessages(agent.messages))
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<UsageTotals>(agent.ledger.totals())
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmModel, setConfirmModel] = useState<{ ref: string; sizeBytes?: number } | null>(null)
  const [inputEpoch, setInputEpoch] = useState(0)
  const [modelRef, setModelRef] = useState(agent.modelRef)
  const abortRef = useRef<AbortController | null>(null)

  const handleSetupDone = useCallback(
    (ref: string) => {
      try {
        agent.setModel(ref)
        setModelRef(ref)
        setNeedsSetup(false)
      } catch (err) {
        // Key saved but setModel threw — shouldn't happen; proceed anyway
        setNeedsSetup(false)
      }
    },
    [agent],
  )

  useEffect(() => {
    const unsubscribe = agent.bus.subscribe((event) => {
      dispatch({ type: "agent", event })
      if (event.type === "turn-start") setBusy(true)
      if (event.type === "turn-end") setBusy(false)
      if (event.type === "step-finish") setUsage(agent.ledger.totals())
    })
    gate.setHandler(
      (req) =>
        new Promise((resolve) => {
          setPermission({
            req,
            resolve: (d) => {
              setPermission(null)
              resolve(d)
            },
          })
        }),
    )
    return () => {
      unsubscribe()
      gate.setHandler(undefined)
    }
  }, [agent, gate])

  const quit = useCallback(() => {
    store.close()
    process.exit(0)
  }, [store])

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") quit()
    if (permission) {
      if (key.name === "y") permission.resolve("allow")
      else if (key.name === "a") permission.resolve("always")
      else if (key.name === "n" || key.name === "escape") permission.resolve("deny")
      return
    }
    if (confirmModel) {
      if (key.name === "y") {
        const { ref } = confirmModel
        setConfirmModel(null)
        applyModel(ref)
      } else if (key.name === "n" || key.name === "escape") {
        setConfirmModel(null)
      }
      return
    }
    if (key.name === "escape") {
      if (pickerOpen) setPickerOpen(false)
      else if (busy) abortRef.current?.abort()
    }
  })

  const runCommand = useCallback(
    (cmd: string) => {
      const name = cmd.slice(1).trim().toLowerCase()
      switch (name) {
        case "help":
          dispatch({ type: "push", item: { kind: "info", text: HELP } })
          break
        case "model":
          setPickerOpen(true)
          break
        case "usage": {
          const lines = [`session usage (${usage.steps} steps):`]
          for (const [model, t] of agent.ledger.perModel()) {
            lines.push(
              `  ${model}: ↑${formatTokens(t.inputTokens)} ↓${formatTokens(t.outputTokens)} ` +
                `· cache read ${formatTokens(t.cachedInputTokens)} · ${formatCost(t.cost)}`,
            )
          }
          const lifetime = store.usageTotals(session.id)
          lines.push(
            `total this session: ${formatCost(lifetime.cost)} ` +
              `(↑${formatTokens(lifetime.inputTokens)} ↓${formatTokens(lifetime.outputTokens)}, ` +
              `${formatTokens(lifetime.cachedInputTokens)} cached reads)`,
          )
          dispatch({ type: "push", item: { kind: "info", text: lines.join("\n") } })
          break
        }
        case "new": {
          const fresh = store.createSession(session.cwd)
          setSession(fresh)
          agent.messages = []
          dispatch({ type: "reset", items: [] })
          dispatch({ type: "push", item: { kind: "info", text: "started a new session" } })
          break
        }
        case "clear":
          dispatch({ type: "reset", items: [] })
          break
        case "quit":
        case "exit":
          quit()
          break
        default:
          dispatch({ type: "push", item: { kind: "error", text: `unknown command ${cmd} — try /help` } })
      }
    },
    [agent, quit, session, store, usage.steps],
  )

  const submit = useCallback(
    (raw: string) => {
      const text = raw.trim()
      setInputEpoch((e) => e + 1)
      if (!text) return
      if (text.startsWith("/")) {
        runCommand(text)
        return
      }
      if (busy) {
        dispatch({ type: "push", item: { kind: "info", text: "still working — Esc to interrupt" } })
        return
      }
      if (agent.messages.length === 0) store.setTitle(session.id, text.slice(0, 80))
      dispatch({ type: "push", item: { kind: "user", text } })
      const controller = new AbortController()
      abortRef.current = controller
      void agent.send(text, controller.signal)
    },
    [agent, busy, runCommand, session.id, store],
  )

  const applyModel = useCallback(
    (ref: string) => {
      try {
        agent.setModel(ref)
        setModelRef(ref)
        dispatch({ type: "push", item: { kind: "info", text: `model → ${ref}` } })
      } catch (err) {
        dispatch({
          type: "push",
          item: { kind: "error", text: err instanceof Error ? err.message : String(err) },
        })
      }
    },
    [agent],
  )

  const pickModel = useCallback(
    (ref: string) => {
      setPickerOpen(false)
      const [providerId, modelId] = ref.split("/")
      const sizeBytes = providerId && modelId ? catalog[providerId]?.models?.[modelId]?.sizeBytes : undefined
      // Guard local models that won't fit in RAM — running them can swap-storm
      // the machine into a freeze. Make the user confirm before switching.
      if (localModelFit(sizeBytes).status === "oversized") {
        setConfirmModel({ ref, sizeBytes })
        return
      }
      applyModel(ref)
    },
    [applyModel, catalog],
  )

  const empty = items.length === 0
  const focusInput = !pickerOpen && !permission && !confirmModel

  if (needsSetup) {
    return <Setup onDone={handleSetupDone} catalog={catalog} animate={props.animate} />
  }

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      {empty ? <Logo animate={props.animate} /> : null}
      <scrollbox style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }} stickyScroll stickyStart="bottom">
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-mostly list
          <box key={i} style={{ marginTop: i === 0 ? 0 : 1, flexShrink: 0 }}>
            <ItemView item={item} />
          </box>
        ))}
      </scrollbox>

      {permission ? <PermissionView pending={permission} /> : null}
      {confirmModel ? (
        <ModelFitWarning modelRef={confirmModel.ref} sizeBytes={confirmModel.sizeBytes} />
      ) : null}
      {pickerOpen ? (
        <ModelPicker catalog={catalog} config={config} current={modelRef} onPick={pickModel} />
      ) : null}

      <box style={{ border: true, borderColor: theme.border, height: 3 }}>
        <input
          key={inputEpoch}
          focused={focusInput}
          placeholder={empty ? "Ask Dawn anything… (/help for commands)" : ""}
          onSubmit={(raw: unknown) =>
            submit(typeof raw === "string" ? raw : String((raw as any)?.value ?? ""))
          }
        />
      </box>

      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }}>
        <text fg={busy ? theme.accent : theme.dim}>{busy ? "✦ working… (Esc to stop)" : modelRef}</text>
        <text fg={theme.dim}>
          {`↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)} · ⚡${formatTokens(
            usage.cachedInputTokens,
          )} cached · ${formatCost(usage.cost)}`}
        </text>
      </box>
    </box>
  )
}

// ---------- model picker ----------

interface PickerProps {
  catalog: Catalog
  config: DawnConfig
  current: string
  onPick: (ref: string) => void
}

function ModelPicker({ catalog, config, current, onPick }: PickerProps) {
  const options = []
  for (const provider of connectedProviders(catalog, config)) {
    const models = catalog[provider.id]?.models ?? {}
    for (const model of Object.values(models)) {
      if (model.tool_call === false) continue
      const cost = model.cost
        ? `$${model.cost.input ?? "?"}/$${model.cost.output ?? "?"} per Mtok`
        : "free/unknown"
      const ctx = model.limit?.context ? ` · ${Math.round(model.limit.context / 1000)}k ctx` : ""
      // Local models carry a size; flag those that won't fit in RAM.
      const fit = model.sizeBytes ? localModelFit(model.sizeBytes) : undefined
      const ram = fit
        ? ` · ${formatBytes(model.sizeBytes)}${fit.status === "oversized" ? " ⚠ exceeds RAM" : fit.status === "tight" ? " · tight on RAM" : ""}`
        : ""
      options.push({
        name: `${provider.id}/${model.id}`,
        description: `${model.name} · ${cost}${ctx}${ram}`,
        value: `${provider.id}/${model.id}`,
      })
    }
  }
  options.sort((a, b) => (a.value === current ? -1 : b.value === current ? 1 : a.name.localeCompare(b.name)))

  if (options.length === 0) {
    return (
      <box style={{ border: true, borderColor: theme.error, padding: 1 }}>
        <text fg={theme.error}>
          No connected providers. Run `dawn auth login anthropic` (or set ANTHROPIC_API_KEY).
        </text>
      </box>
    )
  }

  return (
    <box
      style={{ border: true, borderColor: theme.accent, height: 14, flexDirection: "column" }}
      title="switch model (Esc to close)"
    >
      <select
        focused
        showScrollIndicator
        options={options}
        onSelect={(_i, opt) => opt && onPick(opt.value)}
        style={{ flexGrow: 1 }}
      />
    </box>
  )
}
