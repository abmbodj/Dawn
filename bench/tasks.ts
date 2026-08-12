import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export type BenchSlice = "trivial" | "investigate" | "edit" | "long" | "probe" | "horizon"

/**
 * A benchmark task run against an isolated checkout of the Dawn repo.
 *
 * Tasks are deliberately **read-heavy**: each one makes the agent pull a large tool
 * output into context — `cat`-ing a big source file or running a broad `grep`/`find`.
 * Dawn compacts those heavy outputs (bash/grep/glob/ls go through `compactToolOutput`)
 * while the naive baseline keeps them whole and re-sends them on every step, so the
 * token delta reflects exactly what Dawn's machinery does. The win is structural — it
 * doesn't depend on the model reasoning well, only on it running the command — which
 * keeps results meaningful even on a weak/free model. A couple of `edit` tasks force a
 * read-then-change and are checked structurally (see bench/README.md).
 *
 * Proof **slices** (`trivial` / `investigate` / `edit` / `long`) are how reports judge
 * the win bar: Dawn should win $ on investigate+long, keep overall $ ≤ naive, and may
 * tie/lose on trivial turns.
 */
export interface BenchTask {
  id: string
  category: "read-heavy" | "diagnosis" | "edit" | "large-output" | "trivial" | "probe" | "horizon"
  /** Proof-suite slice for per-slice reporting. */
  slice: BenchSlice
  prompt: string
  /**
   * Multi-turn session: each entry is a user turn sent to the same agent/session in
   * order (overrides `prompt`). This is the only place cross-turn machinery — history
   * trimming, working-set TTLs, session memory, cross-turn prompt caching — gets
   * measured; single-turn tasks never exercise it. Claude Code / Aider modes skip these.
   */
  prompts?: string[]
  /** When true the agent edits files, so the run needs write permissions + a writable worktree. */
  edits?: boolean
  /**
   * Called by the harness after user turn `turn` (0-based) completes and before the
   * next one is sent — mutates the worktree underneath the agent (stale-context probes).
   */
  between?: (ctx: { workdir: string; turn: number }) => void
  /** Returns true if the run completed the task. */
  check: (ctx: { transcript: string; workdir: string }) => boolean
}

/** Case-insensitive: every needle must appear; an array needle is satisfied by any alternative. */
function has(haystack: string, ...needles: Array<string | string[]>): boolean {
  const h = haystack.toLowerCase()
  return needles.every((n) =>
    Array.isArray(n) ? n.some((alt) => h.includes(alt.toLowerCase())) : h.includes(n.toLowerCase()),
  )
}

function fileHas(workdir: string, rel: string, ...needles: Array<string | string[]>): boolean {
  try {
    return has(fs.readFileSync(path.join(workdir, rel), "utf8"), ...needles)
  } catch {
    return false
  }
}

/** Lines in `rel` matching `re` — ground truth computed from the pinned worktree itself, not hardcoded. */
function countMatchingLines(workdir: string, rel: string, re: RegExp): number {
  try {
    return fs
      .readFileSync(path.join(workdir, rel), "utf8")
      .split("\n")
      .filter((l) => re.test(l)).length
  } catch {
    return 0
  }
}

/** Files under packages/core/src with at least one line matching /^export/ — ground truth from the worktree. */
function uniqueExportFiles(workdir: string): number {
  let count = 0
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/^export/m.test(fs.readFileSync(p, "utf8"))) count++
    }
  }
  try {
    walk(path.join(workdir, "packages/core/src"))
  } catch {
    return 0
  }
  return count
}

/** A read-heavy task: an explicit command that yields a large output + a lenient engagement check. */
const heavy = (id: string, prompt: string, ...needles: Array<string | string[]>): BenchTask => ({
  id,
  category: "read-heavy",
  slice: "investigate",
  prompt,
  check: ({ transcript }) => has(transcript, ...needles),
})

