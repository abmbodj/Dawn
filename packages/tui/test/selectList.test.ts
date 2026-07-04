import { describe, expect, test } from "bun:test"
import {
  followSelection,
  nextSelectable,
  type SelectListItem,
  safeSelection,
} from "../src/components/SelectList"

const item = (key: string, selectable = true): SelectListItem => ({
  key,
  selectable,
  render: () => null,
})

// header, two models, header, one model
const items = [item("h1", false), item("m1"), item("m2"), item("h2", false), item("m3")]

describe("safeSelection", () => {
  test("empty list returns 0", () => {
    expect(safeSelection([], 5)).toBe(0)
  })

  test("clamps out-of-range and lands on a selectable row", () => {
    expect(safeSelection(items, -3)).toBe(1) // clamped to header 0 → forward to m1
    expect(safeSelection(items, 99)).toBe(4) // clamped to m3
    expect(safeSelection(items, 3)).toBe(4) // header → forward
  })

  test("searches backward when nothing selectable ahead", () => {
    const tail = [item("m1"), item("h", false)]
    expect(safeSelection(tail, 1)).toBe(0)
  })
})

describe("nextSelectable", () => {
  test("skips headers in both directions", () => {
    expect(nextSelectable(items, 2, 1)).toBe(4) // m2 → skip h2 → m3
    expect(nextSelectable(items, 4, -1)).toBe(2) // m3 → skip h2 → m2
  })

  test("stays put at the edges", () => {
    expect(nextSelectable(items, 1, -1)).toBe(1) // only h1 above
    expect(nextSelectable(items, 4, 1)).toBe(4)
  })
})

describe("followSelection", () => {
  test("no movement while the selection is inside the viewport", () => {
    expect(followSelection(10, 12, 5)).toBe(10)
    expect(followSelection(10, 10, 5)).toBe(10)
    expect(followSelection(10, 14, 5)).toBe(10)
  })

  test("pans up/down just far enough", () => {
    expect(followSelection(10, 7, 5)).toBe(7) // above → top = idx
    expect(followSelection(10, 15, 5)).toBe(11) // below → idx - height + 1
  })
})
