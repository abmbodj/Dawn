import type { McpServerConfig } from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useState } from "react"
import { theme } from "../theme"

export interface McpSetupProps {
  servers: Record<string, McpServerConfig>
  connections: Array<{ name: string; toolCount: number; error?: string }>
  onAdd: (name: string, cfg: McpServerConfig) => Promise<void>
  onRemove: (name: string) => void
  onClose: () => void
}

type Phase =
  | "list"
  | "add-name"
  | "add-type"
  | "add-command"
  | "add-env"
  | "add-url"
  | "add-headers"
  | "connecting"

type ServerType = "stdio" | "http" | "sse"
const SERVER_TYPES: ServerType[] = ["stdio", "http", "sse"]

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

function shellSplit(raw: string): [string, string[]] {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  const cmd = parts[0] ?? ""
  return [cmd, parts.slice(1)]
}

function statusIcon(
  name: string,
  connections: McpSetupProps["connections"],
): { icon: string; fg: string; info: string } {
  const conn = connections.find((c) => c.name === name)
  if (!conn) return { icon: "○", fg: theme.dim, info: "not connected" }
  if (conn.error) return { icon: "✗", fg: theme.toolErr, info: conn.error.slice(0, 50) }
  return { icon: "●", fg: theme.toolOk, info: `${conn.toolCount} tool${conn.toolCount === 1 ? "" : "s"}` }
}

function serverTypeLabel(cfg: McpServerConfig): string {
  if ("url" in cfg) return cfg.type ?? "http"
  return "stdio"
}