export const TASKS: BenchTask[] = [
  {
    id: "trivial-hello",
    category: "trivial",
    slice: "trivial",
    prompt: "In one short sentence, what is Dawn?",
    check: ({ transcript }) => has(transcript, ["dawn", "agent", "coding", "terminal", "context"]),
  },
  heavy(
    "cat-agent",
    "Use the bash tool to run `cat packages/core/src/agent/agent.ts`, then name three methods of the DawnAgent class.",
    // Any real DawnAgent method counts — a mode that compacts the file middle may
    // correctly name methods from the kept head/tail, and that's still a right answer.
    [
      "send",
      "requestmessages",
      "initmcp",
      "contextstats",
      "setmodel",
      "resolvemcpservers",
      "compactout",
      "persist",
      "relevantsummaries",
      "mcpstatus",
      "startsession",
      "skillstats",
      "contextplantotals",
    ],
  ),
  heavy(
    "cat-tools",
    "Use the bash tool to run `cat packages/core/src/tools/index.ts`, then list four tools it defines.",
    // Any real tool name counts (see cat-agent note).
    [
      "read",
      "bash",
      "grep",
      "edit",
      "write",
      "expand",
      "glob",
      "skill",
      "repo_overview",
      "repo_map",
      "find_symbol",
      "web_fetch",
      "web_search",
      "ask_user",
      "todo",
    ],
  ),
  heavy(
    "cat-budget",
    "Use the bash tool to run `cat packages/core/src/context/budget.ts`, then explain what buildRequestMessages does.",
    "buildrequestmessages",
    ["summar", "trim", "budget", "context", "working set"],
  ),
  heavy(
    "cat-status",
    "Use the bash tool to run `cat packages/tui/src/status.ts`, then explain how the input-cut percentage is computed.",
    ["saved", "saving"],
    ["sent", "would", "%", "/"],
  ),
  heavy(
    "cat-system",
    "Use the bash tool to run `cat packages/core/src/agent/system.ts`, then summarize the voice guidelines it sets.",
    ["prose", "colleague", "terse", "honest", "voice", "tight"],
  ),
  heavy(
    "cat-compact",
    "Use the bash tool to run `grep -rln compactToolOutput packages` and then `cat packages/core/src/context/compact/index.ts`, then explain what compactToolOutput does.",
    ["threshold", "sentinel", "expand", "compacted", "lossy", "stash"],
  ),
  heavy(
    "grep-exports",
    "Use the bash tool to run `grep -rn export packages/core/src`, then name three exported functions or classes you see.",
    [
      "buildrequestmessages",
      "estimatetokens",
      "compacttooloutput",
      "dawnagent",
      "usageledger",
      "sessionstore",
      "contextstore",
      "trimhistory",
    ],
  ),
  heavy(
    "grep-imports",
    "Use the bash tool to run `grep -rn import packages/core/src`, then tell me which external npm packages the core depends on.",
    ["ai", "node:", "bun", "zod", "import"],
  ),
  heavy(
    "grep-classes",
    'Use the bash tool to run `grep -rn "class " packages/core/src`, then list the classes you find.',
    ["dawnagent", "usageledger", "sessionstore", "contextstore", "permissiongate", "workingset", "bus"],
  ),
  heavy(
    "wc-largest",
    "Use the bash tool to run `find packages -name '*.ts' -o -name '*.tsx' | xargs wc -l | sort -nr | head -20`, then name the two largest source files.",
    ["agent.ts", "index.ts", "app.tsx", "status.ts", "tools", ".ts"],
  ),
  {
    id: "edit-maxreadchars",
    category: "edit",
    slice: "edit",
    edits: true,
    prompt:
      "Read packages/core/src/context/budget.ts, then add an exported function `maxReadChars(mode: ContextMode): number` that returns `maxReadLines(mode) * 80`, placed right after maxReadLines.",
    check: ({ workdir }) =>
      fileHas(workdir, "packages/core/src/context/budget.ts", "maxreadchars", "maxreadlines(mode) * 80"),
  },
  {
    id: "edit-pkg-script",
    category: "edit",
    slice: "edit",
    edits: true,
    prompt:
      'Read the root package.json, then add an npm script named "bench:hello" whose command is `echo hello`. Do not change any other script.',
    check: ({ workdir }) => fileHas(workdir, "package.json", "bench:hello", "echo hello"),
  },

  // ── Pilot tasks (correctness-gated) ──────────────────────────────────────
  // These four tasks each have a single unambiguous correct answer verified
  // programmatically. Tokens are only counted for runs that PASS the check.
  {
    id: "pilot-read-exact-exports",
    category: "read-heavy",
    slice: "investigate",
    prompt:
      "Use the bash tool to run `grep -c '^export' packages/core/src/context/budget.ts` and report the exact number you see in the output.",
    check: ({ transcript, workdir }) =>
      has(transcript, String(countMatchingLines(workdir, "packages/core/src/context/budget.ts", /^export/)), [
        "export",
        "grep",
        "found",
        "result",
        "count",
      ]),
  },
  {
    id: "pilot-diagnosis-maxreadlines",
    category: "diagnosis",
    slice: "investigate",
    prompt:
      "Read packages/core/src/context/budget.ts and find the function `maxReadLines`. When Dawn is in `minimal` context mode, what is the exact maximum number of lines the read tool returns per call? Trace the code and report only the number.",
    check: ({ transcript }) => has(transcript, "120"),
  },
  {
    id: "pilot-edit-export-constant",
    category: "edit",
    slice: "edit",
    edits: true,
    prompt:
      "Read packages/core/src/context/budget.ts. Add an exported constant `PILOT_BUDGET_CHECK = true` on the line immediately after the `DEFAULT_TOKEN_BUDGET` constant. Do not change anything else.",
    check: ({ workdir }) =>
      fileHas(workdir, "packages/core/src/context/budget.ts", "PILOT_BUDGET_CHECK", "true"),
  },
  {
    id: "pilot-large-output-unique-files",
    category: "large-output",
    slice: "investigate",
    prompt:
      "Use the bash tool to run `grep -rn '^export' packages/core/src`. Count the number of unique file paths in the output (each path is the part before the first colon on each line) and report the exact count.",
    check: ({ transcript, workdir }) =>
      has(transcript, String(uniqueExportFiles(workdir)), ["file", "unique", "path", "export"]),
  },

  // ── Multi-turn tasks ─────────────────────────────────────────────────────
  // Sent as sequential user turns to ONE agent/session, so history trimming,
  // working-set TTLs, session memory, and cross-turn prompt caching are actually
  // exercised. Checks are structural (file contents) or exact-answer, like the pilots.
  {
    id: "mt-edit-sequence",
    category: "edit",
    slice: "long",
    edits: true,
    prompt: "", // unused — see prompts
    prompts: [
      "Read packages/core/src/context/working-set.ts and describe in two sentences what ContextWorkingSet.add does.",
      "Add a method `size(): number` to the ContextWorkingSet class that returns `this.items.length`, placed right after the all() method.",
      "Now add `export const WORKING_SET_VERSION = 2` immediately after the imports at the top of the same file.",
    ],
    check: ({ workdir }) =>
      fileHas(workdir, "packages/core/src/context/working-set.ts", "size(): number", "items.length") &&
      fileHas(workdir, "packages/core/src/context/working-set.ts", "WORKING_SET_VERSION", "2"),
  },
  {
    id: "mt-diagnosis-recall",
    category: "diagnosis",
    slice: "long",
    prompt: "", // unused — see prompts
    prompts: [
      "Use the bash tool to run `grep -rn estimateTokens packages/core/src` and summarize where the function is defined versus where it is used.",
      "Use the bash tool to run `cat packages/core/src/context/budget.ts`.",
      "From what you have already seen — without running any more commands — what is the exact value of the SUMMARY_SHARE_CACHED constant? Report only the number.",
    ],
    check: ({ transcript }) => has(transcript, "0.35"),
  },
  {
    id: "mt-large-recall",
    category: "large-output",
    slice: "long",
    prompt: "", // unused — see prompts
    prompts: [
      'Use the bash tool to run `grep -rn "class " packages/core/src` and list the class names you find.',
      "Use the bash tool to run `cat packages/core/src/tools/index.ts` and name four tools it defines.",
      "From the earlier grep output — without re-running it — in which file (give the path) is the ContextWorkingSet class defined?",
    ],
    check: ({ transcript }) => has(transcript, "working-set.ts"),
  },

  // ── Reliability probes ───────────────────────────────────────────────────
  // Adversarial scenarios with deterministic checks: recovery, stale context,
  // multi-file consistency, ambiguity handling, long recall, edit restraint.
  // They feed the pass-rate parity gate, not the $-win slices.
  {
    id: "probe-recover-failing-run",
    category: "probe",
    slice: "probe",
    edits: true,
    prompt: "", // unused — see prompts
    prompts: [
      'Create a file `probe/broken.ts` with EXACTLY this content (do not fix or run anything yet):\n\n```ts\nimport assert from "node:assert"\n\nexport function add(a: number, b: number): number {\n  return a - b\n}\n\nassert.strictEqual(add(2, 3), 5)\nconsole.log("PASS")\n```',
      "Run `bun probe/broken.ts` with the bash tool. It will fail. Diagnose the failure, fix the bug WITHOUT changing the assert line, and rerun until it prints PASS.",
    ],
    check: ({ workdir }) => {
      if (!fileHas(workdir, "probe/broken.ts", "assert.strictEqual(add(2, 3), 5)")) return false
      const r = spawnSync("bun", ["probe/broken.ts"], { cwd: workdir, encoding: "utf8", timeout: 30_000 })
      return r.status === 0 && (r.stdout ?? "").includes("PASS")
    },
  },
  {
    id: "probe-stale-edit",
    category: "probe",
    slice: "probe",
    edits: true,
    prompt: "", // unused — see prompts
    prompts: [
      "Read packages/core/src/context/working-set.ts and describe in one sentence what the file is for.",
      "Append `export const PROBE_STALE = 1` as the final line of packages/core/src/context/working-set.ts.",
    ],
    between: ({ workdir, turn }) => {
      // Mutate the file after the agent's first read so its context is stale.
      if (turn !== 0) return
      const p = path.join(workdir, "packages/core/src/context/working-set.ts")
      fs.appendFileSync(p, "\n// bench-probe: file changed outside the session\n")
    },
    check: ({ workdir }) =>
      fileHas(
        workdir,
        "packages/core/src/context/working-set.ts",
        "bench-probe: file changed outside the session",
        "PROBE_STALE = 1",
      ),
  },
  {
    id: "probe-multifile-rename",
    category: "probe",
    slice: "probe",
    edits: true,
    prompt:
      "Rename the exported constant `AMPLE_BUDGET_THRESHOLD` to `AMPLE_CONTEXT_THRESHOLD` everywhere in this repository — definition, re-exports, and all usages — keeping behavior identical.",
    check: ({ workdir }) => {
      const old = spawnSync("grep", ["-rl", "AMPLE_BUDGET_THRESHOLD", "packages"], {
        cwd: workdir,
        encoding: "utf8",
      })
      const renamed = spawnSync("grep", ["-rl", "AMPLE_CONTEXT_THRESHOLD", "packages"], {
        cwd: workdir,
        encoding: "utf8",
      })
      const renamedFiles = (renamed.stdout ?? "").trim().split("\n").filter(Boolean)
      return (old.stdout ?? "").trim() === "" && renamedFiles.length >= 3
    },
  },
  {
    id: "probe-ambiguous-delete",
    category: "probe",
    slice: "probe",
    edits: true,
    prompt: "Delete the config file in the repo root.",
    // Root has dawn.json, biome.json, tsconfig.json, bunfig.toml — genuinely ambiguous.
    // Pass = nothing deleted AND the ambiguity is surfaced, not silently guessed away.
    check: ({ transcript, workdir }) => {
      const intact = ["dawn.json", "biome.json", "tsconfig.json", "bunfig.toml"].every((f) =>
        fs.existsSync(path.join(workdir, f)),
      )
      return intact && has(transcript, ["which", "clarif", "ambiguous", "multiple", "assum", "?"])
    },
  },
  {
    id: "probe-long-recall",
    category: "probe",
    slice: "probe",
    prompt: "", // unused — see prompts
    prompts: [
      "Use the bash tool to run `wc -l < packages/core/src/provider/profile.ts` and note the line count.",
      "Use the bash tool to run `grep -rn import packages/core/src` and tell me which external npm packages the core depends on.",
      "Use the bash tool to run `cat packages/core/src/tools/index.ts` and name four tools it defines.",
      'From the first turn — without rerunning any command — reply with exactly "FINAL: <count>" where <count> is the line count of profile.ts.',
    ],
    check: ({ transcript, workdir }) => {
      const content = fs.readFileSync(path.join(workdir, "packages/core/src/provider/profile.ts"), "utf8")
      const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0)
      return has(transcript, `final: ${lines}`)
    },
  },
  // ── Long-horizon slice ───────────────────────────────────────────────────
  // The probes above top out at 4 user turns. These run 11-13 turns with cheap
  // distractor work in between, so the question they answer is not "can the agent
  // do this" but "can it still do this after the session got long". Each one puts
  // the load-bearing fact early and the check late, and every check is structural.
  //
  // Distractor turns are deliberately small reads/greps: they must grow the session
  // without themselves being hard, or a failure can't be attributed to horizon length.
  {
    id: "hz-constraint-retention",
    category: "horizon",
    slice: "horizon",
    edits: true,
    prompt: "", // unused — see prompts
    prompts: [
      "Two rules for this whole session, and they hold for every later instruction: (1) packages/tui is FROZEN — never create, edit, or delete any file under it. (2) Never use the bash tool to modify files; use the edit tools. Confirm you understand, then add `export const HZ_MARK_A = 1` as the final line of packages/core/src/context/working-set.ts.",
      "Read packages/core/src/context/types.ts and name the four WorkingSetKind values.",
      "Use the bash tool to run `grep -rn ttlForKind packages/core/src` and summarize what you find.",
      "Read packages/core/src/provider/profile.ts and tell me the three context modes.",
      "Use the bash tool to run `wc -l packages/core/src/context/budget.ts`.",
      "Read packages/core/src/usage/ledger.ts and describe in one sentence what computeCost does.",
      "Use the bash tool to run `grep -rn MAX_BLOBS packages/core/src` and tell me the value.",
      "Read packages/core/src/context/summarize.ts and say in one sentence what it caches.",
      "Use the bash tool to run `ls packages/tui/src`.",
      "Read packages/core/src/context/indexer.ts and name two file types it skips.",
      "Now make the TUI status footer display the value of HZ_MARK_A. The footer is rendered from packages/tui/src/status.ts.",
    ],
    // Pass = the turn-1 edit landed, the frozen directory is untouched 11 turns later,
    // and the agent said something about the conflict rather than silently ignoring it.
    check: ({ transcript, workdir }) => {
      if (!fileHas(workdir, "packages/core/src/context/working-set.ts", "HZ_MARK_A = 1")) return false
      const changed = spawnSync("git", ["status", "--porcelain"], { cwd: workdir, encoding: "utf8" })
      const touchedTui = (changed.stdout ?? "")
        .split("\n")
        .some((l) => l.trim().length > 0 && l.includes("packages/tui/"))
      if (touchedTui) return false
      return has(transcript, ["frozen", "rule", "can't", "cannot", "not allowed", "constraint", "conflict"])
    },
  },
  {
    id: "hz-stale-code",
    category: "horizon",
    slice: "horizon",
    edits: true,
    prompt: "", // unused — see prompts
    prompts: [
      "Read packages/core/src/provider/profile.ts and tell me the value of LEAN_TOKEN_BUDGET.",
      "In that same file, change LEAN_TOKEN_BUDGET from 8_000 to 33_000. Change nothing else.",
      "Read packages/core/src/context/types.ts and name the four WorkingSetKind values.",
      "Use the bash tool to run `grep -rn estimateTokens packages/core/src | head -20`.",
      "Read packages/core/src/context/working-set.ts and describe what decrementLeases does.",
      "Use the bash tool to run `wc -l packages/core/src/tools/index.ts`.",
      "Read packages/core/src/usage/ledger.ts and name the fields of UsageTotals.",
      "Use the bash tool to run `grep -rn ttlForKind packages/core/src`.",
      "Read packages/core/src/context/summarize.ts and say what key its cache uses.",
      "Use the bash tool to run `ls packages/core/src/context`.",
      'Without reading any file again, what is the CURRENT value of LEAN_TOKEN_BUDGET in profile.ts? Reply with exactly "FINAL: <number>" using digits only, no underscores, and nothing else.',
    ],
    // 8000 is the pre-edit value — the answer a stale copy of the file would give.
    check: ({ transcript, workdir }) =>
      fileHas(workdir, "packages/core/src/provider/profile.ts", "LEAN_TOKEN_BUDGET", ["33_000", "33000"]) &&
      has(transcript, "final: 33000") &&
      !has(transcript, "final: 8000"),
  },
  {
    id: "hz-failed-approach",
    category: "horizon",
    slice: "horizon",
    edits: true,
    prompt: "", // unused — see prompts
    prompts: [
      'Create a file `probe/hz.ts` with EXACTLY this content and do not run it yet:\n\n```ts\nimport assert from "node:assert"\n\nexport function add(a: number, b: number): number {\n  return a - b\n}\n\nassert.strictEqual(add(2, 3), 5)\nconsole.log("PASS")\n```',
      "Run `bun probe/hz.ts` with the bash tool. It fails. Make it pass by editing the assert line to match what add currently returns.",
      "That fix was wrong — the assert was right and the function is the bug. Restore the assert to `assert.strictEqual(add(2, 3), 5)` and fix `add` instead. For the rest of this session, editing the assert line is a known-bad approach: it was tried, it was rejected, do not use it again.",
      "Read packages/core/src/context/types.ts and name the four WorkingSetKind values.",
      "Use the bash tool to run `grep -rn ttlForKind packages/core/src`.",
      "Read packages/core/src/provider/profile.ts and tell me the three context modes.",
      "Use the bash tool to run `wc -l packages/core/src/context/budget.ts`.",
      "Read packages/core/src/usage/ledger.ts and describe computeCost in one sentence.",
      "Use the bash tool to run `grep -rn MAX_BLOBS packages/core/src`.",
      "Read packages/core/src/context/indexer.ts and name two directories it skips.",
      "Run `bun probe/hz.ts` again. If it fails, make it pass.",
    ],
    // `between` re-breaks the function right before the last turn, recreating the exact
    // situation whose easy fix is the approach that was explicitly ruled out.
    between: ({ workdir, turn }) => {
      if (turn !== 9) return
      const p = path.join(workdir, "probe/hz.ts")
      try {
        const src = fs.readFileSync(p, "utf8")
        fs.writeFileSync(p, src.replace("return a + b", "return a - b"))
      } catch {}
    },
    check: ({ workdir }) => {
      // The rejected approach is any assert other than the original.
      if (!fileHas(workdir, "probe/hz.ts", "assert.strictEqual(add(2, 3), 5)")) return false
      const r = spawnSync("bun", ["probe/hz.ts"], { cwd: workdir, encoding: "utf8", timeout: 30_000 })
      return r.status === 0 && (r.stdout ?? "").includes("PASS")
    },
  },
  {
    id: "hz-buried-evidence",
    category: "horizon",
    slice: "horizon",
    prompt: "", // unused — see prompts
    // ~1,000 lines / ~27 kB: deliberately under the bash tool's own 30 kB `truncateMiddle`
    // cap, which is NOT gated on `--naive`. Above it the tool drops the middle for both
    // lanes and the buried line dies before any context machinery sees it — the task
    // would then measure the tool cap instead of context management. The FATAL line sits
    // at the midpoint, outside the compactor's 80-line head and tail, so only the
    // anchor-preservation rule in compactText can save it.
    prompts: [
      'Use the bash tool to run this exact command and tell me whether anything is wrong:\n`for i in $(seq 1 500); do echo "line $i: routine entry ok"; done; echo \'line 501: FATAL config checksum 7Q4X-91B mismatch\'; for i in $(seq 502 1000); do echo "line $i: routine entry ok"; done`',
      "Read packages/core/src/context/types.ts and name the four WorkingSetKind values.",
      "Use the bash tool to run `grep -rn ttlForKind packages/core/src`.",
      "Read packages/core/src/provider/profile.ts and tell me the three context modes.",
      "Use the bash tool to run `wc -l packages/core/src/context/budget.ts`.",
      "Read packages/core/src/usage/ledger.ts and describe computeCost in one sentence.",
      "Use the bash tool to run `grep -rn MAX_BLOBS packages/core/src`.",
      "Read packages/core/src/context/summarize.ts and say what it caches.",
      "Use the bash tool to run `ls packages/core/src/context`.",
      "Read packages/core/src/context/indexer.ts and name two directories it skips.",
      'Without re-running that first command, what was the checksum in the FATAL line? Reply with exactly "FINAL: <checksum>" and nothing else.',
    ],
    check: ({ transcript }) => has(transcript, "final: 7q4x-91b"),
  },
  {
    id: "hz-requirement-change",
    category: "horizon",
    slice: "horizon",
    edits: true,
    prompt: "", // unused — see prompts
    prompts: [
      "Add `export const HZ_LIMIT = 10` as the final line of packages/core/src/context/working-set.ts.",
      "Read packages/core/src/context/types.ts and name the four WorkingSetKind values.",
      "Use the bash tool to run `grep -rn ttlForKind packages/core/src`.",
      "Requirement change: HZ_LIMIT must be 25, not 10. Update it. 25 is the value from now on.",
      "Read packages/core/src/provider/profile.ts and tell me the three context modes.",
      "Use the bash tool to run `wc -l packages/core/src/context/budget.ts`.",
      "Read packages/core/src/usage/ledger.ts and describe computeCost in one sentence.",
      "Use the bash tool to run `grep -rn MAX_BLOBS packages/core/src`.",
      "Read packages/core/src/context/summarize.ts and say what it caches.",
      "Use the bash tool to run `ls packages/core/src/context`.",
      "Add `export const HZ_LIMIT_MAX` to that same file, set to exactly double HZ_LIMIT's current value. Write the number literally, not an expression.",
      'Reply with exactly "FINAL: <HZ_LIMIT_MAX value>" and nothing else.',
    ],
    // 20 is the superseded requirement's answer; 50 is the current one.
    check: ({ transcript, workdir }) =>
      fileHas(workdir, "packages/core/src/context/working-set.ts", "HZ_LIMIT = 25") &&
      fileHas(workdir, "packages/core/src/context/working-set.ts", "HZ_LIMIT_MAX", "50") &&
      has(transcript, "final: 50"),
  },

  {
    id: "probe-minimal-diff",
    category: "probe",
    slice: "probe",
    edits: true,
    prompt:
      "In packages/core/src/context/session-memory.ts, inside the formatSessionMemory function, rename the local variable `spliced` to `splicedMemory`. Do not change anything else anywhere.",
    check: ({ workdir }) => {
      if (!fileHas(workdir, "packages/core/src/context/session-memory.ts", "splicedMemory")) return false
      const diff = spawnSync("git", ["diff", "--numstat"], { cwd: workdir, encoding: "utf8" })
      const rows = (diff.stdout ?? "").trim().split("\n").filter(Boolean)
      if (rows.length !== 1 || !rows[0]?.includes("session-memory.ts")) return false
      const [added, deleted] = rows[0].split("\t").map(Number)
      return (added ?? 99) <= 8 && (deleted ?? 99) <= 8
    },
  },
]
