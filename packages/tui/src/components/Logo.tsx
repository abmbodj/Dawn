import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { LOGO_FPS, RISE_DURATION_MS, sunFrame, TAGLINE, wordmarkRows } from "../logo"
import { theme } from "../theme"

/**
 * The animated Dawn splash: a half-sun rising over the horizon, then pulsing.
 * With `animate` off (non-TTY / reduced motion) it renders one static frame.
 */
export function Logo({ animate }: { animate: boolean }) {
  const { width } = useTerminalDimensions()
  const [, setTick] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    if (!animate) return
    const interval = setInterval(() => setTick((t) => t + 1), 1000 / LOGO_FPS)
    return () => clearInterval(interval)
  }, [animate])

  const elapsedMs = Date.now() - startRef.current
  const rise = animate ? Math.min(1, elapsedMs / RISE_DURATION_MS) : 1
  const time = animate ? elapsedMs / 1000 : 0.3
  const rows = sunFrame({ cols: Math.max(24, width - 4), time, rise })
  const titleRows = wordmarkRows(Math.max(1, width - 4))

  return (
    <box style={{ flexDirection: "column", alignItems: "center" }}>
      {rows.map((runs, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional by nature
        <text key={i}>
          {runs.map((run, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional by nature
            <span key={j} fg={run.color}>
              {run.text}
            </span>
          ))}
        </text>
      ))}
      <box style={{ marginTop: 1, flexDirection: "column", alignItems: "center" }}>
        {titleRows.map((runs, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: title rows are positional by nature
          <text key={i}>
            {runs.map((run, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional by nature
              <span key={j} fg={run.color}>
                <strong>{run.text}</strong>
              </span>
            ))}
          </text>
        ))}
        <text fg={theme.dim} style={{ marginTop: 1 }}>
          {TAGLINE}
        </text>
      </box>
    </box>
  )
}
