# Dawn

**A token-frugal AI coding agent for the terminal.**

[![CI](https://github.com/abmbodj/Dawn/actions/workflows/ci.yml/badge.svg)](https://github.com/abmbodj/Dawn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Dawn is an early Bun + TypeScript monorepo for running an AI coding agent from your shell. It has an
interactive terminal UI, a one-shot `dawn run` mode, multi-provider model selection, persisted and
resumable sessions, and permission prompts for side-effecting tools.

The thing that makes Dawn *Dawn* is the part most agents skip: it treats your context window as a
budget to spend carefully, not a bucket to refill every turn — and it shows you, live, exactly what
that saved.

> Dawn is open-source (MIT) and public, but still early-stage (`0.1.0`). The `"private": true` in
> `package.json` is intentional — Dawn isn't published to npm yet, so install it from source as shown in
> [Quickstart](#quickstart). Treat this README as developer-facing setup and usage documentation, not a
> stability or registry promise.

---

## Why Dawn

Most coding agents resend the world on every turn: whole files re-read from scratch, the entire
conversation replayed, large tool outputs pasted in verbatim. Input tokens dominate the bill, and you
pay for them again and again.

Dawn does the opposite. Before each turn it **plans** a compact context that fits a token budget:
summaries instead of full files, recent history instead of all of it, tool results that expire after a
few turns, and prompt caching where the provider supports it. Where other agents front-load tens of
thousands of tokens of project context on every request, Dawn builds it on demand — and
[measured against Claude Code](#benchmark), that difference is **2–4× cheaper per task at equal
correctness**.

---

## How Dawn saves tokens

Every mechanism below lives in the code, not in a pitch deck. Together they're what keeps Dawn's
per-turn input small.

### 1. A per-turn context budget and planner
Before each request, `buildRequestMessages`
([packages/core/src/context/budget.ts](packages/core/src/context/budget.ts)) packs the prompt to fit a
token budget — **8,000 tokens by default** (`--budget`) — in one of three modes (`--context`):

| Mode | Read cap / call | Working-set TTLs | Summary TTL |
| --- | --- | --- | --- |
| `minimal` | 120 lines | shortest | 6 turns |
| `balanced` *(default)* | 240 lines | medium | 10 turns |
| `deep` | 600 lines | longest | 14 turns |

Allocation order is system prompt → summaries (capped at 35% of what's left) → recent history →
working set. Anything that doesn't fit is trimmed by priority before the request goes out.

### 2. Summaries instead of full files
Dawn indexes the repo and stores a compact summary per file — language, defined symbols, imports, and
a short excerpt ([context/summarize.ts](packages/core/src/context/summarize.ts)). When a file is
relevant, Dawn sends the summary instead of re-reading the source, and counts the difference as
**substitution savings** (`sourceTokens − tokenEstimate`). Summaries are cached in SQLite keyed by file
hash ([context/store.ts](packages/core/src/context/store.ts)), so an unchanged file is never
re-summarized.

### 3. A working set with TTL leases
Loaded files, file ranges, and tool results live in a working set
([context/working-set.ts](packages/core/src/context/working-set.ts)) where each item holds a TTL lease
that ages out every turn (`decrementLeases`). Tool results survive ~1–3 turns, file loads ~1–4, and
summaries ~6–14, depending on mode. When the budget is tight, items are dropped by priority —
`summary > file-range > file > tool-result` — so the cheapest, most reusable context stays and the
bulky transient context goes.

### 4. Atomic history trimming
Old conversation turns are dropped once they exceed the history budget, while the latest user turn is
always kept (`trimHistory`/`groupHistory` in budget.ts). Tool-call/tool-result pairs are trimmed as a
unit, which both saves tokens and avoids the orphaned-pair `400`s that OpenAI-compatible providers
return.

### 5. Bounded reads
The read tool caps how much it pulls per call by mode — 120 / 240 / 600 lines
([tools/index.ts](packages/core/src/tools/index.ts)) — and every read enters the working set, so the
model has what it needs without re-fetching the same file next turn.

### 6. Content-aware output compaction (reversible)
Large tool outputs are the biggest token sink in a coding agent — a single `bash`, `grep`, or
`web_fetch` can dwarf the rest of the prompt, and it's re-sent on every step of a multi-step turn. Dawn
routes each heavy tool output through a compaction engine
([context/compact/](packages/core/src/context/compact/)) that detects its shape and shrinks it
accordingly: JSON arrays keep their keys and head/tail items while the redundant middle is elided
(SmartCrusher-style), repetitive logs collapse identical lines into `(×N)`, grep results are grouped and
capped per file, and free text keeps an anchor-aware head+tail with error lines preserved. An
**inflation guard** reverts to the original whenever compaction wouldn't actually help, and aggressiveness
follows the context mode.

Compaction is **reversible**: the full original is stashed in SQLite and the compacted output ends with an
`«expand:HASH …»` marker. When the model genuinely needs the elided detail it calls the **`expand`** tool
— optionally narrowed by regex or line range — instead of re-running the command, so Dawn compacts
aggressively without ever losing information. (`truncateMiddle`/`capLine` in
[tools/truncate.ts](packages/core/src/tools/truncate.ts) remain the upstream char-level hard caps.)

### 7. Prompt caching (Anthropic)
The system prompt is kept stable across a session
([agent/system.ts](packages/core/src/agent/system.ts)) and the compact context message is inserted
right *before* the latest user turn, so it doesn't invalidate the cached prefix. A moving cache
breakpoint (`withMovingAnthropicBreakpoint`) extends the cached span each turn, and cached input is
billed at the cache-read rate (`computeCost` in [usage/ledger.ts](packages/core/src/usage/ledger.ts)).

### 8. Terse answer-style guidance
Dawn classifies each message (question / change / other) and injects output-shaping guidance
([agent/answer-style.ts](packages/core/src/agent/answer-style.ts)): lead with the answer, cite
`path:line`, skip file-by-file dumps. Smaller, sharper replies mean fewer output tokens too.

### 9. Zero-cost token estimation
All budgeting uses a local estimate (`estimateTokens = ceil(chars / 4)`) — no metering API calls just
to decide what to send.

---

## The stats Dawn shows you

Because Dawn plans context explicitly, it can measure the result. Three commands surface it:

- **`/context`** — current budget and mode, what's loaded right now, cached summaries, repo-index size,
  estimated tokens saved, and tool outputs compacted this session.
- **`/usage`** — per-model `↑input ↓output`, cache reads/writes, cost, average input per turn, and the
  highest-cost turn.
- **`/savings`** — the headline report, across **session / project / lifetime** scopes. Plans are
  persisted to SQLite (`recordContextPlan`) and aggregated (`contextPlanTotals`), so lifetime numbers
  survive restarts.

The baseline Dawn compares against is stated in the report itself: **"reading full files, no prompt
caching."** The numbers come from these formulas (all in
[packages/tui/src/status.ts](packages/tui/src/status.ts)):

```text
saved        = trim + substitution (summaries) + tool-output compaction
input cut %  = saved / (sent + saved)
would send   = sent input + saved
est $ saved  = saved × input_price / 1M
cache $ saved = cached_input × (input_price − cache_read_price) / 1M
```

### Sample `/savings` output

```text
Savings (estimated)
Baseline: reading full files, full history, no prompt caching
Note: these are model-based estimates (chars÷4). For measured numbers: `bun run bench`
Pricing: input $3.00 / 1M tokens, cache read $0.300 / 1M tokens

Session:
  est. saved: 16,900 tokens
    summaries + trim: 12,400 tokens
    tool-output compaction: 4,500 tokens
  est. input cut: ~73% vs naive baseline
  Dawn sent: 6.2k input
  est. would send (naive): 23.1k input
  est. $ saved: $0.051
  cache $ saved: $0.108
  context plans: 14
  context items: 53 included / 21 skipped
  highest-saving turn: 4,800 tokens saved (7.4k / 8.0k, balanced)
```

> **Illustrative only.** The figures above are plugged into Dawn's real formulas to show the shape of
> the report — they are not a benchmark. Your actual numbers depend on your repo, model, and mode.
> The `est.` prefix on each line is a reminder that `/savings` uses a local `chars÷4` estimate of what
> a hypothetical naive agent would have sent; for *measured*, head-to-head numbers, see
> [Benchmark](#benchmark) below. Dollar savings appear only when the selected model has pricing data.

---

## Benchmark

The headline is **cost, not raw token count.** Dawn's context-planning machinery adds overhead compared
to a bare agent with no context management — but it caches that overhead aggressively, so it costs
less. Against Claude Code, the gap is wider still: Claude Code front-loads 20–65 K tokens of project
context per request regardless of task size; Dawn builds it on demand.

The table below comes from a committed harness ([bench/](bench/)) that runs four correctness-gated
tasks — one per workload category — against an isolated checkout at a pinned SHA. Every run uses the
same model, and tokens are counted only for runs that **pass a verifiable check** (exact numeric
answer or file content assertion). Three modes are compared: **Dawn** (balanced, all context
management on), **`--naive`** (the identical agent with summaries, trimming, compaction, and caching
off — mechanism isolation), and **Claude Code** (`claude` CLI, same model class, indicative only).

**What the data shows:**
- Dawn uses **more raw input tokens than `--naive`** on all task sizes (11–37% more): repo summaries
  and working-set metadata add overhead that a single-step agent skips.
- That overhead is heavily cached (60–65% cache hit rate vs 40–57% for naive), making Dawn
  **cost-neutral to cheaper** than naive on multi-step tasks like edits and diagnosis.
- Against **Claude Code**, Dawn is **2–4× cheaper per task** across every category, because Claude
  Code's upfront project context (22–67 K cached tokens) dominates cost even for simple queries.
- The correctness gate caught a real failure: `--naive` gave a wrong file count on the large-output
  task (rep 2 miss) while Dawn got it right both times — output compaction grouped the results by file,
  making the count easier for the model.

<!-- BENCH:START -->
**Across 4 comparable task(s) at equal success, Dawn used a median 18% more input tokens (caching discount offsets cost) and 1% less cost than the naive baseline (pooled: +24% tokens vs naive, −3% cost).**



### read-heavy

_read-heavy: median **21% more input tokens**, **20% more cost** (1 task(s) at equal success)_

| Task (pass rate) | Dawn input (cached) | Naive input | Input ↓ | Dawn $ | Naive $ | Cost ↓ | Claude input | Claude $ |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| pilot-read-exact-exports (d:2/2 n:2/2) | 11,100 (5,469) | 9,161 | +21% | $0.0066 | $0.0056 | +20% | 18 (c:2/2) | $0.0256 |

### diagnosis

_diagnosis: median **15% more input tokens** (caching discount offsets cost), **21% less cost** (1 task(s) at equal success)_

| Task (pass rate) | Dawn input (cached) | Naive input | Input ↓ | Dawn $ | Naive $ | Cost ↓ | Claude input | Claude $ |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| pilot-diagnosis-maxreadlines (d:2/2 n:2/2) | 14,213 (5,319) | 12,320 | +15% | $0.0103 | $0.0130 | −21% | 18 (c:2/2) | $0.0285 |

### edit

_edit: median **11% more input tokens** (caching discount offsets cost), **21% less cost** (1 task(s) at equal success)_

| Task (pass rate) | Dawn input (cached) | Naive input | Input ↓ | Dawn $ | Naive $ | Cost ↓ | Claude input | Claude $ |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| pilot-edit-export-constant (d:2/2 n:2/2) | 22,640 (13,713) | 20,474 | +11% | $0.0121 | $0.0153 | −21% | 26 (c:2/2) | $0.0337 |

### large-output

_large-output: median **37% more input tokens**, **20% more cost** (1 task(s) at equal success)_

| Task (pass rate) | Dawn input (cached) | Naive input | Input ↓ | Dawn $ | Naive $ | Cost ↓ | Claude input | Claude $ |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| pilot-large-output-unique-files (d:2/2 n:1/2) | 42,548 (27,158) | 31,077 | +37% | $0.0196 | $0.0163 | +20% | 22 (c:2/2) | $0.0393 |



_Measured by github-copilot/claude-haiku-4.5, Claude Code on claude-haiku-4-5-20251001, Dawn repo @ 8da4a648, 2 rep(s)/task (median), 2026-06-23._


_The Claude Code column is **indicative, not apples-to-apples**: same model and task, but a different agent (its own system prompt, tools, and loop). The rigorous comparison is Dawn vs. `--naive` — the identical agent with context management turned off. ⚠️ marks tasks where a mode did not pass its correctness check; those are excluded from the medians._


```bash
# Reproduce (requires Anthropic key + `claude` CLI for the Claude column):
bun run bench        # real API spend, non-deterministic
bun run bench:report # regenerate this table

# Free local verification of the mechanism delta (Dawn vs --naive only):
bun run bench --no-claude --model ollama/<model>   # or groq/<model>
```
<!-- BENCH:END -->

> **Table sign convention:** `Input ↓` and `Cost ↓` show the reduction from naive to Dawn. A `−` prefix
> means Dawn used less (better); a `+` prefix means Dawn used more. Raw token counts favor naive on
> short tasks; cost favors Dawn on tasks where its caching advantage kicks in.

`--naive` is a real, shippable mode (`dawn run --naive "…"`), so the mechanism comparison is
reproducible by anyone on a free local model. The harness is deliberately **not** a CI gate: it costs
real API budget and is non-deterministic, so the numbers are representative and reproducible via the
harness, not exact. Methodology, success checks, and the two-tier reproduction guide live in
[bench/README.md](bench/README.md).

---

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer.
- A terminal that can run the OpenTUI interface.
- At least one connected model provider — an API key or a reachable Ollama server.

## Quickstart

Install dependencies and link the local `dawn` command:

```sh
bun install
bun run setup
```

Start the interactive agent in the current directory:

```sh
dawn
```

If the command isn't linked yet, run it through Bun:

```sh
bun run dawn
```

Add an API key for a provider, then list available models:

```sh
dawn auth login groq
dawn models
```

Run a one-shot prompt:

```sh
dawn run "summarize this repository"
```

## CLI reference

```text
dawn                        Start an interactive session in the current directory.
dawn -c, --continue         Resume the most recent session for this directory.
dawn -m, --model <ref>      Use a model reference like provider/model.
dawn --cwd <path>           Run against a different working directory.
dawn --budget <tokens>      Cap estimated prompt tokens (default 8000).
dawn --context <mode>       Context planning: minimal, balanced (default), or deep.
dawn run "<prompt>"         Run a one-shot non-interactive prompt.
dawn run --yolo "<prompt>"  Allow read, write, edit, and bash tools without prompts.
dawn index                  Build or refresh the repository context index.
dawn auth login <provider>  Store an API key for a provider.
dawn auth list              Show providers with stored API keys.
dawn auth logout <provider> Remove a stored API key.
dawn models [provider]      List known tool-capable models for connected providers.
dawn --version              Print the current Dawn version.
dawn --help                 Print command help.
```

`--budget` and `--context` are the two dials on the savings/quality tradeoff: a smaller budget or
`minimal` mode sends less context (cheaper, less grounded); `deep` sends more (pricier, more
thorough). Model references use the `provider/model` format:

```sh
dawn --model anthropic/claude-opus-4-8
dawn --model groq/meta-llama/llama-4-scout-17b-16e-instruct
```

In `dawn run`, reads are pre-allowed; write/edit/bash are denied unless `--yolo` is passed. In the
interactive TUI, Dawn asks before any side-effecting tool runs.

## Interactive commands

Inside the TUI, submit these slash commands in the prompt:

```text
/model      Switch model across connected providers.
/plan-model Set the model used while in plan mode.
/connect    Connect a model provider (API key or GitHub OAuth).
/init       Scan the repo and generate an AGENTS.md with project conventions.
/context    Show context budget, working set, and savings.
/usage      Show token and cost breakdown for this session.
/savings    Show session, project, and lifetime token savings.
/new        Start a fresh session.
/clear      Clear the visible transcript while keeping the conversation.
/reset      Wipe all Dawn data and return to the setup wizard.
/help       Show TUI help.
/quit       Exit Dawn (alias: /exit).
```

Type `/` to open command autocomplete: Up/Down navigate, Tab completes, Enter runs, Esc closes.

Keyboard shortcuts:

```text
Shift+Tab  Cycle permission mode (normal / auto-edit / plan).
Esc        Interrupt a running turn or close an active picker.
Ctrl+C     Quit.
```

When Dawn requests a tool permission:

```text
y        Allow once.
a        Always allow that tool for this session.
n/Esc    Deny.
```

## Providers

Dawn ships built-in metadata for Anthropic, OpenAI, Google, Groq, xAI, Mistral, DeepSeek, Perplexity,
Together AI, Fireworks AI, Cerebras, OpenRouter, and Ollama (when a local Ollama server is detected,
including RAM-fit warnings for large local models).

Credentials can come from Dawn's auth store or from each provider's environment variables, such as
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, or `GITHUB_COPILOT_TOKEN`.
For GitHub Copilot, `dawn auth login github-copilot` uses GitHub device authorization, opens the
default browser when possible, and falls back to storing a pasted Copilot token if no OAuth client id
is available.

The model catalog is loaded from cache, refreshed from `models.dev` when reachable, and falls back to
an embedded catalog so the agent still boots offline.

## Configuration

Dawn merges global configuration with project configuration:

```text
Global config     ~/.config/dawn/config.json
Project config    dawn.json
Stored auth       ~/.local/share/dawn/auth.json
Model cache       ~/.cache/dawn/models.json
```

The project `dawn.json` overrides global settings for that working directory. Example:

```json
{
  "model": "groq/meta-llama/llama-4-scout-17b-16e-instruct",
  "githubOAuthClientId": "your-github-oauth-app-client-id",
  "providers": {
    "local-router": {
      "name": "Local Router",
      "baseURL": "http://localhost:8080/v1",
      "apiKeyEnv": "LOCAL_ROUTER_API_KEY"
    }
  },
  "permissions": {
    "bash": "ask",
    "write": "ask",
    "edit": "ask"
  }
}
```

Supported config fields:

- `model`: default model reference in `provider/model` format.
- `githubOAuthClientId`: GitHub OAuth App client id for Copilot device authorization. Overrides Dawn's
  built-in client id when set.
- `providers`: extra OpenAI-compatible providers by provider ID.
- `providers.<id>.name`: optional display name.
- `providers.<id>.baseURL`: OpenAI-compatible API base URL.
- `providers.<id>.apiKeyEnv`: environment variable for the provider API key.
- `permissions`: per-tool policy values of `allow`, `ask`, or `deny`.

Environment overrides:

```text
DAWN_HOME              Override the home directory Dawn uses for config/data/cache defaults.
DAWN_CONFIG_DIR        Override the config directory.
DAWN_DATA_DIR          Override the data/auth directory.
DAWN_CACHE_DIR         Override the cache directory.
DAWN_GITHUB_CLIENT_ID  GitHub OAuth App client id for Copilot device authorization.
DAWN_NO_ANIM           Disable the TUI logo animation when set.
```

## Development

```sh
bun install        # install dependencies
bun run dawn       # run the local CLI
bun test           # run tests
bun run typecheck  # tsc --noEmit
bun run check      # biome check .
bun run format     # biome format --write .
```

The repository is organized as:

```text
index.ts             CLI entrypoint.
packages/core        Agent, providers, auth, config, sessions, tools, context planner, usage ledger.
packages/tui         OpenTUI React interface.
```

## Security notes

- Do not commit API keys or local `dawn.json` files containing secrets.
- Prefer provider environment variables or `dawn auth login <provider>` over inline credentials.
- Stored API keys are written to Dawn's auth file with `0600` permissions.
- `dawn run --yolo` allows side-effecting tools without prompts; use it only in trusted worktrees.
- Dawn is MIT-licensed (see [LICENSE](./LICENSE)) and runs CI on every change. Dedicated `SECURITY.md`
  and `CONTRIBUTING.md` files are still planned; until then, report security issues via a GitHub issue.

## Support

Questions, bugs, and feature requests are welcome on the public repo:
[github.com/abmbodj/Dawn/issues](https://github.com/abmbodj/Dawn/issues).

The most reliable local reference is always:

```sh
dawn --help
dawn models
```

## License

Dawn is released under the [MIT License](./LICENSE).