export function McpSetup({ servers, connections, onAdd, onRemove, onClose }: McpSetupProps) {
  const [phase, setPhase] = useState<Phase>("list")
  const [listIdx, setListIdx] = useState(0)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [typeIdx, setTypeIdx] = useState(0)
  const [draft, setDraft] = useState({
    name: "",
    type: "stdio" as ServerType,
    command: "",
    env: "",
    url: "",
    headers: "",
  })

  const spinner = useSpinner(phase === "connecting")
  const serverNames = Object.keys(servers)
  const safeListIdx = serverNames.length === 0 ? 0 : Math.min(listIdx, serverNames.length - 1)
  const selectedName = serverNames[safeListIdx]

  function resetDraft() {
    setDraft({ name: "", type: "stdio", command: "", env: "", url: "", headers: "" })
    setTypeIdx(0)
    setConnectError(null)
  }

  useKeyboard((key) => {
    const esc = key.name === "escape"

    if (phase === "connecting") return

    if (phase === "add-type") {
      if (key.name === "up") {
        key.preventDefault()
        key.stopPropagation()
        setTypeIdx((i) => (i - 1 + SERVER_TYPES.length) % SERVER_TYPES.length)
        return
      }
      if (key.name === "down") {
        key.preventDefault()
        key.stopPropagation()
        setTypeIdx((i) => (i + 1) % SERVER_TYPES.length)
        return
      }
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault()
        key.stopPropagation()
        const chosen = SERVER_TYPES[typeIdx] ?? "stdio"
        setDraft((d) => ({ ...d, type: chosen }))
        setPhase(chosen === "stdio" ? "add-command" : "add-url")
        return
      }
      if (esc) {
        key.preventDefault()
        key.stopPropagation()
        setPhase("add-name")
        return
      }
      return
    }

    if (phase === "list") {
      if (esc) {
        key.preventDefault()
        key.stopPropagation()
        onClose()
        return
      }
      if (key.name === "a") {
        key.preventDefault()
        key.stopPropagation()
        resetDraft()
        setPhase("add-name")
        return
      }
      if (key.name === "d" && selectedName) {
        key.preventDefault()
        key.stopPropagation()
        onRemove(selectedName)
        setListIdx((i) => Math.max(0, i - 1))
        return
      }
      if (key.name === "up") {
        key.preventDefault()
        key.stopPropagation()
        setListIdx((i) => Math.max(0, i - 1))
        return
      }
      if (key.name === "down") {
        key.preventDefault()
        key.stopPropagation()
        setListIdx((i) => Math.min(serverNames.length - 1, i + 1))
        return
      }
      return
    }

    if (esc) {
      key.preventDefault()
      key.stopPropagation()
      switch (phase) {
        case "add-name":
          resetDraft()
          setPhase("list")
          break
        case "add-command":
          setPhase("add-type")
          break
        case "add-env":
          setPhase("add-command")
          break
        case "add-url":
          setPhase("add-type")
          break
        case "add-headers":
          setPhase("add-url")
          break
      }
    }
  })

  function handleConfirmStdio() {
    const [command, args] = shellSplit(draft.command)
    if (!command) return
    const envEntries = draft.env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split("=", 2) as [string, string])
    const envObj = envEntries.length > 0 ? Object.fromEntries(envEntries) : undefined
    const cfg: McpServerConfig = {
      command,
      args: args.length > 0 ? args : undefined,
      ...(envObj ? { env: envObj } : {}),
    }
    setPhase("connecting")
    onAdd(draft.name, cfg)
      .then(() => {
        setConnectError(null)
        resetDraft()
        setPhase("list")
      })
      .catch((err: unknown) => {
        setConnectError(err instanceof Error ? err.message : String(err))
        resetDraft()
        setPhase("list")
      })
  }

  function handleConfirmHttp() {
    if (!draft.url) return
    const headerEntries = draft.headers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf(":")
        return i > 0 ? ([s.slice(0, i).trim(), s.slice(i + 1).trim()] as [string, string]) : null
      })
      .filter(Boolean) as [string, string][]
    const headersObj = headerEntries.length > 0 ? Object.fromEntries(headerEntries) : undefined
    const cfg: McpServerConfig = {
      type: draft.type as "http" | "sse",
      url: draft.url,
      ...(headersObj ? { headers: headersObj } : {}),
    }
    setPhase("connecting")
    onAdd(draft.name, cfg)
      .then(() => {
        setConnectError(null)
        resetDraft()
        setPhase("list")
      })
      .catch((err: unknown) => {
        setConnectError(err instanceof Error ? err.message : String(err))
        resetDraft()
        setPhase("list")
      })
  }

  if (phase === "connecting") {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 8 }}
        title="mcp"
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column", justifyContent: "center" }}>
          <text fg={theme.accent}>{`${spinner} Connecting to ${draft.name}…`}</text>
        </box>
      </box>
    )
  }

  if (phase === "add-name") {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 8 }}
        title="add mcp server — step 1: name · esc=back"
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column" }}>
          <text fg={theme.dim} style={{ marginBottom: 1 }}>
            {"Server name (no spaces):"}
          </text>
          <box style={{ height: 1 }}>
            <input
              focused
              value={draft.name}
              placeholder="my-server"
              onInput={(val: unknown) => {
                const v = typeof val === "string" ? val : String((val as { value?: string })?.value ?? "")
                setDraft((d) => ({ ...d, name: v.replace(/\s/g, "-") }))
              }}
              onSubmit={(val: unknown) => {
                const v = (typeof val === "string" ? val : String((val as { value?: string })?.value ?? ""))
                  .replace(/\s/g, "-")
                  .trim()
                if (!v) return
                setDraft((d) => ({ ...d, name: v }))
                setPhase("add-type")
              }}
            />
          </box>
        </box>
        <text fg={theme.dim} style={{ paddingLeft: 1 }}>
          {"enter=next  esc=back"}
        </text>
      </box>
    )
  }

  if (phase === "add-type") {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 10 }}
        title={`add mcp server "${draft.name}" — step 2: type · esc=back`}
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column" }}>
          <text fg={theme.dim} style={{ marginBottom: 1 }}>
            {"Server type:"}
          </text>
          {SERVER_TYPES.map((t, i) => (
            <box key={t} style={{ flexDirection: "row" }}>
              <text fg={i === typeIdx ? theme.accent : theme.dim}>{i === typeIdx ? `▶ ${t}` : `  ${t}`}</text>
              {t === "stdio" ? <text fg={theme.dim}>{" — command-line process"}</text> : null}
              {t === "http" ? <text fg={theme.dim}>{" — Streamable HTTP"}</text> : null}
              {t === "sse" ? <text fg={theme.dim}>{" — SSE transport"}</text> : null}
            </box>
          ))}
        </box>
        <text fg={theme.dim} style={{ paddingLeft: 1 }}>
          {"↑↓ select  enter=next  esc=back"}
        </text>
      </box>
    )
  }

  if (phase === "add-command") {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 9 }}
        title={`add mcp server "${draft.name}" — stdio command · esc=back`}
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column" }}>
          <text fg={theme.dim} style={{ marginBottom: 1 }}>
            {"Full command line (npx -y @mcp/server .):"}
          </text>
          <box style={{ height: 1 }}>
            <input
              focused
              value={draft.command}
              placeholder="npx -y @modelcontextprotocol/server-filesystem ."
              onInput={(val: unknown) => {
                const v = typeof val === "string" ? val : String((val as { value?: string })?.value ?? "")
                setDraft((d) => ({ ...d, command: v }))
              }}
              onSubmit={(val: unknown) => {
                const v = (
                  typeof val === "string" ? val : String((val as { value?: string })?.value ?? "")
                ).trim()
                if (!v) return
                setDraft((d) => ({ ...d, command: v }))
                setPhase("add-env")
              }}
            />
          </box>
          <text fg={theme.dim} style={{ marginTop: 1 }}>
            {"Parsed as: command + space-separated args"}
          </text>
        </box>
        <text fg={theme.dim} style={{ paddingLeft: 1 }}>
          {"enter=next  esc=back"}
        </text>
      </box>
    )
  }

  if (phase === "add-env") {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 9 }}
        title={`add mcp server "${draft.name}" — env vars (optional) · esc=back`}
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column" }}>
          <text fg={theme.dim} style={{ marginBottom: 1 }}>
            {"Environment variables (leave blank to skip):"}
          </text>
          <box style={{ height: 1 }}>
            <input
              focused
              value={draft.env}
              placeholder="KEY=value, KEY2=value2"
              onInput={(val: unknown) => {
                const v = typeof val === "string" ? val : String((val as { value?: string })?.value ?? "")
                setDraft((d) => ({ ...d, env: v }))
              }}
              onSubmit={() => {
                handleConfirmStdio()
              }}
            />
          </box>
          <text fg={theme.dim} style={{ marginTop: 1 }}>
            {"Comma-separated KEY=value pairs, or blank to skip"}
          </text>
        </box>
        <text fg={theme.dim} style={{ paddingLeft: 1 }}>
          {"enter=connect  esc=back"}
        </text>
      </box>
    )
  }

  if (phase === "add-url") {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 9 }}
        title={`add mcp server "${draft.name}" — ${draft.type} url · esc=back`}
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column" }}>
          <text fg={theme.dim} style={{ marginBottom: 1 }}>
            {"Server URL:"}
          </text>
          <box style={{ height: 1 }}>
            <input
              focused
              value={draft.url}
              placeholder="https://my-mcp-server.example.com/mcp"
              onInput={(val: unknown) => {
                const v = typeof val === "string" ? val : String((val as { value?: string })?.value ?? "")
                setDraft((d) => ({ ...d, url: v }))
              }}
              onSubmit={(val: unknown) => {
                const v = (
                  typeof val === "string" ? val : String((val as { value?: string })?.value ?? "")
                ).trim()
                if (!v) return
                setDraft((d) => ({ ...d, url: v }))
                setPhase("add-headers")
              }}
            />
          </box>
        </box>
        <text fg={theme.dim} style={{ paddingLeft: 1 }}>
          {"enter=next  esc=back"}
        </text>
      </box>
    )
  }

  if (phase === "add-headers") {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 9 }}
        title={`add mcp server "${draft.name}" — headers (optional) · esc=back`}
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column" }}>
          <text fg={theme.dim} style={{ marginBottom: 1 }}>
            {"HTTP headers (leave blank to skip):"}
          </text>
          <box style={{ height: 1 }}>
            <input
              focused
              value={draft.headers}
              placeholder="Authorization: Bearer token, X-Api-Key: key"
              onInput={(val: unknown) => {
                const v = typeof val === "string" ? val : String((val as { value?: string })?.value ?? "")
                setDraft((d) => ({ ...d, headers: v }))
              }}
              onSubmit={() => {
                handleConfirmHttp()
              }}
            />
          </box>
          <text fg={theme.dim} style={{ marginTop: 1 }}>
            {'Comma-separated "Name: value" pairs, or blank to skip'}
          </text>
        </box>
        <text fg={theme.dim} style={{ paddingLeft: 1 }}>
          {"enter=connect  esc=back"}
        </text>
      </box>
    )
  }

  // list phase
  if (serverNames.length === 0) {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 10 }}
        title="mcp servers"
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column", justifyContent: "center" }}>
          <text fg={theme.dim}>{"No MCP servers configured."}</text>
          <text fg={theme.dim} style={{ marginTop: 1 }}>
            {"Press a to add one, or add mcpServers to dawn.json or .mcp.json."}
          </text>
          {connectError ? <text fg={theme.error} style={{ marginTop: 1 }}>{`✗ ${connectError}`}</text> : null}
        </box>
        <text fg={theme.dim} style={{ paddingLeft: 1 }}>
          {"a add  esc close"}
        </text>
      </box>
    )
  }

  const listOptions = serverNames.map((name) => {
    const cfg = servers[name]
    if (!cfg) return { name, value: name, description: "" }
    const { icon, fg: _fg, info } = statusIcon(name, connections)
    const typeLabel = serverTypeLabel(cfg)
    return {
      name: `${icon} ${name}`,
      value: name,
      description: `[${typeLabel}] ${info}`,
    }
  })

  return (
    <box
      style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 16 }}
      title="mcp servers · a add · d delete · ↑↓ navigate · esc close"
    >
      {connectError ? (
        <text fg={theme.error} style={{ paddingLeft: 1, flexShrink: 0 }}>{`✗ ${connectError}`}</text>
      ) : null}
      <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
        <select
          focused
          showScrollIndicator
          options={listOptions}
          selectedIndex={safeListIdx}
          onChange={(i: number) => setListIdx(i)}
          style={{ flexGrow: 1 }}
        />
      </box>
      {selectedName ? (
        <box
          style={{
            height: 3,
            flexShrink: 0,
            flexDirection: "column",
            padding: 1,
            paddingTop: 0,
          }}
        >
          {(() => {
            const cfg = servers[selectedName]
            if (!cfg) return null
            if ("url" in cfg) {
              return <text fg={theme.dim}>{`url: ${cfg.url}`}</text>
            }
            return (
              <text fg={theme.dim}>{`cmd: ${cfg.command}${cfg.args ? ` ${cfg.args.join(" ")}` : ""}`}</text>
            )
          })()}
        </box>
      ) : null}
      <text fg={theme.dim} style={{ paddingLeft: 1, flexShrink: 0 }}>
        {"↑↓ navigate  a add  d delete  esc close"}
      </text>
    </box>
  )
}
