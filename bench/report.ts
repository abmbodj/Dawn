#!/usr/bin/env bun
/**
 * Renders bench/results.json into a Markdown table. Prints to stdout, or with
 * --write-readme splices the table into README.md between the BENCH markers.
 *
 *   bun run bench/report.ts
 *   bun run bench/report.ts --write-readme
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

type Mode = "dawn" | "naive" | "claude"
interface RunMetrics {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cost: number
  steps: number
  ms: number
  success: boolean
  errored: boolean
  error?: string
}
interface TaskResult {
  task: string
  category: string
  modes: Partial<Record<Mode, RunMetrics[]>>
}
interface Results {
  provenance: {
    generatedAt: string
    gitShaShort: string
    model: string
    claudeModel: string | null
    reps: number
    taskCount: number
    smoke: boolean
  }
  results: TaskResult[]
}

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim()
const START = "<!-- BENCH:START -->"
const END = "<!-- BENCH:END -->"

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  if (s.length % 2) return s[mid] ?? 0
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

/** Median over successful reps; falls back to all reps if none succeeded. */
function pick(reps: RunMetrics[] | undefined, field: keyof RunMetrics): number {
  if (!reps || reps.length === 0) return 0
  const ok = reps.filter((r) => r.success)
  const pool = ok.length > 0 ? ok : reps
  return median(pool.map((r) => Number(r[field])))
}

function successCount(reps: RunMetrics[] | undefined): { ok: number; total: number } {
  return { ok: (reps ?? []).filter((r) => r.success).length, total: (reps ?? []).length }
}

