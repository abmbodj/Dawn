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
import {
  connectedProviders,
  formatBytes,
  hasConfiguredModel,
  localModelFit,
  resetDawnData,
  toolTitle,
} from "@dawn/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { Logo } from "./components/Logo"
import { Setup } from "./components/Setup"
import { dawnSyntaxStyle } from "./markdown"
import {
  formatSlashCommandHelp,
  getSlashCommandSuggestions,
  resolveSlashCommand,
  type SlashCommand,
} from "./slashCommands"
import {
  footerMode,
  formatContextReport,
  formatUsageReport,
  savingsBoxRows,
  statusFooterParts,
  type UsageBoxRow,
  usageBoxRows,
} from "./status"
import { theme } from "./theme"

// ---------- transcript state ----------

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; done?: boolean }
  | {
      kind: "tool"
      id: string
      name: string
      title: string
      summary?: string
      isError?: boolean
      done: boolean
    }
  | { kind: "reasoning"; text: string; done?: boolean }
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
          // A text-delta after reasoning marks the reasoning done
          const prevReasoning = last?.kind === "reasoning" ? last : undefined
          if (prevReasoning) {
            return [
              ...items.slice(0, -1),
              { ...prevReasoning, done: true },
              { kind: "assistant", text: ev.text },
            ]
          }
          return [...items, { kind: "assistant", text: ev.text }]
        }
        case "text-end": {
          const last = items[items.length - 1]
          if (last?.kind === "assistant") {
            return [...items.slice(0, -1), { ...last, done: true }]
          }
          return items
        }
        case "reasoning-delta": {
          const last = items[items.length - 1]
          if (last?.kind === "reasoning" && !last.done) {
            return [...items.slice(0, -1), { ...last, text: last.text + ev.text }]
          }
          return [...items, { kind: "reasoning", text: ev.text }]
        }
        case "tool-start": {
          // A tool-start after reasoning marks the reasoning done
          const last = items[items.length - 1]
          const base =
            last?.kind === "reasoning" && !last.done
              ? [...items.slice(0, -1), { ...last, done: true }]
              : items
          return [...base, { kind: "tool", id: ev.id, name: ev.name, title: ev.title, done: false }]
        }
        case "tool-end":
          return items.map((it) =>
            it.kind === "tool" && it.id === ev.id
              ? { ...it, done: true, summary: ev.summary, isError: ev.isError }
              : it,
          )
        case "error":
          return [...items, { kind: "error", text: ev.message }]
        case "turn-end": {
          // Sweep any not-yet-done assistant or reasoning items
          const swept = items.map((it) => {
            if ((it.kind === "assistant" || it.kind === "reasoning") && !it.done) {
              return { ...it, done: true }
            }
            return it
          })
          return ev.aborted ? [...swept, { kind: "info", text: "(interrupted)" }] : swept
        }
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
          items.push({ kind: "assistant", text: part.text, done: true })
        } else if (part.type === "tool-call") {
          items.push({
            kind: "tool",
            id: part.toolCallId,
            name: part.toolName,
            title: toolTitle(part.toolName, part.input ?? {}),
            done: true,
          })
        } else if (part.type === "reasoning" && part.text?.trim()) {
          items.push({ kind: "reasoning", text: part.text, done: true })
        }
      }
    }
  }
  return items
}

// ---------- helpers ----------

const HELP = formatSlashCommandHelp()

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? ""
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

function firstLines(s: string, n: number): string {
  return s
    .split("\n")
    .slice(0, n)
    .map((l) => (l.length > 120 ? `${l.slice(0, 120)}…` : l))
    .join("\n")
}

function isEnterKey(name: string): boolean {
  return name === "return" || name === "enter" || name === "kpenter" || name === "linefeed"
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 90)
    return () => clearInterval(id)
  }, [active])
  return SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0] ?? ""
}

// ---------- subviews ----------

