import fs from "node:fs"
import path from "node:path"

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
 */
export interface BenchTask {
  id: string
  category: "read-heavy" | "diagnosis" | "edit"
  prompt: string
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

/** A read-heavy task: an explicit command that yields a large output + a lenient engagement check. */
const heavy = (id: string, prompt: string, ...needles: Array<string | string[]>): BenchTask => ({
  id,
  category: "read-heavy",
  prompt,
  check: ({ transcript }) => has(transcript, ...needles),
})

export const TASKS: BenchTask[] = [
  heavy(
    "cat-agent",
    "Use the bash tool to run `cat packages/core/src/agent/agent.ts`, then name three methods of the DawnAgent class.",
    ["send", "requestmessages", "initmcp", "contextstats", "setmodel", "resolvemcpservers", "compactout"],
  ),
  heavy(
    "cat-tools",
    "Use the bash tool to run `cat packages/core/src/tools/index.ts`, then list four tools it defines.",
    ["read", "bash", "grep", "edit", "write", "expand", "glob", "skill"],
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
    edits: true,
    prompt:
      "Read packages/core/src/context/budget.ts, then add an exported function `maxReadChars(mode: ContextMode): number` that returns `maxReadLines(mode) * 80`, placed right after maxReadLines.",
    check: ({ workdir }) =>
      fileHas(workdir, "packages/core/src/context/budget.ts", "maxreadchars", "maxreadlines(mode) * 80"),
  },
  {
    id: "edit-pkg-script",
    category: "edit",
    edits: true,
    prompt:
      'Read the root package.json, then add an npm script named "bench:hello" whose command is `echo hello`. Do not change any other script.',
    check: ({ workdir }) => fileHas(workdir, "package.json", "bench:hello", "echo hello"),
  },
]
