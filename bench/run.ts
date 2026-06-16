#!/usr/bin/env bun
/**
 * Real token benchmark: runs each task with Dawn (balanced) and a genuinely naive
 * baseline (`--naive`), and — when the `claude` CLI is available — Claude Code, all
 * against an isolated checkout of the Dawn repo at a pinned commit. Token counts are
 * read live from each agent's own usage accounting, never modeled.
 *
 * Usage:
 *   bun run bench/run.ts                 # full run, 3 reps, all modes
 *   bun run bench/run.ts --smoke         # 2 tasks, 1 rep (cheap end-to-end check)
 *   bun run bench/run.ts --reps 5
 *   bun run bench/run.ts --tasks savings-formatter,history-trim
 *   bun run bench/run.ts --model anthropic/claude-haiku-4-5-20251001
 *   bun run bench/run.ts --no-claude
 *
 * Needs a configured, tool-capable model (see `dawn auth`). This costs real API spend
 * and is non-deterministic — it is NOT a CI gate. Results are written to bench/results.json.
 */
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  Bus,
  buildRepoIndex,
  ContextStore,
  DawnAgent,
  loadCatalog,
  loadConfig,
  PermissionGate,
  SessionStore,
  selectInitialModel,
  withAllLiveModels,
  withLMStudio,
  withOllama,
} from "@dawn/core"
import { type BenchTask, TASKS } from "./tasks"

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

interface Flags {
  smoke: boolean
  reps: number
  tasks?: string[]
  model?: string
  /** Model id passed to `claude --model`; when set, the Claude column runs on any provider. */
  claudeModel?: string
  ref: string
  noClaude: boolean
  timeoutMs: number
}

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim()

function parseFlags(argv: string[]): Flags {
  const f: Flags = { smoke: false, reps: 3, ref: "HEAD", noClaude: false, timeoutMs: 180_000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--smoke") f.smoke = true
    else if (a === "--no-claude") f.noClaude = true
    else if (a === "--reps") f.reps = Math.max(1, Number(argv[++i]) || 1)
    else if (a === "--model") f.model = argv[++i]
    else if (a === "--claude-model") f.claudeModel = argv[++i]
    else if (a === "--ref") f.ref = argv[++i] ?? "HEAD"
    else if (a === "--tasks")
      f.tasks = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    else if (a === "--timeout") f.timeoutMs = Math.max(10_000, Number(argv[++i]) || 180_000)
  }
  if (f.smoke) f.reps = 1
  return f
}

function git(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", args, { cwd }).toString().trim()
}

/** Create a detached worktree at `sha`; returns its path and a cleanup fn. */
function makeWorktree(sha: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-bench-"))
  git(["worktree", "add", "--detach", "--force", dir, sha])
  return {
    dir,
    cleanup: () => {
      try {
        git(["worktree", "remove", "--force", dir])
      } catch {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {}
      }
    },
  }
}

function tmpDbPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dawn-bench-db-")), name)
}

async function runDawn(
  task: BenchTask,
  workdir: string,
  naive: boolean,
  modelRef: string,
  catalog: Awaited<ReturnType<typeof loadCatalog>>,
  config: ReturnType<typeof loadConfig>,
  timeoutMs: number,
): Promise<RunMetrics> {
  const bus = new Bus()
  const gate = new PermissionGate()
  gate.allowAll = true
  const store = new SessionStore(tmpDbPath("sessions.db"))
  const contextStore = new ContextStore(tmpDbPath("context.db"))
  let transcript = ""
  let steps = 0
  let errored = false
  let errorMsg: string | undefined
  bus.subscribe((ev) => {
    if (ev.type === "text-delta") transcript += ev.text
    else if (ev.type === "step-finish") steps += 1
    else if (ev.type === "error") {
      errored = true
      errorMsg = ev.message
    }
  })

  // Static repo index so Dawn's summary substitution is in play (naive ignores it).
  await buildRepoIndex(workdir, contextStore)
  const session = store.createSession(workdir, task.id)
  const agent = new DawnAgent({
    cwd: workdir,
    modelRef,
    bus,
    gate,
    catalog,
    config: { ...config, model: modelRef },
    store,
    sessionId: session.id,
    contextStore,
    naive,
  })

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await agent.send(task.prompt, controller.signal)
  } catch (err) {
    errored = true
    errorMsg = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
  }
  const ms = Date.now() - started
  const t = agent.ledger.totals()
  const success = !errored && task.check({ transcript, workdir })
  store.close()
  contextStore.close()
  return {
    inputTokens: t.inputTokens,
    cachedInputTokens: t.cachedInputTokens,
    outputTokens: t.outputTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    cost: t.cost,
    steps,
    ms,
    success,
    errored,
    error: errorMsg,
  }
}