function ItemView({
  item,
  spinnerFrame,
  isLastRunningTool,
}: {
  item: Item
  spinnerFrame: string
  isLastRunningTool: boolean
}) {
  switch (item.kind) {
    case "user":
      return (
        <text>
          <span fg={theme.user}>❯ </span>
          <span fg={theme.text}>{item.text}</span>
        </text>
      )
    case "assistant":
      return <markdown content={item.text} streaming={!item.done} syntaxStyle={dawnSyntaxStyle()} />
    case "reasoning": {
      if (!item.done) {
        return (
          <text fg={theme.dim}>
            <i>{`✦ thinking… (${item.text.length} chars)`}</i>
          </text>
        )
      }
      return <text fg={theme.dim}>{"✦ thought for a moment"}</text>
    }
    case "tool": {
      const color = !item.done ? theme.accent : item.isError ? theme.toolErr : theme.toolOk
      const mark = !item.done ? (isLastRunningTool ? spinnerFrame : "⚒") : item.isError ? "✗" : "✓"
      if (item.done && item.isError && item.summary) {
        return (
          <text>
            <text>
              <span fg={color}>{`${mark} ${item.name}`}</span>
              <span fg={theme.dim}>{item.title ? ` ${item.title}` : ""}</span>
            </text>
            <text fg={theme.toolErr}>{`  ${firstLines(item.summary, 3)}`}</text>
          </text>
        )
      }
      return (
        <text>
          <span fg={color}>{`${mark} ${item.name}`}</span>
          <span fg={theme.dim}>{item.title ? ` ${item.title}` : ""}</span>
          <span fg={theme.dim}>{item.done && item.summary ? ` — ${firstLine(item.summary)}` : ""}</span>
        </text>
      )
    }
    case "info":
      return <text fg={theme.dim}>{item.text}</text>
    case "error":
      return <text fg={theme.error}>{`error: ${item.text}`}</text>
  }
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

function SlashCommandSuggestionsView({
  suggestions,
  selectedIndex,
}: {
  suggestions: SlashCommand[]
  selectedIndex: number
}) {
  const visible = suggestions.slice(0, 8)
  return (
    <box
      style={{
        border: true,
        borderColor: theme.accent,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
      }}
      title="commands"
    >
      {visible.map((command, index) => {
        const selected = index === selectedIndex
        return (
          <text key={command.name}>
            <span fg={selected ? theme.accent : theme.dim}>{selected ? "› " : "  "}</span>
            <span fg={selected ? theme.accent : theme.text}>{`/${command.name}`}</span>
            <span fg={theme.dim}>{`  ${command.description}`}</span>
          </text>
        )
      })}
      <text fg={theme.dim}>Up/Down navigate · Tab complete · Enter run · Esc close</text>
    </box>
  )
}

const USAGE_BOX_WIDTH = 40
const USAGE_BOX_HEIGHT = 8
const SAVINGS_BOX_HEIGHT = 8
const METRIC_LABEL_WIDTH = 12

function MetricBox({
  title,
  rows,
  top,
  height,
}: {
  title: string
  rows: UsageBoxRow[]
  top: number
  height: number
}) {
  return (
    <box
      title={title}
      style={{
        position: "absolute",
        top,
        right: 1,
        zIndex: 10,
        width: USAGE_BOX_WIDTH,
        height,
        border: true,
        borderColor: theme.border,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {rows.map((row) => (
        <text key={row.label}>
          <span fg={theme.dim}>{metricLabel(row.label)}</span>
          <span fg={usageBoxToneColor(row.tone)}>{row.value}</span>
        </text>
      ))}
    </box>
  )
}

function metricLabel(label: string): string {
  const visibleLabel = label.length > METRIC_LABEL_WIDTH - 1 ? label.slice(0, METRIC_LABEL_WIDTH - 1) : label
  return visibleLabel.padEnd(METRIC_LABEL_WIDTH)
}

function usageBoxToneColor(tone: UsageBoxRow["tone"]): string {
  switch (tone) {
    case "accent":
      return theme.accent
    case "dim":
      return theme.dim
    default:
      return theme.text
  }
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
  const { width } = useTerminalDimensions()
  const [needsSetup, setNeedsSetup] = useState(() => !hasConfiguredModel(catalog, config))
  const [session, setSession] = useState(props.session)
  const [items, dispatch] = useReducer(reduceItems, undefined, () => itemsFromMessages(agent.messages))
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<UsageTotals>(() => store.usageTotals(props.session.id))
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmModel, setConfirmModel] = useState<{ ref: string; sizeBytes?: number } | null>(null)
  const [promptValue, setPromptValue] = useState("")
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const [dismissedCompletionValue, setDismissedCompletionValue] = useState<string | null>(null)
  const [modelRef, setModelRef] = useState(agent.modelRef)
  const abortRef = useRef<AbortController | null>(null)
  const programmaticPromptValueRef = useRef<string | null>(null)
  const spinnerFrame = useSpinner(busy)

  // Index of the last not-yet-done tool item (for spinner placement)
  const lastRunningToolId = (() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it?.kind === "tool" && !it.done) return it.id
    }
    return null
  })()

  // Show a "thinking" row when busy but no in-flight tool is in progress
  const showThinking = busy && lastRunningToolId === null

  const handleSetupDone = useCallback(
    (ref: string) => {
      try {
        agent.setModel(ref)
        setModelRef(ref)
        setNeedsSetup(false)
      } catch {
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
      if (event.type === "step-finish") setUsage(store.usageTotals(session.id))
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
  }, [agent, gate, session.id, store])

  const quit = useCallback(() => {
    agent.close()
    store.close()
    process.exit(0)
  }, [agent, store])

  const runCommand = useCallback(
    (cmd: string) => {
      const command = resolveSlashCommand(cmd)
      if (!command) {
        dispatch({ type: "push", item: { kind: "error", text: `unknown command ${cmd} — try /help` } })
        return
      }
      switch (command.name) {
        case "help":
          dispatch({ type: "push", item: { kind: "info", text: HELP } })
          break
        case "model":
          setPickerOpen(true)
          break
        case "usage": {
          const lifetime = store.usageTotals(session.id)
          dispatch({
            type: "push",
            item: {
              kind: "info",
              text: formatUsageReport({
                perModel: agent.ledger.perModel(),
                lifetime,
                context: agent.contextStats(),
                catalog,
              }),
            },
          })
          break
        }
        case "context": {
          dispatch({ type: "push", item: { kind: "info", text: formatContextReport(agent.contextStats()) } })
          break
        }
        case "new": {
          if (busy) {
            dispatch({ type: "push", item: { kind: "info", text: "still working — Esc to interrupt" } })
            break
          }
          const fresh = store.createSession(session.cwd)
          setSession(fresh)
          agent.startSession(fresh.id)
          setUsage(store.usageTotals(fresh.id))
          dispatch({ type: "reset", items: [] })
          dispatch({ type: "push", item: { kind: "info", text: "started a new session" } })
          break
        }
        case "clear":
          dispatch({ type: "reset", items: [] })
          break
        case "reset":
          resetDawnData()
          dispatch({ type: "reset", items: [] })
          setNeedsSetup(true)
          break
        case "quit":
          quit()
          break
      }
    },
    [agent, busy, catalog, quit, session, store],
  )

  const submit = useCallback(
    (raw: string) => {
      const text = raw.trim()
      if (!text) return
      setPromptValue("")
      setSelectedSuggestion(0)
      setDismissedCompletionValue(null)
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

  const handlePromptInput = useCallback((value: string) => {
    setPromptValue(value)
    setSelectedSuggestion(0)
    if (programmaticPromptValueRef.current === value) {
      programmaticPromptValueRef.current = null
      return
    }
    setDismissedCompletionValue(null)
  }, [])

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
  const commandSuggestions = getSlashCommandSuggestions(promptValue)
  const completionOpen =
    focusInput && dismissedCompletionValue !== promptValue && commandSuggestions.length > 0
  const selectedSuggestionIndex =
    commandSuggestions.length > 0 ? Math.min(selectedSuggestion, commandSuggestions.length - 1) : 0
  const selectedCommand = commandSuggestions[selectedSuggestionIndex]
  const showUsageBox = footerMode(width) === "wide"
  const footer = statusFooterParts({ busy, catalog, modelRef, usage, width, showUsageBox })
  const usageRows = showUsageBox ? usageBoxRows({ usage, context: agent.contextStats() }) : []
  const savingsRows = showUsageBox
    ? savingsBoxRows({ usage, context: agent.contextStats(), catalog, modelRef })
    : []

  const fillSuggestion = useCallback((command: SlashCommand) => {
    const value = `/${command.name}`
    programmaticPromptValueRef.current = value
    setPromptValue(value)
    setSelectedSuggestion(0)
    setDismissedCompletionValue(value)
  }, [])

  const runSuggestion = useCallback(
    (command: SlashCommand) => {
      setPromptValue("")
      setSelectedSuggestion(0)
      setDismissedCompletionValue(null)
      runCommand(`/${command.name}`)
    },
    [runCommand],
  )

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
    if (completionOpen && selectedCommand) {
      if (key.name === "down") {
        key.preventDefault()
        key.stopPropagation()
        setSelectedSuggestion((index) => (index + 1) % commandSuggestions.length)
        return
      }
      if (key.name === "up") {
        key.preventDefault()
        key.stopPropagation()
        setSelectedSuggestion((index) => (index - 1 + commandSuggestions.length) % commandSuggestions.length)
        return
      }
      if (key.name === "tab") {
        key.preventDefault()
        key.stopPropagation()
        fillSuggestion(selectedCommand)
        return
      }
      if (isEnterKey(key.name)) {
        key.preventDefault()
        key.stopPropagation()
        runSuggestion(selectedCommand)
        return
      }
      if (key.name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        setDismissedCompletionValue(promptValue)
        return
      }
    }
    if (key.name === "escape") {
      if (pickerOpen) setPickerOpen(false)
      else if (busy) abortRef.current?.abort()
    }
  })

  if (needsSetup) {
    return <Setup onDone={handleSetupDone} catalog={catalog} animate={props.animate} />
  }

  return (
    <box style={{ position: "relative", flexDirection: "column", flexGrow: 1 }}>
      {empty ? (
        <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
          <Logo animate={props.animate} />
        </box>
      ) : (
        <scrollbox
          style={{
            flexGrow: 1,
            paddingLeft: 1,
            paddingRight: showUsageBox ? USAGE_BOX_WIDTH + 3 : 1,
          }}
          stickyScroll
          stickyStart="bottom"
        >
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-mostly list
            <box key={i} style={{ marginTop: i === 0 ? 0 : 1, flexShrink: 0 }}>
              <ItemView
                item={item}
                spinnerFrame={spinnerFrame}
                isLastRunningTool={item.kind === "tool" && !item.done && item.id === lastRunningToolId}
              />
            </box>
          ))}
          {showThinking ? (
            <box style={{ marginTop: 1, flexShrink: 0 }}>
              <text fg={theme.dim}>
                <i>{`${spinnerFrame} thinking…`}</i>
              </text>
            </box>
          ) : null}
        </scrollbox>
      )}

      {showUsageBox ? (
        <>
          <MetricBox title="usage" rows={usageRows} top={0} height={USAGE_BOX_HEIGHT} />
          <MetricBox title="savings" rows={savingsRows} top={USAGE_BOX_HEIGHT} height={SAVINGS_BOX_HEIGHT} />
        </>
      ) : null}

      {permission ? <PermissionView pending={permission} /> : null}
      {confirmModel ? (
        <ModelFitWarning modelRef={confirmModel.ref} sizeBytes={confirmModel.sizeBytes} />
      ) : null}
      {pickerOpen ? (
        <ModelPicker catalog={catalog} config={config} current={modelRef} onPick={pickModel} />
      ) : null}
      {completionOpen ? (
        <SlashCommandSuggestionsView
          suggestions={commandSuggestions}
          selectedIndex={selectedSuggestionIndex}
        />
      ) : null}

      <box style={{ border: true, borderColor: theme.border, height: 3 }}>
        <input
          focused={focusInput}
          value={promptValue}
          placeholder={empty ? "Ask Dawn anything… (/help for commands)" : ""}
          onInput={handlePromptInput}
          onSubmit={(raw: unknown) =>
            submit(typeof raw === "string" ? raw : String((raw as any)?.value ?? ""))
          }
        />
      </box>

      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
        {footer.mode === "narrow" ? (
          <text fg={busy ? theme.accent : theme.dim}>{footer.left}</text>
        ) : (
          <>
            <box style={{ width: Math.max(18, Math.floor(width * 0.45)), flexShrink: 0 }}>
              <text fg={busy ? theme.accent : theme.dim}>{footer.left}</text>
            </box>
            {footer.right ? (
              <box style={{ flexGrow: 1, justifyContent: "flex-end" }}>
                <text fg={theme.dim}>{footer.right}</text>
              </box>
            ) : null}
          </>
        )}
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
