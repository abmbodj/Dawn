import { describe, expect, test } from "bun:test"
import type { Catalog, UsageTotals } from "@dawn/core"
import { formatStatusUsage, modelLabel, statusFooterParts } from "../src/status"

const catalog: Catalog = {
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "meta-llama/llama-4-scout-17b-16e-instruct": {
        id: "meta-llama/llama-4-scout-17b-16e-instruct",
        name: "Llama 4 Scout",
      },
    },
  },
}

const usage: UsageTotals = {
  inputTokens: 1_600,
  outputTokens: 28,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  cost: 0.001,
  steps: 1,
}

describe("modelLabel", () => {
  test("uses provider and model display names when available", () => {
    expect(modelLabel(catalog, "groq/meta-llama/llama-4-scout-17b-16e-instruct")).toBe("Groq · Llama 4 Scout")
  })

  test("falls back to the raw ref for unknown models", () => {
    expect(modelLabel(catalog, "custom/some-model")).toBe("custom/some-model")
  })
})

describe("formatStatusUsage", () => {
  test("wide mode uses readable labels", () => {
    const text = formatStatusUsage(usage, "wide")
    expect(text).toContain("1.6k in")
    expect(text).toContain("28 out")
    expect(text).toContain("Cache: 0")
    expect(text).toContain("Cost: $0.001")
  })
})

describe("statusFooterParts", () => {
  test("wide mode separates model and usage text", () => {
    expect(
      statusFooterParts({
        busy: false,
        catalog,
        modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
        usage,
        width: 140,
      }),
    ).toEqual({
      mode: "wide",
      left: "Model: Groq · Llama 4 Scout",
      right: "Usage: 1.6k in / 28 out · Cache: 0 · Cost: $0.001",
    })
  })

  test("narrow mode keeps one readable line", () => {
    const footer = statusFooterParts({
      busy: false,
      catalog,
      modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
      usage,
      width: 48,
    })

    expect(footer.mode).toBe("narrow")
    expect(footer.left).toBe("Model: Llama 4 Scout · $0.001")
    expect(footer.right).toBeUndefined()
    expect(footer.left).not.toContain("↑")
    expect(footer.left).not.toContain("⚡")
  })

  test("busy narrow mode prioritizes the interrupt hint", () => {
    expect(
      statusFooterParts({
        busy: true,
        catalog,
        modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
        usage,
        width: 48,
      }),
    ).toEqual({ mode: "narrow", left: "Working... Esc to stop" })
  })
})
