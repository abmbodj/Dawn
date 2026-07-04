import type { InstalledPlugin } from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { theme } from "../theme"
import { optionItem, SelectList } from "./SelectList"

export interface PluginSetupProps {
  plugins: InstalledPlugin[]
  enabledNames: string[]
  onToggleEnabled: (name: string) => void
  onInstall: (source: string) => Promise<InstalledPlugin>
  onRemove: (name: string) => void
  onClose: () => void
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

type Phase = "list" | "add" | "installing"

export function PluginSetup({
  plugins,
  enabledNames,
  onToggleEnabled,
  onInstall,
  onRemove,
  onClose,
}: PluginSetupProps) {
  const [phase, setPhase] = useState<Phase>("list")
  const [idx, setIdx] = useState(0)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installSource, setInstallSource] = useState("")
  const abortRef = useRef<AbortController | null>(null)
  const spinner = useSpinner(phase === "installing")

  const safeIdx = plugins.length === 0 ? 0 : Math.min(idx, plugins.length - 1)
  const selected = plugins[safeIdx]

  useKeyboard((key) => {
    if (phase === "installing") {
      if (key.name === "escape") {
        abortRef.current?.abort()
        setPhase("add")
      }
      return
    }
    if (phase === "add") {
      if (key.name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        setPhase("list")
        setInstallError(null)
        setInstallSource("")
      }
      return
    }
    // list phase
    if (key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      onClose()
      return
    }
    if (key.name === "a") {
      key.preventDefault()
      key.stopPropagation()
      setPhase("add")
      setInstallError(null)
      setInstallSource("")
      return
    }
    if (key.name === "d" && selected) {
      key.preventDefault()
      key.stopPropagation()
      onRemove(selected.name)
      setIdx((i) => Math.max(0, i - 1))
      return
    }
    // Arrows and Enter are handled by SelectList; space toggles here.
    if ((key.name === "space" || key.name === " ") && selected) {
      key.preventDefault()
      key.stopPropagation()
      onToggleEnabled(selected.name)
      return
    }
  })

  if (phase === "installing") {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 8 }}
        title="installing plugin"
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column", justifyContent: "center" }}>
          <text fg={theme.accent}>{`${spinner} Installing ${installSource}…`}</text>
          <text fg={theme.dim} style={{ marginTop: 1 }}>
            {"esc to cancel"}
          </text>
        </box>
      </box>
    )
  }

  if (phase === "add") {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 8 }}
        title="install plugin · enter=install · esc=cancel"
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column" }}>
          <box style={{ height: 1 }}>
            <input
              focused
              value={installSource}
              placeholder="git URL or /local/path…"
              onInput={(val: unknown) => {
                const v = typeof val === "string" ? val : String((val as { value?: string })?.value ?? "")
                setInstallSource(v)
              }}
              onSubmit={(val: unknown) => {
                const src = (
                  typeof val === "string" ? val : String((val as { value?: string })?.value ?? "")
                ).trim()
                if (!src) return
                setInstallSource(src)
                setInstallError(null)
                setPhase("installing")
                const ctrl = new AbortController()
                abortRef.current = ctrl
                onInstall(src)
                  .then((plugin) => {
                    setInstallSource("")
                    setPhase("list")
                    const newIdx = plugins.findIndex((p) => p.name === plugin.name)
                    if (newIdx >= 0) setIdx(newIdx)
                  })
                  .catch((err: unknown) => {
                    setInstallError(err instanceof Error ? err.message : String(err))
                    setPhase("add")
                  })
              }}
            />
          </box>
          <text fg={theme.dim} style={{ marginTop: 1 }}>
            {"git URL  or  /absolute/local/path"}
          </text>
          {installError ? (
            <text fg={theme.error} style={{ marginTop: 1 }}>
              {`✗ ${installError}`}
            </text>
          ) : null}
        </box>
      </box>
    )
  }

  // list phase
  if (plugins.length === 0) {
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 10 }}
        title="plugins"
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column", justifyContent: "center" }}>
          <text fg={theme.dim}>{"No plugins installed."}</text>
          <text fg={theme.dim} style={{ marginTop: 1 }}>
            {"Press a to install from a git URL or local path."}
          </text>
        </box>
        <text fg={theme.dim} style={{ paddingLeft: 1 }}>
          {"a install  esc close"}
        </text>
      </box>
    )
  }

  const listOptions = plugins.map((p) => {
    const enabled = enabledNames.includes(p.name)
    const ver = p.manifest.version ? ` v${p.manifest.version}` : ""
    return {
      name: `${enabled ? "[✓]" : "[ ]"} ${p.name}${ver}`,
      value: p.name,
      description: p.manifest.description ?? "",
    }
  })

  return (
    <box
      style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 18 }}
      title="plugins · space=toggle enabled · a install · d remove · esc close"
    >
      <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
        <SelectList
          items={listOptions.map((o) => optionItem(o.value, o.name, o.description))}
          height={10}
          selectedIndex={safeIdx}
          onSelectIndex={setIdx}
          onActivate={(i) => {
            const plugin = plugins[i]
            if (plugin) onToggleEnabled(plugin.name)
          }}
        />
      </box>
      {selected ? (
        <box
          style={{
            height: 5,
            flexShrink: 0,
            flexDirection: "column",
            padding: 1,
            paddingTop: 0,
          }}
        >
          <box style={{ flexDirection: "row" }}>
            <text fg={enabledNames.includes(selected.name) ? theme.toolOk : theme.dim}>
              {enabledNames.includes(selected.name) ? "● enabled  " : "○ disabled  "}
            </text>
            <text
              fg={theme.dim}
            >{`${selected.commands.length} commands  ${selected.skills.length} skills  ${Object.keys(selected.mcpServers).length} mcp`}</text>
          </box>
          <text fg={theme.dim} style={{ marginTop: 1 }}>
            {selected.dir}
          </text>
        </box>
      ) : null}
      <text fg={theme.dim} style={{ paddingLeft: 1, flexShrink: 0 }}>
        {"↑↓ navigate  space/enter toggle  a install  d remove  esc close"}
      </text>
    </box>
  )
}
