import { describe, expect, test } from "bun:test"
import { sunFrame } from "../src/logo"

function plain(rows: ReturnType<typeof sunFrame>): string[] {
  return rows.map((runs) => runs.map((r) => r.text).join(""))
}

describe("sunFrame", () => {
  test("rows are uniform width and clamped to terminal columns", () => {
    for (const cols of [10, 80, 200]) {
      const rows = plain(sunFrame({ cols, time: 0 }))
      const width = rows[0]!.length
      expect(width).toBeGreaterThanOrEqual(24)
      expect(width).toBeLessThanOrEqual(72)
      for (const row of rows) expect(row.length).toBe(width)
    }
  })

  test("fully risen sun shows a dense core on the horizon row", () => {
    const rows = plain(sunFrame({ cols: 64, time: 0, rise: 1 }))
    expect(rows[rows.length - 1]).toContain("@")
  })

  test("horizon line spans the frame", () => {
    const rows = plain(sunFrame({ cols: 64, time: 0 }))
    expect(rows[rows.length - 1]!.startsWith("─")).toBe(true)
    expect(rows[rows.length - 1]!.endsWith("─")).toBe(true)
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
