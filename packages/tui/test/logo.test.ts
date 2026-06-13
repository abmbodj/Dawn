import { describe, expect, test } from "bun:test"
import {
  COMPACT_WORDMARK_ROWS,
  sunFrame,
  TAGLINE,
  WIDE_WORDMARK_MIN_COLS,
  WIDE_WORDMARK_ROWS,
  WORDMARK,
  wordmarkRows,
} from "../src/logo"

function plain(rows: ReturnType<typeof sunFrame>): string[] {
  return rows.map((runs) => runs.map((r) => r.text).join(""))
}

function plainRuns(rows: Array<Array<{ text: string }>>): string[] {
  return rows.map((runs) => runs.map((r) => r.text).join(""))
}

const DENSE_SUN = new Set([";", "+", "%", "#", "@"])

function densePositions(rows: string[]): number[] {
  const positions: number[] = []
  for (const row of rows.slice(0, -1)) {
    for (let x = 0; x < row.length; x++) {
      if (DENSE_SUN.has(row[x] ?? "")) positions.push(x)
    }
  }
  return positions
}

function denseBounds(rows: string[]): { left: number; right: number; top: number; bottom: number } {
  const points: Array<[number, number]> = []
  for (const [y, row] of rows.slice(0, -1).entries()) {
    for (let x = 0; x < row.length; x++) {
      if (DENSE_SUN.has(row[x] ?? "")) points.push([x, y])
    }
  }

  return {
    left: Math.min(...points.map(([x]) => x)),
    right: Math.max(...points.map(([x]) => x)),
    top: Math.min(...points.map(([, y]) => y)),
    bottom: Math.max(...points.map(([, y]) => y)),
  }
}

describe("sunFrame", () => {
  test("rows are uniform width and clamped to terminal columns", () => {
    for (const cols of [10, 80, 200]) {
      const rows = plain(sunFrame({ cols, time: 0 }))
      const first = rows[0]
      expect(first).toBeDefined()
      const width = first?.length ?? 0
      expect(width).toBeGreaterThanOrEqual(24)
      expect(width).toBeLessThanOrEqual(72)
      for (const row of rows) expect(row.length).toBe(width)
    }
  })

  test("settled sun exposes a substantial dense disc above the horizon", () => {
    const rows = plain(sunFrame({ cols: 64, time: 0, rise: 1 }))
    const aboveHorizon = rows.slice(0, -1).join("")
    expect(aboveHorizon).toContain("@")
    expect(densePositions(rows).length).toBeGreaterThan(150)
  })

  test("sun disc is horizontally centered", () => {
    const rows = plain(sunFrame({ cols: 64, time: 0 }))
    const { left, right } = denseBounds(rows)
    const expectedCenter = ((rows[0]?.length ?? 1) - 1) / 2
    expect((left + right) / 2).toBeCloseTo(expectedCenter, 1)
  })

  test("sun disc has a broad horizontal profile", () => {
    const rows = plain(sunFrame({ cols: 64, time: 0 }))
    const { left, right, top, bottom } = denseBounds(rows)
    const cellRatio = (right - left + 1) / (bottom - top + 1)
    expect(cellRatio).toBeGreaterThanOrEqual(3.5)
  })

  test("horizon line spans the frame", () => {
    const rows = plain(sunFrame({ cols: 64, time: 0 }))
    const horizon = rows[rows.length - 1]
    expect(horizon?.startsWith("─")).toBe(true)
    expect(horizon?.endsWith("─")).toBe(true)
  })

  test("unrisen sun is clipped below the horizon", () => {
    const sky = plain(sunFrame({ cols: 64, time: 0, rise: 0 }))
      .slice(0, -1)
      .join("")
    expect(sky).not.toContain("@")
    expect(sky).not.toContain("#")
  })

  test("frames are deterministic for a given time", () => {
    expect(sunFrame({ cols: 64, time: 1.5 })).toEqual(sunFrame({ cols: 64, time: 1.5 }))
  })

  test("pulse animates between phases", () => {
    expect(plain(sunFrame({ cols: 64, time: 0.3 }))).not.toEqual(plain(sunFrame({ cols: 64, time: 1.4 })))
  })
})

describe("wordmarkRows", () => {
  test("wide wordmark rows have uniform width", () => {
    const rows = plainRuns(WIDE_WORDMARK_ROWS)
    expect(rows.length).toBe(5)
    const width = rows[0]?.length ?? 0
    expect(width).toBeGreaterThan(WORDMARK.length)
    for (const row of rows) expect(row.length).toBe(width)
  })

  test("uses compact fallback below the wide threshold", () => {
    expect(wordmarkRows(WIDE_WORDMARK_MIN_COLS - 1)).toBe(COMPACT_WORDMARK_ROWS)
    expect(wordmarkRows(WIDE_WORDMARK_MIN_COLS)).toBe(WIDE_WORDMARK_ROWS)
  })

  test("rendered title output contains recognizable Dawn lettering", () => {
    const wide = plainRuns(WIDE_WORDMARK_ROWS).join("\n")
    // Figlet "Standard" outline lettering — pipes and underscores, no block
    // or rounded box-drawing glyphs.
    expect(wide).toContain("|")
    expect(wide).toContain("_")
    expect(wide).not.toContain("█")
    expect(wide).not.toContain("╭")
    expect(wide).not.toContain("╰")
    expect(plainRuns(COMPACT_WORDMARK_ROWS).join("")).toBe("DAWN")
  })

  test("tagline remains unchanged", () => {
    expect(TAGLINE).toBe("reasoning, not memory")
  })
})
