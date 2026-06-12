import { describe, expect, test } from "bun:test"
import type { Catalog, ContextStats, UsageTotals } from "@dawn/core"
import {
  formatContextReport,
  formatStatusUsage,
  formatUsageReport,
  modelLabel,
  statusFooterParts,
  usageBoxRows,
} from "../src/status"

const catalog: Catalog = {
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "meta-llama/llama-4-scout-17b-16e-instruct": {
        id: "meta-llama/llama-4-scout-17b-16e-instruct",
        name: "Llama 4 Scout",
        cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
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

const emptyContext: ContextStats = {
  mode: "balanced",
  budget: 8000,
  workingSetTokens: 0,
  loadedItems: [],
  cachedSummaries: 0,
  repoIndex: { cwd: "/repo", indexedFiles: 0 },
  estimatedSavedTokens: 0,
  averageInputTokens: 0,
}

describe("modelLabel", () => {
  test("uses provider and model display names when available", () => {
    expect(modelLabel(catalog, "groq/meta-llama/llama-4-scout-17b-16e-instruct")).toBe("Groq · Llama 4 Scout")
  })

  test("falls back to the raw ref for unknown models", () => {
    expect(modelLabel(catalog, "custom/some-model")).toBe("custom/some-model")
  })
})

describe("formatContextReport", () => {
  test("shows context budget, loaded ranges, summaries, index, and savings", () => {
    const stats: ContextStats = {
      mode: "balanced",
      budget: 8000,
      workingSetTokens: 2430,
      loadedItems: [
        {
          kind: "file-range",
          path: "packages/core/src/agent/agent.ts",
          startLine: 60,
          endLine: 130,
          reason: "request builder",
          ttl: 2,
          estimatedTokens: 900,
          createdAt: 1,
        },
      ],
      cachedSummaries: 42,
      repoIndex: { cwd: "/repo", indexedFiles: 100, updatedAt: 1 },
      estimatedSavedTokens: 18200,
      averageInputTokens: 0,
    }

    const report = formatContextReport(stats)

    expect(report).toContain("Mode: balanced")
    expect(report).toContain("Budget: 8,000 tokens")
    expect(report).toContain("packages/core/src/agent/agent.ts lines 60-130")
    expect(report).toContain("Cached summaries: 42")
    expect(report).toContain("Repo index: 100 files")
    expect(report).toContain("Estimated saved: 18,200 tokens")
  })
})

describe("formatUsageReport", () => {
  test("includes cache writes, averages, highest-cost turn, and savings", () => {
    const lifetime: UsageTotals = {
      inputTokens: 3000,
      outputTokens: 500,
      cachedInputTokens: 1000,
      cacheWriteTokens: 250,
      cost: 0.01,
      steps: 2,
    }
    const context: ContextStats = {
      mode: "balanced",
      budget: 8000,
      workingSetTokens: 0,
      loadedItems: [],
      cachedSummaries: 0,
      repoIndex: { cwd: "/repo", indexedFiles: 0 },
      estimatedSavedTokens: 1200,
      averageInputTokens: 1500,
      highestCostTurn: {
        providerId: "groq",
        modelId: "meta-llama/llama-4-scout-17b-16e-instruct",
        inputTokens: 2000,
        outputTokens: 300,
        cost: 0.008,
      },
    }

    const report = formatUsageReport({
      perModel: new Map([["groq/meta-llama/llama-4-scout-17b-16e-instruct", lifetime]]),
      lifetime,
      context,
      catalog,
    })
    const lines = report.split("\n")

    expect(lines[1]).toBe("estimated context savings: 1,200 tokens")
    expect(report).toContain("cache write 250")
    expect(report).toContain("average input: 1,500 tokens/turn")
    expect(report).toContain("highest-cost turn: groq/meta-llama/llama-4-scout-17b-16e-instruct")
    expect(report).toContain("estimated context savings: 1,200 tokens")
    expect(report).toContain("without cache pricing")
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

describe("usageBoxRows", () => {
  test("renders zero savings as a quiet savings-first summary", () => {
    const rows = usageBoxRows({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        steps: 0,
      },
      context: emptyContext,
    })

    expect(rows[0]).toEqual({ label: "saved", value: "0 tokens", priority: "hero", tone: "dim" })
    expect(rows).toContainEqual({ label: "mode", value: "balanced" })
    expect(rows).toContainEqual({ label: "context", value: "0 / 8.0k" })
    expect(rows).toContainEqual({ label: "loaded", value: "0" })
    expect(rows).toContainEqual({ label: "cache", value: "read 0 / write 0", tone: "dim" })
    expect(rows).toContainEqual({ label: "avg in", value: "0/turn" })
    expect(rows).toContainEqual({ label: "cost", value: "$0.000", tone: "dim" })
  })

  test("includes accented savings, context health, cache writes, and average input", () => {
    const rows = usageBoxRows({
      usage: {
        inputTokens: 3000,
        outputTokens: 500,
        cachedInputTokens: 1000,
        cacheWriteTokens: 250,
        cost: 0.01,
        steps: 2,
      },
      context: {
        ...emptyContext,
        workingSetTokens: 2430,
        loadedItems: [
          {
            kind: "file-range",
            path: "packages/core/src/agent/agent.ts",
            startLine: 60,
            endLine: 130,
            reason: "request builder",
            ttl: 2,
            estimatedTokens: 900,
            createdAt: 1,
          },
        ],
        cachedSummaries: 42,
        estimatedSavedTokens: 1200,
      },
    })

    expect(rows[0]).toEqual({ label: "saved", value: "1.2k tokens", priority: "hero", tone: "accent" })
    expect(rows).toContainEqual({ label: "context", value: "2.4k / 8.0k" })
    expect(rows).toContainEqual({ label: "loaded", value: "1" })
    expect(rows).toContainEqual({ label: "summaries", value: "42", tone: "dim" })
    expect(rows).toContainEqual({ label: "tokens", value: "↑3.0k ↓500" })
    expect(rows).toContainEqual({ label: "cache", value: "read 1.0k / write 250", tone: "accent" })
    expect(rows).toContainEqual({ label: "avg in", value: "1.5k/turn" })
    expect(rows).toContainEqual({ label: "cost", value: "$0.010", tone: "dim" })
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

  test("wide mode suppresses footer usage when the usage box is visible", () => {
    expect(
      statusFooterParts({
        busy: false,
        catalog,
        modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
        usage,
        width: 140,
        showUsageBox: true,
      }),
    ).toEqual({
      mode: "wide",
      left: "Model: Groq · Llama 4 Scout",
    })
  })

  test("medium mode keeps footer usage even when the box flag is set", () => {
    expect(
      statusFooterParts({
        busy: false,
        catalog,
        modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
        usage,
        width: 90,
        showUsageBox: true,
      }),
    ).toEqual({
      mode: "medium",
      left: "Model: Groq · Llama 4 Scout",
      right: "1.6k in / 28 out · $0.001",
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
