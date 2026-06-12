import { afterEach, describe, expect, spyOn, test } from "bun:test"
import os from "node:os"
import { formatBytes, localModelFit } from "../src/provider/local-fit"

const GB = 1_000_000_000

function mockRam(totalGb: number, freeGb: number) {
  spyOn(os, "totalmem").mockReturnValue(totalGb * GB)
  spyOn(os, "freemem").mockReturnValue(freeGb * GB)
}

afterEach(() => {
  // bun's spyOn auto-restores between files but be explicit within this file
  ;(os.totalmem as ReturnType<typeof spyOn>).mockRestore?.()
  ;(os.freemem as ReturnType<typeof spyOn>).mockRestore?.()
})

describe("localModelFit", () => {
  test("oversized when the model exceeds free RAM", () => {
    mockRam(8, 3) // 8 GB total, 3 GB free
    expect(localModelFit(4.68 * GB).status).toBe("oversized")
  })

  test("oversized when the model exceeds 60% of total even if free", () => {
    mockRam(8, 8) // plenty free, but 5 GB > 60% of 8 GB
    expect(localModelFit(5 * GB).status).toBe("oversized")
  })

  test("tight when past 45% of total but under the oversized bar", () => {
    mockRam(16, 16)
    expect(localModelFit(8 * GB).status).toBe("tight") // 8/16 = 50% > 45%, < 60%
  })

  test("ok for a small model on a roomy machine", () => {
    mockRam(32, 24)
    expect(localModelFit(2 * GB).status).toBe("ok")
  })

  test("unknown size never blocks", () => {
    mockRam(8, 1)
    expect(localModelFit(undefined).status).toBe("ok")
    expect(localModelFit(0).status).toBe("ok")
  })
})

describe("formatBytes", () => {
  test("renders GB and MB and unknowns", () => {
    expect(formatBytes(4.68 * GB)).toBe("4.7 GB")
    expect(formatBytes(500_000_000)).toBe("500 MB")
    expect(formatBytes(undefined)).toBe("?")
    expect(formatBytes(0)).toBe("?")
  })
})
