import { describe, expect, test } from "bun:test"
import type { Catalog, ContextStats, UsageTotals } from "@dawn/core"
import {
  formatContextReport,
  formatSavingsReport,
  formatStatusUsage,
  formatUsageReport,
  modelLabel,
  savingsBoxRows,
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
      latestPlan: {
        systemTokens: 100,
        historyTokens: 500,
        summaryTokens: 300,
        fileTokens: 900,
        toolResultTokens: 0,
        totalEstimatedTokens: 1800,
        budget: 8000,
        mode: "balanced",
        trimmedItems: ["history message"],
        includedItems: [
          {
            kind: "summary",
            label: "summary packages/core/src/agent/agent.ts",
            tokens: 300,
            reason: "relevant summary",
          },
          {
            kind: "file-range",
            label: "packages/core/src/agent/agent.ts lines 60-130",
            tokens: 900,
            reason: "request builder",
          },
        ],
        skippedItems: [{ kind: "history", label: "history message", tokens: 1200, reason: "history budget" }],
        savingsEstimate: 1200,
      },
    }

    const report = formatContextReport(stats)

    expect(report).toContain("Mode: balanced")
    expect(report).toContain("Budget: 8,000 tokens")
    expect(report).toContain("packages/core/src/agent/agent.ts lines 60-130")
    expect(report).toContain("Cached summaries: 42")
    expect(report).toContain("Repo index: 100 files")
    expect(report).toContain("Estimated saved: 18,200 tokens")
    expect(report).toContain("Audit:")
    expect(report).toContain("Loaded: 1")
    expect(report).toContain("Summarized: 1")
    expect(report).toContain("Skipped: 1")
    expect(report).toContain("Saved this turn: 1,200 tokens")
    expect(report).toContain("Included:")
    expect(report).toContain("Skipped:")
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

describe("formatSavingsReport", () => {
  test("shows session, project, and lifetime savings against no planning", () => {
    const report = formatSavingsReport({
      scopes: [
        {
          label: "session",
          usage: { ...usage, inputTokens: 3000, steps: 2 },
          context: {
            plans: 2,
            estimatedSavedTokens: 1200,
            plannedInputTokens: 2200,
            includedItems: 4,
            skippedItems: 3,
            highestSavingsPlan: {
              sessionId: "session-a",
              ts: 1,
              savedTokens: 900,
              totalEstimatedTokens: 1800,
              budget: 8000,
              mode: "balanced",
            },
          },
        },
        {
          label: "project",
          usage: { ...usage, inputTokens: 6000, steps: 4 },
          context: {
            plans: 4,
            estimatedSavedTokens: 3000,
            plannedInputTokens: 5000,
            includedItems: 8,
            skippedItems: 6,
          },
        },
        {
          label: "lifetime",
          usage: { ...usage, inputTokens: 10_000, steps: 6 },
          context: {
            plans: 6,
            estimatedSavedTokens: 5000,
            plannedInputTokens: 9000,
            includedItems: 12,
            skippedItems: 10,
          },
        },
      ],
      catalog,
      modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
    })

    expect(report).toContain("Compared to: without Dawn context planning")
    expect(report).toContain("session:")
    expect(report).toContain("saved: 1,200 tokens")
    expect(report).toContain("input cut: 29%")
    expect(report).toContain("Dawn sent: 3.0k input")
    expect(report).toContain("would send: 4.2k input")
    expect(report).toContain("est $ saved: $0.001")
    expect(report).toContain("context items: 4 included / 3 skipped")
    expect(report).toContain("highest-saving turn: 900 tokens saved (1.8k / 8.0k, balanced)")
    expect(report).toContain("project:")
    expect(report).toContain("lifetime:")
  })

  test("shows unknown savings pricing when the current model is unpriced", () => {
    const report = formatSavingsReport({
      scopes: [
        {
          label: "session",
          usage,
          context: {
            plans: 1,
            estimatedSavedTokens: 1200,
            plannedInputTokens: 1600,
            includedItems: 1,
            skippedItems: 1,
          },
        },
      ],
      catalog,
      modelRef: "custom/some-model",
    })

    expect(report).toContain("Pricing: unknown")
    expect(report).toContain("est $ saved: unknown")
  })
})

