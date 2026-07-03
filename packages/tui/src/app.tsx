import type {
  AgentEvent,
  Asker,
  Catalog,
  DawnAgent,
  DawnConfig,
  InstalledPlugin,
  McpServerConfig,
  ModelMessage,
  PermissionGate,
  PermissionMode,
  PermissionRequest,
  SessionMeta,
  SessionStore,
  TodoItem,
  UsageTotals,
  UserQuestion,
} from "@dawn/core"
import {
  addPlugin,
  connectedProviders,
  formatBytes,
  hasConfiguredModel,
  listInstalledPlugins,
  loadConfig,
  localModelFit,
  parseModelRef,
  removePlugin,
  renderCommandPrompt,
  resetDawnData,
  saveConfig,
  toolTitle,
  withLiveModels,
} from "@dawn/core"
import type { ScrollBoxRenderable, TextareaOptions, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { type RefObject, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { Logo } from "./components/Logo"
import { McpSetup } from "./components/McpSetup"
import { ModelPicker } from "./components/ModelPicker"
import { PluginSetup } from "./components/PluginSetup"
import { ProviderConnect, type ProviderOption, SETUP_PROVIDERS } from "./components/ProviderConnect"
import { Setup } from "./components/Setup"
import { SkillsSetup } from "./components/SkillsSetup"
import {
  applyMention,
  extractMentionQuery,
  filterFileMentions,
  mentionCaretOffset,
  scanProjectFiles,
} from "./fileMentions"
import { loadImageAttachment } from "./imageAttach"
import { dawnSyntaxStyle } from "./markdown"
import { SCROLL_STEP } from "./scrollConstants"
import {
  formatSlashCommandHelp,
  getSlashCommandSuggestions,
  registerDynamicCommands,
  resolveSlashCommand,
  type SlashCommand,
} from "./slashCommands"
import {
  footerMode,
  formatContextReport,
  formatSavingsReport,
  formatUsageReport,
  modelLabel,
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
      preview?: string
      isError?: boolean
      done: boolean
    }
  | { kind: "reasoning"; text: string; done?: boolean }
  | { kind: "info"; text: string; silent?: boolean }
  | { kind: "error"; text: string }
  | { kind: "todos"; items: TodoItem[] }

type Action =
  | { type: "push"; item: Item }
  | { type: "agent"; event: AgentEvent }
  | { type: "reset"; items: Item[] }

export function reduceItems(items: Item[], action: Action): Item[] {
  switch (action.type) {
    case "push":
      return [...items, action.item]
    case "reset":
      return action.items
    case "agent": {
      const ev = action.event
      switch (ev.type) {
        case "attempt-reset": {
          for (let i = items.length - 1; i >= 0; i--) {
            if (items[i]?.kind === "user") return items.slice(0, i + 1)
          }
          return items
        }
        case "text-delta": {
          const last = items[items.length - 1]
          if (last?.kind === "assistant") {
            return items.with(items.length - 1, { ...last, text: last.text + ev.text })
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
            return items.with(items.length - 1, { ...last, done: true })
          }
          return items
        }
        case "reasoning-delta": {
          const last = items[items.length - 1]
          if (last?.kind === "reasoning" && !last.done) {
            return items.with(items.length - 1, { ...last, text: last.text + ev.text })
          }
          return [...items, { kind: "reasoning", text: ev.text }]
        }
        case "tool-start": {
          // A tool-start after reasoning marks the reasoning done
          const last = items[items.length - 1]
          const base =
            last?.kind === "reasoning" && !last.done
              ? items.with(items.length - 1, { ...last, done: true })
              : items
          return [
            ...base,
            { kind: "tool", id: ev.id, name: ev.name, title: ev.title, preview: ev.preview, done: false },
          ]
        }
        case "tool-end":
          return items.map((it) =>
            it.kind === "tool" && it.id === ev.id
              ? { ...it, done: true, summary: ev.summary, isError: ev.isError }
              : it,
          )
        case "model-switched":
          return [
            ...items,
            { kind: "info", text: `auto-switched model: ${ev.from} → ${ev.to} (${ev.reason})` },
          ]
        case "status":
          return [...items, { kind: "info", text: ev.message }]
        case "error":
          return [...items, { kind: "error", text: ev.message }]
        case "todos": {
          // Keep one evolving checklist, floated to the current point of activity.
          const withoutTodos = items.filter((it) => it.kind !== "todos")
          return [...withoutTodos, { kind: "todos", items: ev.items }]
        }
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

const INIT_PROMPT = `Scan this repository and create (or update) an \`AGENTS.md\` file at the project root.

Steps:
1. Use \`repo_overview\` to understand the overall structure.
2. Read key convention files you find: \`package.json\`, \`tsconfig*.json\`, \`biome.json\` / \`.eslintrc*\`, \`*.md\` at the root, and any workspace config.
3. Write \`AGENTS.md\` at the project root capturing the conventions an AI coding agent must know:
   - Project purpose and tech stack (2–3 sentences max)
   - Build, test, typecheck, and lint commands (exact \`bun\`/\`npm\` scripts)
   - File/folder layout that isn't obvious from structure (e.g. where tools live, where new features go)
   - Naming and code-style conventions
   - What NOT to do (e.g. don't commit, don't use a banned pattern, don't touch generated files)
   - Any project-specific gotchas or non-obvious invariants

If \`AGENTS.md\` already exists, read it first and update it with anything missing or outdated — do not wholesale replace content that is still accurate.

Keep the file under 150 lines. Favour bullet points over prose. This file is read by the agent on every session start, so signal-to-noise ratio is critical.`

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

function DiffLines({ preview }: { preview: string }) {
  return (
    <box style={{ flexDirection: "column" }}>
      {preview.split("\n").map((line, i) => {
        const color = line.startsWith("+") ? theme.toolOk : line.startsWith("-") ? theme.toolErr : theme.dim
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: preview lines are positional by nature
          <text key={i} fg={color}>{`  ${line}`}</text>
        )
      })}
    </box>
  )
}

export function ItemView({
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
      const mark = !item.done ? (isLastRunningTool ? spinnerFrame : "⏺") : item.isError ? "⏺" : "⏺"
      if (item.done && item.isError && item.summary) {
        return (
          <box style={{ flexDirection: "column" }}>
            <text>
              <span fg={color}>{`${mark} `}</span>
              <span fg={color}>{item.name}</span>
              <span fg={theme.dim}>{item.title ? `(${item.title})` : ""}</span>
            </text>
            <text fg={theme.toolErr}>{`  ${firstLines(item.summary, 3)}`}</text>
          </box>
        )
      }
      const toolLine = (
        <text>
          <span fg={color}>{`${mark} `}</span>
          <span fg={color}>{item.name}</span>
          <span fg={theme.dim}>{item.title ? `(${item.title})` : ""}</span>
          <span fg={theme.dim}>{item.done && item.summary ? ` — ${firstLine(item.summary)}` : ""}</span>
        </text>
      )
      if (!item.preview) return toolLine
      return (
        <box style={{ flexDirection: "column" }}>
          {toolLine}
          <DiffLines preview={item.preview} />
        </box>
      )
    }
    case "info":
      return <text fg={theme.dim}>{item.text}</text>
    case "error":
      return <text fg={theme.error}>{`error: ${item.text}`}</text>
    case "todos":
      return (
        <box style={{ flexDirection: "column" }}>
          {item.items.map((todo) => {
            if (todo.status === "completed") {
              return (
                <text key={todo.content}>
                  <span fg={theme.toolOk}>{"[✓] "}</span>
                  <span fg={theme.dim}>{todo.content}</span>
                </text>
              )
            }
            if (todo.status === "in_progress") {
              return (
                <text key={todo.content}>
                  <span fg={theme.accent}>{"[→] "}</span>
                  <span fg={theme.text}>{todo.activeForm ?? todo.content}</span>
                </text>
              )
            }
            return (
              <text key={todo.content}>
                <span fg={theme.dim}>{"[ ] "}</span>
                <span fg={theme.dim}>{todo.content}</span>
              </text>
            )
          })}
        </box>
      )
  }
}

interface PendingPermission {
  req: PermissionRequest
  resolve: (d: "allow" | "always" | "deny") => void
}

function PermissionView({
  pending,
  scrollRef,
}: {
  pending: PendingPermission
  scrollRef?: RefObject<ScrollBoxRenderable | null>
}) {
  return (
    <box
      style={{
        border: true,
        borderColor: theme.accent,
        padding: 1,
        flexDirection: "column",
        flexShrink: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
      title="allow this action?"
    >
      <text>
        <span fg={theme.accent}>{`${pending.req.tool} `}</span>
        <span fg={theme.text}>{pending.req.title}</span>
      </text>
      {pending.req.detail ? (
        <scrollbox ref={scrollRef} style={{ flexShrink: 1, minHeight: 0 }} stickyStart="top">
          <text fg={theme.dim} wrapMode="word">
            {pending.req.detail}
          </text>
        </scrollbox>
      ) : null}
      <text fg={theme.dim}>{"─".repeat(30)}</text>
      <text>
        <span fg={theme.accent}>y</span>
        <span fg={theme.dim}> allow once </span>
        <span fg={theme.accent}>a</span>
        <span fg={theme.dim}> always </span>
        <span fg={theme.accent}>n</span>
        <span fg={theme.dim}>/Esc deny · PgUp/PgDn scroll</span>
      </text>
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

function PlanReviewPanel({
  pending,
  selectedIndex,
  scrollRef,
}: {
  pending: PendingQuestion
  selectedIndex: number
  scrollRef?: RefObject<ScrollBoxRenderable | null>
}) {
  const { q } = pending
  return (
    <box
      style={{
        border: true,
        borderColor: theme.user,
        padding: 1,
        flexDirection: "column",
        flexShrink: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
      title="plan ready — review & approve"
    >
      {q.detail ? (
        <scrollbox ref={scrollRef} style={{ flexShrink: 1, minHeight: 0 }} stickyStart="top">
          <markdown content={q.detail} syntaxStyle={dawnSyntaxStyle()} />
        </scrollbox>
      ) : (
        <text fg={theme.text}>{q.question}</text>
      )}
      <text fg={theme.dim}>{"─".repeat(30)}</text>
      {q.options.map((opt, i) => {
        const selected = i === selectedIndex
        return (
          <text key={opt.label}>
            <span fg={selected ? theme.user : theme.dim}>{`${i + 1} `}</span>
            <span fg={selected ? theme.accent : theme.text}>{opt.label}</span>
          </text>
        )
      })}
      <text fg={theme.dim}>{"─".repeat(30)}</text>
      <text fg={theme.dim}>{"1–3 quick-pick · ↑↓ navigate · Enter select · PgUp/PgDn scroll"}</text>
    </box>
  )
}

function QuestionView({
  pending,
  selectedIndex,
  scrollRef,
}: {
  pending: PendingQuestion
  selectedIndex: number
  scrollRef?: RefObject<ScrollBoxRenderable | null>
}) {
  const { q } = pending
  return (
    <box
      style={{
        border: true,
        borderColor: theme.accent,
        padding: 1,
        flexDirection: "column",
        flexShrink: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
      title="question"
    >
      <text fg={theme.text}>{q.question}</text>
      {q.detail ? (
        <scrollbox ref={scrollRef} style={{ flexShrink: 1, minHeight: 0 }} stickyStart="top">
          <text fg={theme.dim} wrapMode="word">
            {q.detail}
          </text>
        </scrollbox>
      ) : null}
      <text fg={theme.dim}>{"─".repeat(30)}</text>
      {q.options.map((opt, i) => {
        const selected = i === selectedIndex
        return (
          <text key={opt.label}>
            <span fg={selected ? theme.accent : theme.dim}>{`${i + 1} `}</span>
            <span fg={selected ? theme.accent : theme.text}>{opt.label}</span>
            {opt.description ? <span fg={theme.dim}>{`  ${opt.description}`}</span> : null}
          </text>
        )
      })}
      <text fg={theme.dim}>{"─".repeat(30)}</text>
      <text fg={theme.dim}>
        {"↑↓ navigate · 1–9 quick-pick · Enter select · Esc cancel · PgUp/PgDn scroll"}
      </text>
    </box>
  )
}

function SlashCommandSuggestionsView({
  suggestions,
  selectedIndex,
  maxRows,
}: {
  suggestions: SlashCommand[]
  selectedIndex: number
  maxRows: number
}) {
  // On a short terminal we can only show a few rows; slide a window around the
  // selected command so the highlight stays visible as the user arrows past the
  // fold. Bounding the box (flexShrink/overflow) guarantees it never overdraws.
  const count = Math.max(1, Math.min(maxRows, suggestions.length))
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(count / 2), suggestions.length - count))
  const visible = suggestions.slice(start, start + count)
  return (
    <box
      style={{
        border: true,
        borderColor: theme.accent,
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
        paddingLeft: 1,
        paddingRight: 1,
      }}
      title="commands"
    >
      {visible.map((command, index) => {
        const selected = start + index === selectedIndex
        return (
          <text key={command.name}>
            <span fg={selected ? theme.accent : theme.dim}>{selected ? "› " : "  "}</span>
            <span fg={selected ? theme.accent : theme.text}>{`/${command.name}`}</span>
            {command.args ? <span fg={theme.dim}>{` ${command.args}`}</span> : null}
            <span fg={theme.dim}>{`  ${command.description}`}</span>
          </text>
        )
      })}
    </box>
  )
}

function FileMentionSuggestionsView({
  suggestions,
  selectedIndex,
  maxRows,
}: {
  suggestions: string[]
  selectedIndex: number
  maxRows: number
}) {
  const count = Math.max(1, Math.min(maxRows, suggestions.length))
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(count / 2), suggestions.length - count))
  const visible = suggestions.slice(start, start + count)
  return (
    <box
      style={{
        border: true,
        borderColor: theme.accent,
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
        paddingLeft: 1,
        paddingRight: 1,
      }}
      title="files"
    >
      {visible.map((file, index) => {
        const selected = start + index === selectedIndex
        return (
          <text key={file}>
            <span fg={selected ? theme.accent : theme.dim}>{selected ? "› " : "  "}</span>
            <span fg={selected ? theme.accent : theme.text}>{file}</span>
          </text>
        )
      })}
    </box>
  )
}

const TIPS: Array<{ key: string; desc: string }> = [
  { key: "Shift+Tab", desc: "cycle mode: normal · auto-edit · plan" },
  { key: "/", desc: "open commands" },
  { key: "↑ ↓", desc: "navigate history" },
  { key: "Enter", desc: "send message" },
  { key: "Shift+Enter", desc: "insert newline" },
  { key: "Esc", desc: "stop generation" },
]

function WelcomeTips() {
  const tip = useMemo(
    () => TIPS[Math.floor(Math.random() * TIPS.length)] ?? { key: "/", desc: "open commands" },
    [],
  )
  return (
    <text style={{ marginTop: 1 }}>
      <span fg={theme.dim}>{"tip  "}</span>
      <span fg={theme.accent}>{tip.key}</span>
      <span fg={theme.dim}>{`  ${tip.desc}`}</span>
    </text>
  )
}

function modeColor(mode: PermissionMode): string {
  if (mode === "acceptEdits") return theme.toolOk
  if (mode === "plan") return theme.user
  return theme.accent
}

// Always visible — shows current mode and the Shift+Tab hint.
function ModeChipRow({ permMode }: { permMode: PermissionMode }) {
  const color = modeColor(permMode)
  const label = permMode === "acceptEdits" ? "AUTO-EDIT" : permMode === "plan" ? "PLAN" : "NORMAL"
  return (
    <box style={{ height: 1, paddingLeft: 1 }}>
      <text>
        <span fg={color}>{`▌ ${label}`}</span>
        <span fg={theme.dim}>{"  Shift+Tab to cycle"}</span>
      </text>
    </box>
  )
}

const USAGE_BOX_WIDTH = 40
const USAGE_BOX_HEIGHT = 8
const SAVINGS_BOX_HEIGHT = 8
const METRIC_LABEL_WIDTH = 12

// Max content lines the chat input grows to before it starts scrolling internally.
const INPUT_MAX_LINES = 8

// Chat input keybindings: Enter sends, Shift+Enter (or Alt/Cmd+Enter) inserts a
// newline. This overrides the textarea default (where Enter inserts a newline).
const CHAT_INPUT_KEY_BINDINGS: NonNullable<TextareaOptions["keyBindings"]> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
]

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
  asker: Asker
  animate: boolean
}

interface PendingQuestion {
  q: UserQuestion
  resolve: (index: number) => void
}

function cycleMode(current: PermissionMode): PermissionMode {
  if (current === "normal") return "acceptEdits"
  if (current === "acceptEdits") return "plan"
  return "normal"
}

export function App(props: AppProps) {
  const { agent, store, catalog, config, gate, asker } = props
  const { width, height } = useTerminalDimensions()
  const [needsSetup, setNeedsSetup] = useState(() => !hasConfiguredModel(catalog, config))
  const [catalogVersion, setCatalogVersion] = useState(0)
  const [session, setSession] = useState(props.session)
  const [items, dispatch] = useReducer(reduceItems, undefined, () => itemsFromMessages(agent.messages))
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<UsageTotals>(() => store.usageTotals(props.session.id))
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerProvider, setPickerProvider] = useState<string | undefined>(undefined)
  const [pickerTarget, setPickerTarget] = useState<"edit" | "plan">("edit")
  const [connect, setConnect] = useState<{ provider?: ProviderOption } | null>(null)
  const [connectEpoch, setConnectEpoch] = useState(0)
  const [confirmModel, setConfirmModel] = useState<{
    ref: string
    sizeBytes?: number
    target: "edit" | "plan"
  } | null>(null)
  const [promptValue, setPromptValue] = useState("")
  const [inputLines, setInputLines] = useState(1)
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const [dismissedCompletionValue, setDismissedCompletionValue] = useState<string | null>(null)
  const [projectFiles, setProjectFiles] = useState<string[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [selectedMention, setSelectedMention] = useState(0)
  // Submitted prompts, oldest→newest, for Up/Down recall in the input.
  const [history, setHistory] = useState<string[]>([])
  const textareaRef = useRef<TextareaRenderable | null>(null)
  const historyIndexRef = useRef<number | null>(null)
  const draftRef = useRef("")
  const caretRef = useRef<{ line: number; lineCount: number; caretOffset: number }>({
    line: 0,
    lineCount: 1,
    caretOffset: 0,
  })
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const [modelRef, setModelRef] = useState(agent.modelRef)
  const [planModelRef, setPlanModelRef] = useState<string | undefined>(agent.planModelRef)
  const [permMode, setPermMode] = useState<PermissionMode>("normal")
  const [mcpSetupOpen, setMcpSetupOpen] = useState(false)
  const [skillsSetupOpen, setSkillsSetupOpen] = useState(false)
  const [pluginSetupOpen, setPluginSetupOpen] = useState(false)
  const [setupConfig, setSetupConfig] = useState<DawnConfig>(config)
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>(() => listInstalledPlugins())
  const [pendingImages, setPendingImages] = useState<
    Array<{ base64: string; mimeType: string; name: string }>
  >([])

  // Register plugin commands as dynamic slash commands once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pluginCmds = agent.pluginCommands
  useEffect(() => {
    if (pluginCmds.length > 0) {
      registerDynamicCommands(
        pluginCmds.map((c) => ({ name: c.name, description: c.description, args: c.argHint })),
      )
    }
    return () => registerDynamicCommands([])
  }, [pluginCmds])
  const [question, setQuestion] = useState<PendingQuestion | null>(null)
  const [questionSel, setQuestionSel] = useState(0)
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
      // Refresh live model list for whichever provider was just connected
      const { providerId } = parseModelRef(ref)
      withLiveModels(catalog, providerId, config).then(() => setCatalogVersion((v) => v + 1))
    },
    [agent, catalog, config],
  )

  useEffect(() => {
    gate.setMode(permMode)
  }, [gate, permMode])

  // Show a one-time dim note when project instructions are loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-once effect
  useEffect(() => {
    const { sources } = agent.projectMemory
    if (sources.length > 0) {
      dispatch({
        type: "push",
        item: { kind: "info", text: `loaded project instructions: ${sources.join(", ")}`, silent: true },
      })
    }
  }, [])

  useEffect(() => {
    const unsubscribe = agent.bus.subscribe((event) => {
      dispatch({ type: "agent", event })
      if (event.type === "turn-start") setBusy(true)
      if (event.type === "turn-end") setBusy(false)
      if (event.type === "step-finish") setUsage(store.usageTotals(session.id))
      if (event.type === "model-switched") {
        // Keep the displayed model ref in sync when the agent auto-switches
        setModelRef(event.to)
      }
      if (event.type === "step-limit") {
        const msg = event.hasOpenTodos
          ? `paused at step ${event.stepCount} — unfinished tasks remain. Say "continue" to keep going.`
          : `reached ${event.stepCount} steps — say "continue" if there's more to do.`
        dispatch({ type: "push", item: { kind: "info", text: msg } })
      }
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
    asker.setHandler(
      (q) =>
        new Promise((resolve) => {
          setQuestion({
            q,
            resolve: (index) => {
              setQuestion(null)
              setQuestionSel(0)
              resolve(index)
            },
          })
        }),
    )
    return () => {
      unsubscribe()
      gate.setHandler(undefined)
      asker.setHandler(undefined)
    }
  }, [agent, asker, gate, session.id, store])

  const quit = useCallback(() => {
    void agent.close().finally(() => {
      store.close()
      process.exit(0)
    })
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
          setPickerTarget("edit")
          setPickerOpen(true)
          break
        case "plan-model":
          setPickerTarget("plan")
          setPickerOpen(true)
          break
        case "connect":
          setConnect({})
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
        case "savings": {
          const projectSessions = store.sessionsForCwd(session.cwd).map((meta) => meta.id)
          const lifetimeSessions = store.allSessions().map((meta) => meta.id)
          dispatch({
            type: "push",
            item: {
              kind: "info",
              text: formatSavingsReport({
                scopes: [
                  {
                    label: "session",
                    usage: store.usageTotals(session.id),
                    context: agent.contextPlanTotals([session.id]),
                  },
                  {
                    label: "project",
                    usage: store.usageTotalsForCwd(session.cwd),
                    context: agent.contextPlanTotals(projectSessions),
                  },
                  {
                    label: "lifetime",
                    usage: store.usageTotalsAll(),
                    context: agent.contextPlanTotals(lifetimeSessions),
                  },
                ],
                catalog,
                modelRef,
              }),
            },
          })
          break
        }
        case "init": {
          if (busy) {
            dispatch({ type: "push", item: { kind: "info", text: "still working — Esc to interrupt" } })
            break
          }
          dispatch({ type: "push", item: { kind: "user", text: "/init" } })
          const initController = new AbortController()
          abortRef.current = initController
          void agent.send(INIT_PROMPT, initController.signal)
          break
        }
        case "mcp":
          setMcpSetupOpen(true)
          break
        case "skills":
          setSkillsSetupOpen(true)
          break
        case "context": {
          dispatch({
            type: "push",
            item: {
              kind: "info",
              text: formatContextReport(agent.contextStats(), agent.projectMemory.sources),
            },
          })
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
        case "resume": {
          if (busy) {
            dispatch({ type: "push", item: { kind: "info", text: "still working — Esc to interrupt first" } })
            break
          }
          const sessions = store.sessionsForCwd(session.cwd).filter((s) => s.id !== session.id)
          if (sessions.length === 0) {
            dispatch({ type: "push", item: { kind: "info", text: "no other sessions for this directory" } })
            break
          }
          const resumeArg = cmd.trim().split(/\s+/)[1]
          if (!resumeArg) {
            const lines = sessions
              .slice(0, 10)
              .map(
                (s, i) => `  ${i}  ${new Date(s.updatedAt).toLocaleString()}  "${s.title || "(untitled)"}"`,
              )
            dispatch({
              type: "push",
              item: { kind: "info", text: `Recent sessions (use /resume N to switch):\n${lines.join("\n")}` },
            })
            break
          }
          const target = sessions[Number.parseInt(resumeArg, 10)]
          if (!target) {
            dispatch({
              type: "push",
              item: { kind: "error", text: `no session ${resumeArg} — run /resume to list them` },
            })
            break
          }
          setSession(target)
          agent.startSession(target.id, store.loadMessages(target.id))
          setUsage(store.usageTotals(target.id))
          dispatch({ type: "reset", items: [] })
          dispatch({
            type: "push",
            item: {
              kind: "info",
              text: `Resumed "${target.title || "(untitled)"}" — ${agent.messages.length} message(s) of context restored.`,
            },
          })
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
        case "plugin":
          setInstalledPlugins(listInstalledPlugins())
          setSetupConfig(loadConfig(agent.cwd))
          setPluginSetupOpen(true)
          break
        case "image": {
          const arg = cmd.trim().split(/\s+/).slice(1).join(" ")
          if (!arg) {
            dispatch({
              type: "push",
              item: { kind: "info", text: "usage: /image <path> — attaches the image to your next message" },
            })
            break
          }
          const result = loadImageAttachment(agent.cwd, arg)
          if (!result.ok) {
            dispatch({ type: "push", item: { kind: "error", text: result.error } })
            break
          }
          const { base64, mimeType, name, sizeKb } = result.image
          setPendingImages((prev) => [...prev, { base64, mimeType, name }])
          dispatch({
            type: "push",
            item: {
              kind: "info",
              text: `attached ${name} (${sizeKb} KB) — will be sent with your next message`,
            },
          })
          break
        }
        case "rewind": {
          if (busy) {
            dispatch({ type: "push", item: { kind: "info", text: "still working — Esc to interrupt first" } })
            break
          }
          // Parse optional index arg: "/rewind 2" → rewind to checkpoint 2
          const rewindArg = cmd.trim().split(/\s+/)[1]
          const checkpoints = agent.checkpoints.list()
          if (checkpoints.length === 0) {
            dispatch({
              type: "push",
              item: {
                kind: "info",
                text: "no checkpoints yet — checkpoints are taken at the start of each turn",
              },
            })
            break
          }
          if (!rewindArg) {
            // Show list
            const lines = checkpoints.map(
              (cp, i) =>
                `  ${i}  turn ${cp.turnIndex}  ${new Date(cp.timestamp).toLocaleTimeString()}  "${cp.label}"`,
            )
            dispatch({
              type: "push",
              item: {
                kind: "info",
                text: `Recent checkpoints (use /rewind N to restore):\n${lines.join("\n")}`,
              },
            })
            break
          }
          const cpIndex = Number.parseInt(rewindArg, 10)
          const target = checkpoints[cpIndex]
          if (!target) {
            dispatch({
              type: "push",
              item: { kind: "error", text: `no checkpoint ${cpIndex} — run /rewind to list them` },
            })
            break
          }
          const restored = agent.checkpoints.restore(target)
          if (!restored) {
            dispatch({
              type: "push",
              item: { kind: "error", text: `failed to restore checkpoint ${cpIndex}` },
            })
            break
          }
          agent.startSession(session.id, restored.messages)
          dispatch({ type: "reset", items: [] })
          dispatch({
            type: "push",
            item: {
              kind: "info",
              text: `Restored to checkpoint ${cpIndex} — turn ${target.turnIndex}, "${target.label}". Files and conversation rewound.`,
            },
          })
          break
        }
        default: {
          // Check if this is a dynamic plugin command
          if (busy) {
            dispatch({ type: "push", item: { kind: "info", text: "still working — Esc to interrupt" } })
            break
          }
          const cmdText = cmd.trim()
          const slashIndex = cmdText.indexOf(" ")
          const cmdName = (slashIndex === -1 ? cmdText.slice(1) : cmdText.slice(1, slashIndex)).toLowerCase()
          const cmdArgs = slashIndex === -1 ? "" : cmdText.slice(slashIndex + 1)
          const pluginCmd = agent.pluginCommands.find((c) => c.name === cmdName)
          if (pluginCmd) {
            const rendered = renderCommandPrompt(pluginCmd, cmdArgs)
            dispatch({ type: "push", item: { kind: "user", text: cmdText } })
            const controller = new AbortController()
            abortRef.current = controller
            void agent.send(rendered, controller.signal)
          }
          break
        }
      }
    },
    [agent, busy, catalog, modelRef, quit, session, store],
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
      const displayText =
        pendingImages.length > 0
          ? `${text}\n[images: ${pendingImages.map((img) => img.name).join(", ")}]`
          : text
      dispatch({ type: "push", item: { kind: "user", text: displayText } })
      const controller = new AbortController()
      abortRef.current = controller
      if (pendingImages.length > 0) {
        const images = pendingImages.map(({ base64, mimeType }) => ({ base64, mimeType }))
        setPendingImages([])
        void agent.send(text, controller.signal, images)
      } else {
        void agent.send(text, controller.signal)
      }
    },
    [agent, busy, pendingImages, runCommand, session.id, store],
  )

  const handlePromptInput = useCallback(
    (value: string) => {
      setPromptValue(value)
      setSelectedSuggestion(0)
      if (programmaticPromptValueRef.current === value) {
        programmaticPromptValueRef.current = null
        return
      }
      // A real keystroke ends history browsing and re-enables suggestions.
      historyIndexRef.current = null
      setDismissedCompletionValue(null)
      // Update @-mention query from new value + current caret offset
      const offset = caretRef.current.caretOffset
      const query = extractMentionQuery(value, offset)
      setMentionQuery(query)
      setSelectedMention(0)
      // Eagerly scan project files on first @ so the popup is instant
      if (query !== null && projectFiles.length === 0) {
        scanProjectFiles(session.cwd).then(setProjectFiles)
      }
    },
    [projectFiles.length, session.cwd],
  )

  // The textarea is uncontrolled, so read its text on every content change.
  const handleContentChange = useCallback(() => {
    const value = textareaRef.current?.plainText ?? ""
    setInputLines(textareaRef.current?.lineCount ?? 1)
    handlePromptInput(value)
  }, [handlePromptInput])

  const handleCursorChange = useCallback(
    (event: { line: number }) => {
      const area = textareaRef.current
      const caretOffset = area?.cursorOffset ?? 0
      caretRef.current = { line: event.line, lineCount: area?.lineCount ?? 1, caretOffset }
      // Recompute mention query on cursor move (user may have moved inside/outside @token)
      const value = area?.plainText ?? promptValue
      const query = extractMentionQuery(value, caretOffset)
      setMentionQuery(query)
      setSelectedMention(0)
    },
    [promptValue],
  )

  // Imperatively replace the input text (history recall, completion fill). Flags
  // the value as programmatic so suggestions/dismissal aren't reset spuriously.
  const setInputText = useCallback((value: string) => {
    programmaticPromptValueRef.current = value
    const area = textareaRef.current
    if (area) {
      area.setText(value)
      area.cursorOffset = value.length
    }
    setPromptValue(value)
    setInputLines(area?.lineCount ?? 1)
  }, [])

  const handleTextareaSubmit = useCallback(() => {
    const value = textareaRef.current?.plainText ?? promptValue
    textareaRef.current?.setText("")
    setInputLines(1)
    historyIndexRef.current = null
    if (value.trim()) {
      setHistory((prev) => (prev[prev.length - 1] === value ? prev : [...prev, value]))
    }
    submit(value)
  }, [promptValue, submit])

  const applyModel = useCallback(
    (ref: string, target: "edit" | "plan" = "edit") => {
      try {
        if (target === "plan") {
          agent.setPlanModel(ref)
          setPlanModelRef(ref)
          saveConfig({ planModel: ref })
          dispatch({ type: "push", item: { kind: "info", text: `plan model → ${ref}` } })
        } else {
          agent.setModel(ref)
          setModelRef(ref)
          dispatch({ type: "push", item: { kind: "info", text: `model → ${ref}` } })
        }
      } catch (err) {
        dispatch({
          type: "push",
          item: { kind: "error", text: err instanceof Error ? err.message : String(err) },
        })
      }
    },
    [agent],
  )

  const handleConnectRequest = useCallback((provider: ProviderOption) => {
    setPickerOpen(false)
    setConnect({ provider })
  }, [])

  const handleConnected = useCallback(
    (provider: ProviderOption) => {
      setConnect(null)
      setConnectEpoch((e) => e + 1)
      dispatch({ type: "push", item: { kind: "info", text: `connected ${provider.id}` } })
      setPickerProvider(provider.id)
      setPickerOpen(true)
      // Refresh live model list for this provider so the picker shows the actual accessible models
      withLiveModels(catalog, provider.id, config).then(() => setCatalogVersion((v) => v + 1))
    },
    [catalog, config],
  )

  const handleConnectCancel = useCallback(() => {
    setConnect(null)
  }, [])

  const handleMcpAdd = useCallback(
    async (name: string, cfg: McpServerConfig): Promise<void> => {
      const cur = loadConfig(agent.cwd)
      saveConfig({ mcpServers: { ...(cur.mcpServers ?? {}), [name]: cfg } })
      setSetupConfig(loadConfig(agent.cwd))
      await agent.initMcp({ [name]: cfg })
    },
    [agent],
  )

  const handleMcpRemove = useCallback(
    (name: string) => {
      const cur = loadConfig(agent.cwd)
      const { [name]: _removed, ...rest } = cur.mcpServers ?? {}
      saveConfig({ mcpServers: rest })
      setSetupConfig(loadConfig(agent.cwd))
    },
    [agent],
  )

  const handleToggleAlwaysLoad = useCallback(
    (name: string) => {
      const cur = loadConfig(agent.cwd)
      const existing = cur.skills?.alwaysLoad ?? []
      const alwaysLoad = existing.includes(name) ? existing.filter((n) => n !== name) : [...existing, name]
      saveConfig({ skills: { ...(cur.skills ?? {}), alwaysLoad } })
      setSetupConfig(loadConfig(agent.cwd))
    },
    [agent],
  )

  const handleTogglePlugin = useCallback(
    (name: string) => {
      const cur = loadConfig(agent.cwd)
      const enabled = cur.plugins?.enabled ?? []
      const next = enabled.includes(name) ? enabled.filter((n) => n !== name) : [...enabled, name]
      saveConfig({ plugins: { enabled: next } })
      setSetupConfig(loadConfig(agent.cwd))
    },
    [agent],
  )

  const handleInstallPlugin = useCallback(
    async (source: string): Promise<InstalledPlugin> => {
      const plugin = await addPlugin(source)
      setInstalledPlugins(listInstalledPlugins())
      handleTogglePlugin(plugin.name)
      return plugin
    },
    [handleTogglePlugin],
  )

  const handleRemovePlugin = useCallback(
    (name: string) => {
      removePlugin(name)
      const cur = loadConfig(agent.cwd)
      const enabled = cur.plugins?.enabled ?? []
      if (enabled.includes(name)) {
        saveConfig({ plugins: { enabled: enabled.filter((n) => n !== name) } })
      }
      setInstalledPlugins(listInstalledPlugins())
      setSetupConfig(loadConfig(agent.cwd))
    },
    [agent],
  )

  const pickModel = useCallback(
    (ref: string) => {
      setPickerOpen(false)
      const target = pickerTarget
      setPickerTarget("edit")
      const [providerId, modelId] = ref.split("/")
      const sizeBytes = providerId && modelId ? catalog[providerId]?.models?.[modelId]?.sizeBytes : undefined
      if (localModelFit(sizeBytes).status === "oversized") {
        setConfirmModel({ ref, sizeBytes, target })
        return
      }
      applyModel(ref, target)
    },
    [applyModel, catalog, pickerTarget],
  )

  const empty = items.length === 0 || items.every((i) => i.kind === "info" && i.silent)
  const focusInput =
    !pickerOpen &&
    !permission &&
    !confirmModel &&
    !connect &&
    !question &&
    !mcpSetupOpen &&
    !skillsSetupOpen &&
    !pluginSetupOpen
  const commandSuggestions = getSlashCommandSuggestions(promptValue)
  const completionOpen =
    focusInput && dismissedCompletionValue !== promptValue && commandSuggestions.length > 0
  const selectedSuggestionIndex =
    commandSuggestions.length > 0 ? Math.min(selectedSuggestion, commandSuggestions.length - 1) : 0
  const selectedCommand = commandSuggestions[selectedSuggestionIndex]
  const mentionSuggestions =
    focusInput && !completionOpen && mentionQuery !== null
      ? filterFileMentions(projectFiles, mentionQuery)
      : []
  const mentionOpen = mentionSuggestions.length > 0
  const selectedMentionIndex =
    mentionSuggestions.length > 0 ? Math.min(selectedMention, mentionSuggestions.length - 1) : 0
  const wideEnoughForUsageBox = footerMode(width) === "wide"
  const showUsageBox = wideEnoughForUsageBox && !empty
  // While in plan mode the dedicated plan model runs (if set); the footer reflects
  // whichever model will actually handle the next turn.
  const activeModelRef = permMode === "plan" && planModelRef ? planModelRef : modelRef
  const footer = statusFooterParts({
    busy,
    catalog,
    modelRef: activeModelRef,
    usage,
    width,
    permMode,
    showUsageBox,
  })
  const usageRows = showUsageBox ? usageBoxRows({ usage, context: agent.contextStats() }) : []
  const savingsRows = showUsageBox
    ? savingsBoxRows({ usage, context: agent.contextStats(), catalog, modelRef })
    : []
  // Auto-grow the input box with the draft (1 content line → height 3, incl. border).
  const inputBoxHeight = Math.min(INPUT_MAX_LINES, Math.max(1, inputLines)) + 2
  // How many command rows the suggestion box can show without crowding the bottom
  // chrome off-screen. The transcript (flexGrow) absorbs whatever's left, so we
  // only reserve for the chip, input box, footer line, the box's own border +
  // hint, and a safety row.
  const maxSuggestionRows = Math.max(1, Math.min(8, height - 1 - inputBoxHeight - 1 - 2 - 1 - 1))
  const inputHint = busy
    ? "Esc to stop"
    : completionOpen
      ? "↑↓ navigate · Tab complete · Enter run · Esc close"
      : mentionOpen
        ? "↑↓ navigate · Tab/Enter insert · Esc close"
        : "/ commands · @ file · ↑↓ history · Shift+Enter newline · Enter send"

  const fillSuggestion = useCallback(
    (command: SlashCommand) => {
      const value = `/${command.name}`
      setInputText(value)
      setSelectedSuggestion(0)
      setDismissedCompletionValue(value)
    },
    [setInputText],
  )

  const applyFileMention = useCallback(
    (filePath: string) => {
      const currentText = textareaRef.current?.plainText ?? promptValue
      const offset = caretRef.current.caretOffset
      const newText = applyMention(currentText, offset, filePath)
      const newOffset = mentionCaretOffset(currentText, offset, filePath)
      programmaticPromptValueRef.current = newText
      const area = textareaRef.current
      if (area) {
        area.setText(newText)
        area.cursorOffset = newOffset
      }
      setPromptValue(newText)
      setMentionQuery(null)
      setSelectedMention(0)
    },
    [promptValue],
  )

  const runSuggestion = useCallback(
    (command: SlashCommand) => {
      textareaRef.current?.setText("")
      setInputLines(1)
      setPromptValue("")
      setSelectedSuggestion(0)
      setDismissedCompletionValue(null)
      runCommand(`/${command.name}`)
    },
    [runCommand],
  )

  const applyPlanApproval = useCallback(
    (index: number) => {
      // index 0/1 approve the plan and leave plan mode; index 2/-1 keep planning.
      const approved = index === 0 || index === 1
      if (index === 0) setPermMode("acceptEdits")
      else if (index === 1) setPermMode("normal")
      // Model selection is bound to the permission mode, so leaving plan mode
      // already hands the next turn to the edit model. Surface that swap so the
      // dev knows execution won't run on their (often pricier) plan model.
      if (approved && planModelRef && planModelRef !== modelRef) {
        dispatch({
          type: "push",
          item: { kind: "info", text: `plan approved → editing with ${modelLabel(catalog, modelRef)}` },
        })
      }
    },
    [catalog, modelRef, planModelRef],
  )

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") quit()

    // Shift+Tab cycles mode (no overlays open)
    if ((key.name === "tab" && key.shift) || key.name === "backtab") {
      if (!permission && !confirmModel && !question && !pickerOpen && !connect) {
        key.preventDefault()
        key.stopPropagation()
        const next = cycleMode(permMode)
        gate.setMode(next)
        setPermMode(next)
        const label = next === "acceptEdits" ? "auto-edit" : next === "plan" ? "plan" : "normal"
        dispatch({ type: "push", item: { kind: "info", text: `→ ${label} mode` } })
        return
      }
    }

    if (permission) {
      if (key.name === "pageup" || (key.name === "up" && key.shift)) {
        key.preventDefault()
        key.stopPropagation()
        detailScrollRef.current?.scrollBy(-SCROLL_STEP)
        return
      }
      if (key.name === "pagedown" || (key.name === "down" && key.shift)) {
        key.preventDefault()
        key.stopPropagation()
        detailScrollRef.current?.scrollBy(SCROLL_STEP)
        return
      }
      if (key.name === "y") permission.resolve("allow")
      else if (key.name === "a") permission.resolve("always")
      else if (key.name === "n" || key.name === "escape") permission.resolve("deny")
      return
    }
    if (confirmModel) {
      if (key.name === "y") {
        const { ref, target } = confirmModel
        setConfirmModel(null)
        applyModel(ref, target)
      } else if (key.name === "n" || key.name === "escape") {
        setConfirmModel(null)
      }
      return
    }
    if (question) {
      const optCount = question.q.options.length
      if (key.name === "pageup" || (key.name === "up" && key.shift)) {
        key.preventDefault()
        key.stopPropagation()
        detailScrollRef.current?.scrollBy(-SCROLL_STEP)
        return
      }
      if (key.name === "pagedown" || (key.name === "down" && key.shift)) {
        key.preventDefault()
        key.stopPropagation()
        detailScrollRef.current?.scrollBy(SCROLL_STEP)
        return
      }
      if (key.name === "down") {
        key.preventDefault()
        key.stopPropagation()
        setQuestionSel((s) => (s + 1) % optCount)
        return
      }
      if (key.name === "up") {
        key.preventDefault()
        key.stopPropagation()
        setQuestionSel((s) => (s - 1 + optCount) % optCount)
        return
      }
      // Number quick-pick (1–9)
      const num = Number(key.name)
      if (!Number.isNaN(num) && num >= 1 && num <= optCount) {
        key.preventDefault()
        key.stopPropagation()
        const chosen = num - 1
        if (question.q.kind === "plan-approval") applyPlanApproval(chosen)
        question.resolve(chosen)
        return
      }
      if (isEnterKey(key.name)) {
        key.preventDefault()
        key.stopPropagation()
        if (question.q.kind === "plan-approval") applyPlanApproval(questionSel)
        question.resolve(questionSel)
        return
      }
      if (key.name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        question.resolve(-1)
        return
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
      if (key.name === "tab" && !key.shift) {
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
    if (mentionOpen) {
      if (key.name === "down") {
        key.preventDefault()
        key.stopPropagation()
        setSelectedMention((i) => (i + 1) % mentionSuggestions.length)
        return
      }
      if (key.name === "up") {
        key.preventDefault()
        key.stopPropagation()
        setSelectedMention((i) => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length)
        return
      }
      if (key.name === "tab" && !key.shift) {
        key.preventDefault()
        key.stopPropagation()
        const chosen = mentionSuggestions[selectedMentionIndex]
        if (chosen) applyFileMention(chosen)
        return
      }
      if (isEnterKey(key.name)) {
        key.preventDefault()
        key.stopPropagation()
        const chosen = mentionSuggestions[selectedMentionIndex]
        if (chosen) applyFileMention(chosen)
        return
      }
      if (key.name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        setMentionQuery(null)
        return
      }
    }
    // Prompt history recall. Only intercept Up/Down at the buffer edges so the
    // textarea keeps native cursor movement on interior lines of a draft.
    if (focusInput && !completionOpen && !mentionOpen && (key.name === "up" || key.name === "down")) {
      const { line, lineCount } = caretRef.current
      if (key.name === "up" && line === 0 && history.length > 0) {
        key.preventDefault()
        key.stopPropagation()
        if (historyIndexRef.current === null) {
          draftRef.current = promptValue
          historyIndexRef.current = history.length - 1
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1
        }
        const recalled = history[historyIndexRef.current] ?? ""
        setInputText(recalled)
        setDismissedCompletionValue(recalled)
        return
      }
      if (key.name === "down" && line >= lineCount - 1 && historyIndexRef.current !== null) {
        key.preventDefault()
        key.stopPropagation()
        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current += 1
          const recalled = history[historyIndexRef.current] ?? ""
          setInputText(recalled)
          setDismissedCompletionValue(recalled)
        } else {
          historyIndexRef.current = null
          setInputText(draftRef.current)
        }
        return
      }
    }
    if (key.name === "escape") {
      // Overlays own their own Esc; only handle abort here when nothing is open
      if (!pickerOpen && !connect && busy) abortRef.current?.abort()
    }
  })

  if (needsSetup) {
    return <Setup onDone={handleSetupDone} catalog={catalog} config={config} animate={props.animate} />
  }

  return (
    <box style={{ position: "relative", flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
      {empty ? (
        <box
          style={{
            flexGrow: 1,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <Logo animate={props.animate} />
          <WelcomeTips />
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

      {question ? (
        question.q.kind === "plan-approval" ? (
          <PlanReviewPanel pending={question} selectedIndex={questionSel} scrollRef={detailScrollRef} />
        ) : (
          <QuestionView pending={question} selectedIndex={questionSel} scrollRef={detailScrollRef} />
        )
      ) : null}
      {permission ? <PermissionView pending={permission} scrollRef={detailScrollRef} /> : null}
      {confirmModel ? (
        <ModelFitWarning modelRef={confirmModel.ref} sizeBytes={confirmModel.sizeBytes} />
      ) : null}
      {connect ? (
        <box
          style={{ border: true, borderColor: theme.accent, padding: 1, flexDirection: "column" }}
          title="connect a provider"
        >
          <ProviderConnect
            key={connectEpoch}
            config={config}
            provider={connect.provider}
            providers={SETUP_PROVIDERS.filter(
              (p) => !connectedProviders(catalog, config).some((c) => c.id === p.id),
            )}
            onConnected={handleConnected}
            onCancel={handleConnectCancel}
          />
        </box>
      ) : null}
      {pickerOpen ? (
        <ModelPicker
          key={catalogVersion}
          catalog={catalog}
          config={config}
          current={pickerTarget === "plan" ? (planModelRef ?? modelRef) : modelRef}
          width={width}
          initialProviderId={pickerProvider}
          onPick={pickModel}
          onConnect={handleConnectRequest}
          onClose={() => {
            setPickerOpen(false)
            setPickerProvider(undefined)
            setPickerTarget("edit")
          }}
        />
      ) : null}
      {mcpSetupOpen ? (
        <McpSetup
          servers={agent.resolveMcpServers()}
          connections={agent.mcpStatus()}
          onAdd={handleMcpAdd}
          onRemove={handleMcpRemove}
          onClose={() => setMcpSetupOpen(false)}
        />
      ) : null}
      {skillsSetupOpen ? (
        <SkillsSetup
          skills={agent.skills}
          alwaysLoad={setupConfig.skills?.alwaysLoad ?? []}
          loadedNames={new Set(agent.skillBuffer.loaded().map((s) => s.name))}
          onToggleAlwaysLoad={handleToggleAlwaysLoad}
          onClose={() => setSkillsSetupOpen(false)}
        />
      ) : null}
      {pluginSetupOpen ? (
        <PluginSetup
          plugins={installedPlugins}
          enabledNames={setupConfig.plugins?.enabled ?? []}
          onToggleEnabled={handleTogglePlugin}
          onInstall={handleInstallPlugin}
          onRemove={handleRemovePlugin}
          onClose={() => setPluginSetupOpen(false)}
        />
      ) : null}
      {completionOpen ? (
        <SlashCommandSuggestionsView
          suggestions={commandSuggestions}
          selectedIndex={selectedSuggestionIndex}
          maxRows={maxSuggestionRows}
        />
      ) : mentionOpen ? (
        <FileMentionSuggestionsView
          suggestions={mentionSuggestions}
          selectedIndex={selectedMentionIndex}
          maxRows={maxSuggestionRows}
        />
      ) : null}

      <ModeChipRow permMode={permMode} />

      <box
        style={{
          border: true,
          borderColor: focusInput ? modeColor(permMode) : theme.border,
          height: inputBoxHeight,
          flexShrink: 0,
        }}
      >
        <textarea
          ref={(node: TextareaRenderable | null) => {
            textareaRef.current = node
          }}
          focused={focusInput}
          placeholder={empty ? "Ask Dawn anything… (/help for commands)" : ""}
          placeholderColor={theme.dim}
          textColor={theme.text}
          focusedTextColor={theme.text}
          wrapMode="word"
          keyBindings={CHAT_INPUT_KEY_BINDINGS}
          onContentChange={handleContentChange}
          onCursorChange={handleCursorChange}
          onSubmit={handleTextareaSubmit}
          style={{ flexGrow: 1 }}
        />
      </box>

      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row", flexShrink: 0 }}>
        {footer.mode === "narrow" ? (
          <text fg={busy ? theme.accent : theme.dim}>{footer.left}</text>
        ) : (
          <>
            <box style={{ width: Math.max(18, Math.floor(width * 0.45)), flexShrink: 1 }}>
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

      {!busy ? (
        <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
          <box style={{ flexGrow: 1, overflow: "hidden" }}>
            <text fg={theme.dim}>{inputHint}</text>
          </box>
          {promptValue.length > 0 ? <text fg={theme.dim}>{`${promptValue.length} chars`}</text> : null}
        </box>
      ) : null}
    </box>
  )
}
