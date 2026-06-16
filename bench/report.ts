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

function render(data: Results): string {
  const { provenance: p, results } = data
  const hasClaude = results.some((r) => r.modes.claude && r.modes.claude.length > 0)

  const header = hasClaude
    ? "| Task | Dawn input (cached) | Naive input | Input ↓ | Dawn $ | Naive $ | Cost ↓ | Claude input | Claude $ |"
    : "| Task | Dawn input (cached) | Naive input | Input ↓ | Dawn $ | Naive $ | Cost ↓ |"
  const sep = hasClaude
    ? "| --- | --: | --: | --: | --: | --: | --: | --: | --: |"
    : "| --- | --: | --: | --: | --: | --: | --: |"

  const rows: string[] = []
  let naiveInSum = 0
  let dawnInSum = 0
  let naiveCostSum = 0
  let dawnCostSum = 0
  const perTaskInputRed: number[] = []
  const perTaskCostRed: number[] = []

  for (const r of results) {
    const dawnIn = pick(r.modes.dawn, "inputTokens")
    const dawnCached = pick(r.modes.dawn, "cachedInputTokens")
    const dawnCost = pick(r.modes.dawn, "cost")
    const naiveIn = pick(r.modes.naive, "inputTokens")
    const naiveCost = pick(r.modes.naive, "cost")
    const ds = successCount(r.modes.dawn)
    const ns = successCount(r.modes.naive)
    const bothOk = ds.ok > 0 && ns.ok > 0

    if (bothOk && naiveIn > 0) {
      naiveInSum += naiveIn
      dawnInSum += dawnIn
      naiveCostSum += naiveCost
      dawnCostSum += dawnCost
      perTaskInputRed.push(((naiveIn - dawnIn) / naiveIn) * 100)
      if (naiveCost > 0) perTaskCostRed.push(((naiveCost - dawnCost) / naiveCost) * 100)
    }

    const label = bothOk ? r.task : `${r.task} ⚠️`
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
      const claudeIn = pick(r.modes.claude, "inputTokens")
      const claudeCost = pick(r.modes.claude, "cost")
      cells.push(fmtInt(claudeIn), `$${claudeCost.toFixed(4)}`)
    }
    rows.push(`| ${cells.join(" | ")} |`)
  }

  const medInput = median(perTaskInputRed)
  const medCost = median(perTaskCostRed)
  const pooledInput = naiveInSum > 0 ? ((naiveInSum - dawnInSum) / naiveInSum) * 100 : 0
  const pooledCost = naiveCostSum > 0 ? ((naiveCostSum - dawnCostSum) / naiveCostSum) * 100 : 0

  const summary =
    `**Across ${perTaskInputRed.length} comparable task(s), Dawn used a median ` +
    `${medInput.toFixed(0)}% fewer input tokens and ${medCost.toFixed(0)}% less cost than the naive baseline ` +
    `(pooled: ${pooledInput.toFixed(0)}% tokens, ${pooledCost.toFixed(0)}% cost).**`

  const caption =
    `_Measured by ${data.provenance.model}` +
    (p.claudeModel ? `, Claude Code on ${p.claudeModel}` : "") +
    `, Dawn repo @ ${p.gitShaShort}, ${p.reps} rep(s)/task (median), ${p.generatedAt.slice(0, 10)}._` +
    (p.smoke ? " _(smoke subset)_" : "")

  const caveat = hasClaude
    ? "\n_The Claude Code column is **indicative, not apples-to-apples**: same model and task, but a different agent (its own system prompt, tools, and loop). The rigorous comparison is Dawn vs. `--naive` — the identical agent with context management turned off. ⚠️ marks tasks where a mode did not pass its success check; those are excluded from the medians._"
    : "\n_⚠️ marks tasks where a mode did not pass its success check; those are excluded from the medians._"

  const reproduce =
    "\n```bash\nbun run bench        # run it yourself (real API spend, non-deterministic)\nbun run bench:report # regenerate this table\n```"

  return [summary, "", header, sep, ...rows, "", caption, caveat, reproduce].join("\n")
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
