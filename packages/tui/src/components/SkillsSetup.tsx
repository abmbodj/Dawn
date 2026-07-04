import os from "node:os"
import path from "node:path"
import type { Skill } from "@dawn/core"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import { theme } from "../theme"
import { optionItem, SelectList } from "./SelectList"

export interface SkillsSetupProps {
  skills: Skill[]
  alwaysLoad: string[]
  loadedNames: Set<string>
  onToggleAlwaysLoad: (name: string) => void
  onClose: () => void
}

function sourceBadge(source: Skill["source"]): { label: string; fg: string } {
  switch (source) {
    case "project":
      return { label: "proj", fg: theme.accent }
    case "personal":
      return { label: "pers", fg: theme.dim }
    case "plugin":
      return { label: "plug", fg: "#7FB4D9" }
    case "claude":
      return { label: "cc", fg: "#6A6060" }
  }
}

export function SkillsSetup({
  skills,
  alwaysLoad,
  loadedNames,
  onToggleAlwaysLoad,
  onClose,
}: SkillsSetupProps) {
  const [idx, setIdx] = useState(0)
  const safeIdx = skills.length === 0 ? 0 : Math.min(idx, skills.length - 1)
  const selected = skills[safeIdx]

  useKeyboard((key) => {
    if (skills.length === 0) {
      if (key.name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        onClose()
      }
      return
    }
    if (key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      onClose()
      return
    }
    // Arrows and Enter are handled by SelectList; space toggles here.
    if (key.name === "space" || key.name === " ") {
      if (selected) {
        key.preventDefault()
        key.stopPropagation()
        onToggleAlwaysLoad(selected.name)
      }
      return
    }
  })

  if (skills.length === 0) {
    const homeDir = os.homedir()
    const personalPath = path.join(homeDir, ".config", "dawn", "skills", "<name>", "SKILL.md")
    return (
      <box
        style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 12 }}
        title="skills"
      >
        <box style={{ flexGrow: 1, padding: 1, flexDirection: "column", justifyContent: "center" }}>
          <text fg={theme.dim}>{"No skills found."}</text>
          <text fg={theme.dim} style={{ marginTop: 1 }}>
            {"Create skills at:"}
          </text>
          <text fg={theme.text} style={{ marginTop: 1 }}>
            {"  .dawn/skills/<name>/SKILL.md"}
          </text>
          <text fg={theme.text}>{`  ${personalPath}`}</text>
        </box>
        <text fg={theme.dim} style={{ paddingLeft: 1 }}>
          {"esc close"}
        </text>
      </box>
    )
  }

  const listOptions = skills.map((s) => {
    const pinned = alwaysLoad.includes(s.name)
    const badge = sourceBadge(s.source)
    const loaded = loadedNames.has(s.name)
    return {
      name: `${pinned ? "[●]" : "[ ]"} ${s.name}${loaded ? " [loaded]" : ""}`,
      value: s.name,
      description: badge.label,
    }
  })

  return (
    <box
      style={{ border: true, borderColor: theme.accent, flexDirection: "column", height: 18 }}
      title="skills · space=toggle always-load · ↑↓ navigate · esc close"
    >
      <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
        <SelectList
          items={listOptions.map((o) => optionItem(o.value, o.name, o.description))}
          height={10}
          selectedIndex={safeIdx}
          onSelectIndex={setIdx}
          onActivate={(i) => {
            const skill = skills[i]
            if (skill) onToggleAlwaysLoad(skill.name)
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
          <box style={{ flexDirection: "row", marginTop: 1 }}>
            <text fg={sourceBadge(selected.source).fg}>{`[${sourceBadge(selected.source).label}] `}</text>
            <text fg={theme.text}>{selected.name}</text>
            {alwaysLoad.includes(selected.name) ? <text fg={theme.accent}>{" ● always-load"}</text> : null}
            {loadedNames.has(selected.name) ? <text fg={theme.toolOk}>{" [loaded]"}</text> : null}
          </box>
          <text fg={theme.dim}>{selected.description}</text>
          <text fg={theme.dim}>{selected.dir}</text>
        </box>
      ) : null}
      <text fg={theme.dim} style={{ paddingLeft: 1, flexShrink: 0 }}>
        {"↑↓ navigate  space/enter toggle always-load  esc close"}
      </text>
    </box>
  )
}