function reduction(naive: number, dawn: number): string {
  if (naive <= 0) return "—"
  const pct = ((naive - dawn) / naive) * 100
  return `${pct >= 0 ? "−" : "+"}${Math.abs(pct).toFixed(0)}%`
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

function taskRow(
  r: TaskResult,
  hasClaude: boolean,
): {
  cells: string[]
  dawnIn: number
  dawnCost: number
  naiveIn: number
  naiveCost: number
  bothOk: boolean
} {
  const dawnIn = pick(r.modes.dawn, "inputTokens")
  const dawnCached = pick(r.modes.dawn, "cachedInputTokens")
  const dawnCost = pick(r.modes.dawn, "cost")
  const naiveIn = pick(r.modes.naive, "inputTokens")
  const naiveCost = pick(r.modes.naive, "cost")
  const ds = successCount(r.modes.dawn)
  const ns = successCount(r.modes.naive)
  const bothOk = ds.ok > 0 && ns.ok > 0

  // Append pass/total to the task label so success rate is always visible
  const passTag = `(d:${ds.ok}/${ds.total} n:${ns.ok}/${ns.total})`
  const label = bothOk ? `${r.task} ${passTag}` : `${r.task} ⚠️ ${passTag}`

  const cells = [
    label,
    `${fmtInt(dawnIn)} (${fmtInt(dawnCached)})`,
    fmtInt(naiveIn),
    reduction(naiveIn, dawnIn),
    `$${dawnCost.toFixed(4)}`,
    `$${naiveCost.toFixed(4)}`,
    reduction(naiveCost, dawnCost),
  ]
  if (hasClaude) {
    const cs = successCount(r.modes.claude)
    const claudeIn = pick(r.modes.claude, "inputTokens")
    const claudeCost = pick(r.modes.claude, "cost")
    cells.push(`${fmtInt(claudeIn)} (c:${cs.ok}/${cs.total})`, `$${claudeCost.toFixed(4)}`)
  }
  return { cells, dawnIn, dawnCost, naiveIn, naiveCost, bothOk }
}

function render(data: Results): string {
  const { provenance: p, results } = data
  const hasClaude = results.some((r) => r.modes.claude && r.modes.claude.length > 0)

  const header = hasClaude
    ? "| Task (pass rate) | Dawn input (cached) | Naive input | Input ↓ | Dawn $ | Naive $ | Cost ↓ | Claude input | Claude $ |"
    : "| Task (pass rate) | Dawn input (cached) | Naive input | Input ↓ | Dawn $ | Naive $ | Cost ↓ |"
  const sep = hasClaude
    ? "| --- | --: | --: | --: | --: | --: | --: | --: | --: |"
    : "| --- | --: | --: | --: | --: | --: | --: |"

  // Group tasks by category
  const categories = [...new Set(results.map((r) => r.category))]
  const grouped = new Map<string, TaskResult[]>()
  for (const cat of categories) {
    grouped.set(
      cat,
      results.filter((r) => r.category === cat),
    )
  }

  // Per-category and overall accumulators
  let totalNaiveIn = 0
  let totalDawnIn = 0
  let totalNaiveCost = 0
  let totalDawnCost = 0
  const overallInputRed: number[] = []
  const overallCostRed: number[] = []

  const sections: string[] = []

  for (const [cat, catResults] of grouped) {
    const catInputRed: number[] = []
    const catCostRed: number[] = []
    const rows: string[] = []

    for (const r of catResults) {
      const { cells, dawnIn, dawnCost, naiveIn, naiveCost, bothOk } = taskRow(r, hasClaude)
      rows.push(`| ${cells.join(" | ")} |`)

      if (bothOk && naiveIn > 0) {
        catInputRed.push(((naiveIn - dawnIn) / naiveIn) * 100)
        if (naiveCost > 0) catCostRed.push(((naiveCost - dawnCost) / naiveCost) * 100)
        totalNaiveIn += naiveIn
        totalDawnIn += dawnIn
        totalNaiveCost += naiveCost
        totalDawnCost += dawnCost
        overallInputRed.push(((naiveIn - dawnIn) / naiveIn) * 100)
        if (naiveCost > 0) overallCostRed.push(((naiveCost - dawnCost) / naiveCost) * 100)
      }
    }

    const catMedIn = median(catInputRed)
    const catMedCost = median(catCostRed)
    const catInLabel =
      catMedIn >= 0
        ? `**${catMedIn.toFixed(0)}% fewer input tokens**`
        : catMedCost >= 0
          ? `**${Math.abs(catMedIn).toFixed(0)}% more input tokens** (caching discount offsets cost)`
          : `**${Math.abs(catMedIn).toFixed(0)}% more input tokens**`
    const catCostLabel =
      catMedCost >= 0
        ? `**${catMedCost.toFixed(0)}% less cost**`
        : `**${Math.abs(catMedCost).toFixed(0)}% more cost**`
    const catSummary =
      catInputRed.length > 0
        ? `_${cat}: median ${catInLabel}, ${catCostLabel} (${catInputRed.length} task(s) at equal success)_`
        : `_${cat}: no comparable task(s) passed in both modes_`

    sections.push(`### ${cat}\n\n${catSummary}\n\n${header}\n${sep}\n${rows.join("\n")}`)
  }

  const medInput = median(overallInputRed)
  const medCost = median(overallCostRed)
  const pooledInput = totalNaiveIn > 0 ? ((totalNaiveIn - totalDawnIn) / totalNaiveIn) * 100 : 0
  const pooledCost = totalNaiveCost > 0 ? ((totalNaiveCost - totalDawnCost) / totalNaiveCost) * 100 : 0

  const inSummary =
    medInput >= 0
      ? `${medInput.toFixed(0)}% fewer input tokens`
      : medCost >= 0
        ? `${Math.abs(medInput).toFixed(0)}% more input tokens (caching discount offsets cost)`
        : `${Math.abs(medInput).toFixed(0)}% more input tokens`
  const costSummary =
    medCost >= 0 ? `${medCost.toFixed(0)}% less cost` : `${Math.abs(medCost).toFixed(0)}% more cost`
  const summary =
    `**Across ${overallInputRed.length} comparable task(s) at equal success, Dawn used a median ` +
    `${inSummary} and ${costSummary} than the naive baseline ` +
    `(pooled: ${pooledInput >= 0 ? "" : "+"}${(-pooledInput).toFixed(0)}% tokens vs naive, ${pooledCost >= 0 ? "−" : "+"}${Math.abs(pooledCost).toFixed(0)}% cost).**`

  const caption =
    `_Measured by ${data.provenance.model}` +
    (p.claudeModel ? `, Claude Code on ${p.claudeModel}` : "") +
    `, Dawn repo @ ${p.gitShaShort}, ${p.reps} rep(s)/task (median), ${p.generatedAt.slice(0, 10)}._` +
    (p.smoke ? " _(smoke subset)_" : "")

  const caveat = hasClaude
    ? "\n_The Claude Code column is **indicative, not apples-to-apples**: same model and task, but a different agent (its own system prompt, tools, and loop). The rigorous comparison is Dawn vs. `--naive` — the identical agent with context management turned off. ⚠️ marks tasks where a mode did not pass its correctness check; those are excluded from the medians._"
    : "\n_⚠️ marks tasks where a mode did not pass its correctness check; those are excluded from the medians._"

  const reproduce =
    "\n```bash\n# Reproduce (requires Anthropic key + `claude` CLI for the Claude column):\nbun run bench        # real API spend, non-deterministic\nbun run bench:report # regenerate this table\n\n# Free local verification of the mechanism delta (Dawn vs --naive only):\nbun run bench --no-claude --model ollama/<model>   # or groq/<model>\n```"

  return [summary, "", ...sections, "", caption, caveat, reproduce].join("\n\n")
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function main(): void {
  const resultsPath = argValue("--in") ?? path.join(REPO_ROOT, "bench", "results.json")
  if (!fs.existsSync(resultsPath)) {
    console.error("no bench/results.json — run `bun run bench` first.")
    process.exit(1)
  }
  const data = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Results
  const table = render(data)

  if (process.argv.includes("--write-readme")) {
    const readmePath = path.join(REPO_ROOT, "README.md")
    const readme = fs.readFileSync(readmePath, "utf8")
    if (!readme.includes(START) || !readme.includes(END)) {
      console.error(`README.md is missing the ${START} / ${END} markers.`)
      process.exit(1)
    }
    const before = readme.slice(0, readme.indexOf(START) + START.length)
    const after = readme.slice(readme.indexOf(END))
    fs.writeFileSync(readmePath, `${before}\n${table}\n${after}`)
    console.error(`updated ${readmePath} between BENCH markers.`)
  } else {
    console.log(table)
  }
}

main()
