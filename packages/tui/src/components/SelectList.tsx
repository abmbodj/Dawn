import type { MouseEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { type ReactNode, useState } from "react"
import { theme } from "../theme"

// Shared scrollable list used by every picker overlay. One place implements
// keyboard navigation (↑↓/PgUp/PgDn/Enter) and mouse interaction: the wheel
// pans the viewport, hovering selects the row under the cursor, and a click
// activates it.

export interface SelectListItem {
  key: string
  /** false = inert row (section header); skipped by navigation. Default true. */
  selectable?: boolean
  render: (selected: boolean) => ReactNode
}

/** Clamp idx to a selectable item, searching forward then backward if needed. */
export function safeSelection(items: SelectListItem[], idx: number): number {
  if (items.length === 0) return 0
  const clamped = Math.max(0, Math.min(idx, items.length - 1))
  if (items[clamped]?.selectable !== false) return clamped
  for (let i = clamped + 1; i < items.length; i++) {
    if (items[i]?.selectable !== false) return i
  }
  for (let i = clamped - 1; i >= 0; i--) {
    if (items[i]?.selectable !== false) return i
  }
  return clamped
}

/** Next selectable index in direction (+1/-1), skipping inert rows. */
export function nextSelectable(items: SelectListItem[], from: number, dir: 1 | -1): number {
  let i = from + dir
  while (i >= 0 && i < items.length) {
    if (items[i]?.selectable !== false) return i
    i += dir
  }
  return from
}

/** Pan `top` only as far as needed to bring `idx` into a `height`-row viewport. */
export function followSelection(top: number, idx: number, height: number): number {
  if (idx < top) return idx
  if (idx >= top + height) return idx - height + 1
  return top
}

/** Default row renderer matching the OpenTUI <select> look, for mechanical migrations. */
export function optionItem(key: string, name: string, description?: string): SelectListItem {
  return {
    key,
    render: (selected) => (
      <box style={{ flexDirection: "row", backgroundColor: selected ? theme.statusBg : undefined }}>
        <text fg={selected ? theme.accent : theme.dim}>{selected ? "❯ " : "  "}</text>
        <text fg={theme.text}>{name}</text>
        {description ? <text fg={theme.dim}>{`  ${description}`}</text> : null}
      </box>
    ),
  }
}

export interface SelectListProps {
  items: SelectListItem[]
  /** Viewport height in rows. */
  height: number
  /** Controlled selection — the parent owns it. */
  selectedIndex: number
  onSelectIndex: (i: number) => void
  /** Enter or mouse click on a selectable row. */
  onActivate: (i: number) => void
  /** Set false when the parent owns arrow/enter keys (default true). */
  keyboard?: boolean
}

export function SelectList({
  items,
  height,
  selectedIndex,
  onSelectIndex,
  onActivate,
  keyboard = true,
}: SelectListProps) {
  // Center the initial selection (e.g. the current model) in the viewport.
  const [scrollTop, setScrollTop] = useState(() => Math.max(0, selectedIndex - Math.floor(height / 2)))
  const [prevSelected, setPrevSelected] = useState(selectedIndex)

  const maxTop = Math.max(0, items.length - height)
  let top = Math.max(0, Math.min(scrollTop, maxTop))

  // Follow a *changed* selection (keyboard nav, search reset). Wheel panning
  // never moves the selection, so it can scroll the selection off-screen.
  if (selectedIndex !== prevSelected) {
    top = followSelection(top, selectedIndex, height)
    setPrevSelected(selectedIndex)
    if (top !== scrollTop) setScrollTop(top)
  }

  const move = (dir: 1 | -1, steps = 1) => {
    let next = selectedIndex
    for (let i = 0; i < steps; i++) next = nextSelectable(items, next, dir)
    if (next !== selectedIndex) onSelectIndex(next)
  }

  useKeyboard((key) => {
    if (!keyboard) return
    if (key.name === "up") move(-1)
    else if (key.name === "down") move(1)
    else if (key.name === "pageup") move(-1, height)
    else if (key.name === "pagedown") move(1, height)
    else if (key.name === "return") {
      const i = safeSelection(items, selectedIndex)
      if (items[i]?.selectable !== false) onActivate(i)
    }
  })

  const handleScroll = (event: MouseEvent) => {
    const delta = event.scroll?.delta ?? 1
    const direction = event.scroll?.direction
    if (direction === "up") setScrollTop(Math.max(0, top - delta))
    else if (direction === "down") setScrollTop(Math.min(maxTop, top + delta))
    event.stopPropagation()
  }

  return (
    <box style={{ flexDirection: "column", height }} onMouseScroll={handleScroll}>
      {items.slice(top, top + height).map((item, i) => {
        const idx = top + i
        const hover = (event: MouseEvent) => {
          event.stopPropagation()
          if (item.selectable === false || idx === selectedIndex) return
          onSelectIndex(idx)
        }
        return (
          // Terminal list row: mouse hover selects; keyboard nav is handled by the parent list.
          // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI box, not a DOM element
          // biome-ignore lint/a11y/useKeyWithMouseEvents: keyboard handled by parent SelectList
          <box
            key={item.key}
            onMouseOver={hover}
            onMouseMove={hover}
            onMouseDown={(event: MouseEvent) => {
              event.stopPropagation()
              if (item.selectable === false) return
              onSelectIndex(idx)
              onActivate(idx)
            }}
          >
            {item.render(idx === selectedIndex)}
          </box>
        )
      })}
    </box>
  )
}