describe("usageBoxRows", () => {
  test("renders zero usage as a compact frugal summary", () => {
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

    expect(rows).toEqual([
      { label: "cost", value: "$0.000", tone: "dim" },
      { label: "steps", value: "0", tone: "dim" },
      { label: "tokens", value: "↑0 ↓0" },
      { label: "cache", value: "read 0 / write 0", tone: "dim" },
      { label: "avg input", value: "0/turn" },
    ])
  })

  test("includes cache writes, average input, and context savings", () => {
    const rows = usageBoxRows({
      usage: {
        inputTokens: 3000,
        outputTokens: 500,
        cachedInputTokens: 1000,
        cacheWriteTokens: 250,
        cost: 0.01,
        steps: 2,
      },
      context: { ...emptyContext, estimatedSavedTokens: 1200 },
    })

    expect(rows).toContainEqual({ label: "cost", value: "$0.010", tone: "accent" })
    expect(rows).toContainEqual({ label: "tokens", value: "↑3.0k ↓500" })
    expect(rows).toContainEqual({ label: "cache", value: "read 1.0k / write 250", tone: "accent" })
    expect(rows).toContainEqual({ label: "avg input", value: "1.5k/turn" })
    expect(rows).not.toContainEqual({ label: "saved", value: "1.2k", tone: "accent" })
  })
})

describe("savingsBoxRows", () => {
  test("renders zero saved tokens as quiet comparison values", () => {
    const rows = savingsBoxRows({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        steps: 0,
      },
      context: emptyContext,
      catalog,
      modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
    })

    expect(rows).toEqual([
      { label: "saved", value: "0 tokens", tone: "dim" },
      { label: "input cut", value: "0%", tone: "dim" },
      { label: "would send", value: "0 tokens" },
      { label: "sent", value: "0 tokens" },
      { label: "$ saved", value: "$0.000", tone: "dim" },
      { label: "vs", value: "no planning", tone: "dim" },
    ])
  })

  test("calculates would-send tokens, percentage, and estimated dollar savings", () => {
    const rows = savingsBoxRows({
      usage: {
        inputTokens: 3000,
        outputTokens: 500,
        cachedInputTokens: 1000,
        cacheWriteTokens: 250,
        cost: 0.01,
        steps: 2,
      },
      context: { ...emptyContext, estimatedSavedTokens: 1200 },
      catalog,
      modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
    })

    expect(rows).toContainEqual({ label: "saved", value: "1.2k tokens", tone: "accent" })
    expect(rows).toContainEqual({ label: "input cut", value: "29%", tone: "accent" })
    expect(rows).toContainEqual({ label: "would send", value: "4.2k tokens" })
    expect(rows).toContainEqual({ label: "sent", value: "3.0k tokens" })
    expect(rows).toContainEqual({ label: "$ saved", value: "$0.001", tone: "accent" })
    expect(rows).toContainEqual({ label: "vs", value: "no planning", tone: "dim" })
  })

  test("shows unknown estimated dollar savings without pricing", () => {
    const rows = savingsBoxRows({
      usage,
      context: { ...emptyContext, estimatedSavedTokens: 1200 },
      catalog,
      modelRef: "custom/some-model",
    })

    expect(rows).toContainEqual({ label: "$ saved", value: "unknown", tone: "dim" })
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
        permMode: "normal",
      }),
    ).toEqual({
      mode: "wide",
      left: "Model: Groq · Llama 4 Scout",
      right: "Usage: 1.6k in / 28 out · Cache: 0 · Cost: $0.001",
      modeChip: undefined,
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
        permMode: "normal",
      }),
    ).toEqual({
      mode: "wide",
      left: "Model: Groq · Llama 4 Scout",
      modeChip: undefined,
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
        permMode: "normal",
      }),
    ).toEqual({
      mode: "medium",
      left: "Model: Groq · Llama 4 Scout",
      right: "1.6k in / 28 out · $0.001",
      modeChip: undefined,
    })
  })

  test("narrow mode keeps one readable line", () => {
    const footer = statusFooterParts({
      busy: false,
      catalog,
      modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
      usage,
      width: 48,
      permMode: "normal",
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
        permMode: "normal",
      }),
    ).toEqual({ mode: "narrow", left: "Working... Esc to stop", modeChip: undefined })
  })

  test("plan mode produces a PLAN modeChip", () => {
    const footer = statusFooterParts({
      busy: false,
      catalog,
      modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
      usage,
      width: 140,
      permMode: "plan",
    })
    expect(footer.modeChip).toEqual({ text: "PLAN", accent: true })
  })

  test("acceptEdits mode produces an AUTO-EDIT modeChip", () => {
    const footer = statusFooterParts({
      busy: false,
      catalog,
      modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
      usage,
      width: 140,
      permMode: "acceptEdits",
    })
    expect(footer.modeChip).toEqual({ text: "AUTO-EDIT", accent: true })
  })

  test("normal mode produces no modeChip", () => {
    const footer = statusFooterParts({
      busy: false,
      catalog,
      modelRef: "groq/meta-llama/llama-4-scout-17b-16e-instruct",
      usage,
      width: 140,
      permMode: "normal",
    })
    expect(footer.modeChip).toBeUndefined()
  })
})
