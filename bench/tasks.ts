import fs from "node:fs"
import path from "node:path"

export type BenchSlice = "trivial" | "investigate" | "edit" | "long"

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
  category: "read-heavy" | "diagnosis" | "edit" | "large-output" | "trivial"
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
]
