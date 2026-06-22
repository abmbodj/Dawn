/**
 * Procedural "rising half-sun" logo. Pure functions — no React, no timers —
 * so frames are unit-testable and the animation is just `sunFrame(w, t, rise)`
 * called on a timer.
 *
 * Visual recipe (from the three reference images):
 *  - dense character-ramp disc with a warm radial gradient (orange orb)
 *  - directional ray spokes above the horizon that breathe with the pulse
 *  - sparse twinkling specks beyond the rim (dotted halo)
 *  - everything below the horizon line is clipped: the sun is rising
 */

export interface Run {
  text: string
  color: string
}

// light → dense
const RAMP = ["·", ":", ";", "+", "%", "#", "@"] as const

const GRADIENT: Array<[number, string]> = [
  [0.0, "#FFF3C4"],
  [0.45, "#FFC36B"],
  [0.75, "#FF8C42"],
  [1.0, "#E8501A"],
]

/** Terminal cells are ~twice as tall as wide; scale x distances down. */
const ASPECT = 0.48
const DISC_RADIUS = 7
const RAY_REACH = 9
const ROWS_ABOVE_HORIZON = 11
const SETTLED_PEEK_ROWS = 1.4

function lerpColor(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16)
  const pb = Number.parseInt(b.slice(1), 16)
  const mix = (sa: number, sb: number) => Math.round(sa + (sb - sa) * t)
  const r = mix((pa >> 16) & 0xff, (pb >> 16) & 0xff)
  const g = mix((pa >> 8) & 0xff, (pb >> 8) & 0xff)
  const bl = mix(pa & 0xff, pb & 0xff)
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0")}`
}

function gradientAt(t: number): string {
  const clamped = Math.min(1, Math.max(0, t))
  let previous: [number, string] = GRADIENT[0] ?? [0, "#FFF3C4"]
  for (const current of GRADIENT.slice(1)) {
    const [stop, color] = current
    if (clamped <= stop) {
      const [prevStop, prevColor] = previous
      const span = stop - prevStop || 1
      return lerpColor(prevColor, color, (clamped - prevStop) / span)
    }
    previous = current
  }
  return previous[1]
}

function rampChar(intensity: number): string {
  const idx = Math.min(RAMP.length - 1, Math.max(0, Math.floor(intensity * RAMP.length)))
  return RAMP[idx] ?? "@"
}

/** Deterministic 0..1 hash so the halo twinkles instead of flickering randomly. */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff
}

function rayChar(angle: number): string {
  // angle in radians measured from positive x axis, pointing up = π/2
  const deg = ((angle * 180) / Math.PI + 360) % 180
  if (deg >= 67.5 && deg < 112.5) return "|"
  if (deg >= 22.5 && deg < 67.5) return "/"
  if (deg >= 112.5 && deg < 157.5) return "\\"
  return "─"
}

export interface SunFrameOptions {
  /** Terminal columns available */
  cols: number
  /** Seconds since the animation started */
  time: number
  /** 0 → fully below horizon, 1 → settled above the horizon (default 1) */
  rise?: number
}

/**
 * Render one frame as rows of color runs. The last row is the horizon line;
 * all rows above it are sky (rays + halo) or sun disc.
 */
export function sunFrame({ cols, time, rise = 1 }: SunFrameOptions): Run[][] {
  const width = Math.max(24, Math.min(cols, 72))
  const cx = (width - 1) / 2
  const horizonY = ROWS_ABOVE_HORIZON
  const pulse = Math.sin((time * 2 * Math.PI) / 2.4)
  const radius = DISC_RADIUS * (1 + 0.05 * pulse)
  const clampedRise = Math.min(1, Math.max(0, rise))
  // the sun climbs from below the horizon as `rise` goes 0 → 1
  const cy = horizonY + (1 - clampedRise) * (radius + 1) - clampedRise * SETTLED_PEEK_ROWS
  const rayReach = RAY_REACH + 1.4 * pulse
  const swirl = 0.12 * Math.sin((time * 2 * Math.PI) / 5.1)

  const rows: Run[][] = []
  for (let y = 0; y <= horizonY; y++) {
    const runs: Run[] = []
    let text = ""
    let color = ""
    const push = (ch: string, c: string) => {
      if (c !== color && text) {
        runs.push({ text, color })
        text = ""
      }
      color = c
      text += ch
    }

    for (let x = 0; x < width; x++) {
      const dx = (x - cx) * ASPECT
      const dy = y - cy
      const r = Math.hypot(dx, dy)
      const isHorizonRow = y === horizonY

      if (r <= radius) {
        // sun disc: bright core fading to a hot rim
        const t = r / radius
        const intensity = 1 - 0.72 * t + 0.06 * pulse
        push(rampChar(intensity), gradientAt(t))
        continue
      }

      if (isHorizonRow) {
        push("─", "#8B5A2B")
        continue
      }

      // soft glow ring hugging the rim
      if (r <= radius + 1.25) {
        push(":", "#B14A1E")
        continue
      }

      // ray spokes start just off the rim (sunburst gap), breathing with the pulse
      const angle = Math.atan2(-dy, dx)
      const rayStart = radius + 1.5
      if (r >= rayStart) {
        const spoke = Math.cos(10 * angle + swirl) ** 12
        const falloff = Math.max(0, 1 - (r - rayStart) / rayReach)
        const signal = spoke * falloff
        if (signal > 0.18) {
          const bright = signal > 0.44
          push(bright ? rayChar(angle) : "·", bright ? "#FFB45C" : "#A65B2E")
          continue
        }
      }

      // sparse twinkling halo specks near the rim
      const seed = hash2(x, y)
      const twinkle = 0.035 + 0.025 * Math.sin((time * 2 * Math.PI) / 1.6 + seed * 40)
      if (r < radius + 5.5 && seed < twinkle) {
        push(seed < twinkle / 2 ? "·" : ":", "#6E4226")
        continue
      }

      push(" ", color || "#000000")
    }
    if (text) runs.push({ text, color })
    rows.push(runs)
  }
  return rows
}

export const LOGO_FPS = 12
export const RISE_DURATION_MS = 1200
export const WORDMARK = "DAWN"
export const TAGLINE = "reasoning, not memory"

export const COMPACT_WORDMARK_ROWS: Run[][] = [
  [
    { text: "D", color: "#FFF3C4" },
    { text: "A", color: "#FFC36B" },
    { text: "W", color: "#FFB45C" },
    { text: "N", color: "#FF8C42" },
  ],
]

export const WIDE_WORDMARK_ROWS = COMPACT_WORDMARK_ROWS
export const WIDE_WORDMARK_MIN_COLS = WORDMARK.length + 4

export function wordmarkRows(cols: number): Run[][] {
  return COMPACT_WORDMARK_ROWS
}