/** Map a Dawn `anthropic/<id>` ref to a Claude Code `--model` value, or null if unsupported. */
function claudeModelFor(modelRef: string): string | null {
  return modelRef.startsWith("anthropic/") ? modelRef.slice("anthropic/".length) : null
}

function claudeAvailable(): boolean {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" })
  return r.status === 0
}

function runClaude(task: BenchTask, workdir: string, claudeModel: string, timeoutMs: number): RunMetrics {
  const started = Date.now()
  const r = spawnSync(
    "claude",
    ["-p", task.prompt, "--output-format", "json", "--model", claudeModel, "--dangerously-skip-permissions"],
    { cwd: workdir, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
  )
  const ms = Date.now() - started
  const empty: RunMetrics = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    steps: 0,
    ms,
    success: false,
    errored: true,
  }
  if (r.status !== 0 || !r.stdout) {
    return { ...empty, error: (r.stderr || "claude exited non-zero").slice(0, 300) }
  }
  try {
    const j = JSON.parse(r.stdout) as {
      result?: string
      total_cost_usd?: number
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    }
    const u = j.usage ?? {}
    const transcript = j.result ?? ""
    return {
      inputTokens: u.input_tokens ?? 0,
      cachedInputTokens: u.cache_read_input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      cost: j.total_cost_usd ?? 0,
      steps: 0,
      ms,
      success: task.check({ transcript, workdir }),
      errored: false,
    }
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "failed to parse claude json" }
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  let tasks = TASKS
  if (flags.tasks) tasks = tasks.filter((t) => flags.tasks?.includes(t.id))
  if (flags.smoke) tasks = tasks.slice(0, 2)
  if (tasks.length === 0) {
    console.error("no tasks selected")
    process.exit(1)
  }

  const config = loadConfig(REPO_ROOT)
  const catalog = await loadCatalog()
  await Promise.all([withOllama(catalog), withLMStudio(catalog)])
  await withAllLiveModels(catalog, config)
  const selection = selectInitialModel(catalog, config, { requestedModel: flags.model })
  if (!selection) {
    console.error("error: no live tool-capable model. Connect a provider or pass --model provider/model.")
    process.exit(1)
  }
  const modelRef = selection.ref
  const sha = git(["rev-parse", flags.ref])
  // Explicit --claude-model wins (any provider); otherwise derive from an anthropic/* Dawn model.
  const claudeModel = flags.claudeModel ?? claudeModelFor(modelRef)
  const useClaude = !flags.noClaude && claudeModel !== null && claudeAvailable()
  if (!flags.noClaude && claudeModel === null) {
    console.error(
      `note: skipping Claude Code column — model ${modelRef} is not anthropic/*; pass --claude-model <id> to run it on another provider.`,
    )
  } else if (!flags.noClaude && claudeModel !== null && !claudeAvailable()) {
    console.error("note: `claude` CLI not found on PATH — skipping Claude Code column.")
  }

  const modes: Mode[] = useClaude ? ["dawn", "naive", "claude"] : ["dawn", "naive"]
  console.error(
    `benchmark: ${tasks.length} task(s) × ${modes.join("/")} × ${flags.reps} rep(s) · model ${modelRef} · repo @ ${sha.slice(0, 8)}`,
  )

  const results: TaskResult[] = []
  for (const task of tasks) {
    const tr: TaskResult = { task: task.id, category: task.category, modes: {} }
    for (const mode of modes) {
      const reps: RunMetrics[] = []
      for (let r = 0; r < flags.reps; r++) {
        const wt = makeWorktree(sha)
        try {
          const m =
            mode === "claude"
              ? runClaude(task, wt.dir, claudeModel as string, flags.timeoutMs)
              : await runDawn(task, wt.dir, mode === "naive", modelRef, catalog, config, flags.timeoutMs)
          reps.push(m)
          const tag = m.success ? "ok" : m.errored ? "err" : "miss"
          console.error(
            `  ${task.id} · ${mode} · rep ${r + 1}: ${tag} · ↑${m.inputTokens} (${m.cachedInputTokens} cached) ↓${m.outputTokens} · $${m.cost.toFixed(4)}`,
          )
        } finally {
          wt.cleanup()
        }
      }
      tr.modes[mode] = reps
    }
    results.push(tr)
  }

  const out = {
    provenance: {
      generatedAt: new Date().toISOString(),
      gitSha: sha,
      gitShaShort: sha.slice(0, 8),
      model: modelRef,
      claudeModel: useClaude ? claudeModel : null,
      reps: flags.reps,
      taskCount: tasks.length,
      smoke: flags.smoke,
    },
    results,
  }
  const outPath = path.join(REPO_ROOT, "bench", "results.json")
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  console.error(`\nwrote ${outPath}`)
  console.error("run `bun run bench:report` to render the table.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
