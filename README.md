# Dawn

**A cheaper coding agent for the terminal, built to spend less context.**

[![CI](https://github.com/abmbodj/Dawn/actions/workflows/ci.yml/badge.svg)](https://github.com/abmbodj/Dawn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Install](https://img.shields.io/badge/install-source--first-lightgrey)

Most terminal coding agents pay the same context bill again and again. They resend old
conversation turns, whole files, and giant tool outputs long after the useful signal has already
been extracted. Dawn starts from the opposite premise: context is a budget, not a bucket.

Dawn is a Bun and TypeScript AI coding agent with an interactive TUI, resumable sessions,
multi-provider model selection, permission prompts, one-shot automation, MCP/plugin/skill support,
and built-in reports that show what it read, spent, cached, compacted, and saved.

![Dawn TUI session](docs/assets/dawn-tui.png)

## Why Dawn Exists

Dawn is for developers who want a coding agent they can inspect and measure. The core thesis is
simple:

- Input tokens dominate many agent bills.
- Re-sending stale context is the easiest way to waste them.
- A coding agent should plan each request before it spends context.
- The tool should show the plan, the spend, and the savings instead of hiding them.

The committed benchmark snapshot currently shows Dawn sending fewer input tokens than its identical
`--naive` baseline on the comparable task in `bench/results.json`. The benchmark harness is part of
the repo so you can rerun it against your own model, provider, and task set.

## Quickstart

Prerequisite: [Bun](https://bun.sh/) 1.3 or newer.

```bash
git clone https://github.com/abmbodj/Dawn.git
cd Dawn
bun run setup
dawn --help
```

Start Dawn in any project directory:

```bash
cd /path/to/your/project
dawn
```

On first launch, Dawn opens an interactive setup flow. For a low-friction first run, connect a free
or free-tier provider such as OpenRouter or Groq. You can also connect providers from the CLI:

```bash
dawn auth login openrouter
dawn auth login groq
dawn auth list
dawn models
```

Then ask Dawn a normal coding question or change request:

```text
Where is request retry handled?
```

```text
Add a test for the retry backoff edge case.
```

## Everyday Workflows

### Interactive TUI

```bash
dawn
```

The TUI is the primary Dawn experience. It streams model output, shows tool activity, supports slash
commands, prompts before side-effecting tools, and keeps sessions resumable.

Useful slash commands:

| Command | Purpose |
| --- | --- |
| `/model` | Switch models across connected providers. |
| `/plan-model` | Set the model used while in plan mode. |
| `/connect` | Connect another model provider. |
| `/context` | Show context budget, working set, and savings. |
| `/usage` | Show token and cost breakdown for the session. |
| `/savings` | Show session, project, and lifetime token savings. |
| `/rewind` | Restore files and conversation to a previous checkpoint. |
| `/image` | Attach a local image file to the next message. |
| `/resume` | Pick a previous session for the current directory. |
| `/mcp` | Show connected MCP servers and tool counts. |
| `/plugin` | Show enabled plugins and plugin commands. |
| `/skills` | Show discovered and loaded skills. |

### One-shot Runs

```bash
dawn run "Explain how model fallback works in this repo"
```

One-shot mode is useful for scripts and automation. Reads are allowed by default. Use `--yolo` only
when the working tree is trusted or disposable:

```bash
dawn run "Update the README install section" --yolo
```

### Sessions

```bash
dawn --continue
```

Dawn persists sessions per project, so you can resume the most recent conversation with `-c` /
`--continue` or pick from prior sessions inside the TUI with `/resume`.

### Models and Providers

```bash
dawn models
dawn models anthropic
dawn models --refresh
dawn doctor models
```

Dawn can use hosted providers, local providers, and custom OpenAI-compatible endpoints. Provider
catalog data comes from `models.dev` with an offline fallback, and live provider probes refine the
available model list at runtime.

## CLI Reference

| Command | Description |
| --- | --- |
| `dawn` | Start an interactive session in the current directory. |
| `dawn -c`, `dawn --continue` | Resume the most recent session for this directory. |
| `dawn -m provider/model` | Start with a specific model. |
| `dawn --budget <tokens>` | Cap estimated prompt tokens. |
| `dawn --context minimal|balanced|deep` | Choose the context planning mode. |
| `dawn --naive` | Run the same agent with summaries, trimming, compaction, and caching disabled. |
| `dawn run "<prompt>"` | Run one non-interactive task. |
| `dawn index` | Build or refresh the repo context index. |
| `dawn auth login <provider>` | Store a provider credential. |
| `dawn auth list` | Show configured providers. |
| `dawn auth logout <provider>` | Remove a stored provider credential. |
| `dawn models [provider]` | List known live models. |
| `dawn doctor models` | Smoke-test tool-capable models. |
| `dawn plugin add <git-url|path>` | Install a plugin. |
| `dawn plugin remove <name>` | Remove a plugin. |

## How Dawn Spends Less Context

Dawn's context system lives in `packages/core`. The important pieces are:

- **Per-turn budgets.** `minimal`, `balanced`, and `deep` modes choose how aggressively Dawn reads,
  summarizes, trims, and expires context.
- **Repo summaries.** Dawn indexes files into compact summaries and reuses them instead of repeatedly
  loading full source files.
- **Working-set leases.** Files, ranges, summaries, and tool outputs stay available for a few turns,
  then expire when they are no longer useful.
- **Atomic history trimming.** Old messages are dropped by budget while tool-call/tool-result pairs
  stay valid.
- **Bounded reads.** Read tools cap line counts by context mode and tell the model how to continue.
- **Tool-output compaction.** Large command output is compacted by shape: logs, JSON, grep results,
  and free text each get different treatment.
- **Expandable originals.** Compacted tool output stores the full original and exposes an `expand`
  marker so the model can retrieve details without rerunning the command.
- **Prompt caching.** Cache-capable providers can amortize stable context across turns.
- **Visible accounting.** `/context`, `/usage`, and `/savings` expose the working set, token totals,
  cached input, and estimated savings.

## Benchmark

Dawn includes a benchmark harness in [`bench/`](./bench/) that compares:

- `dawn`: default balanced mode with context management enabled.
- `naive`: the same Dawn agent with context management disabled.
- `claude`: optional Claude Code comparison when the `claude` CLI is available.

The rigorous comparison is Dawn versus `--naive`, because it uses the same model, tools, system
prompt, and loop. The Claude Code column, when present, is useful context but not apples-to-apples.

<!-- BENCH:START -->
**Across 1 comparable task(s) at equal success, Dawn used a median 29% fewer input tokens and 25% more cost than the naive baseline (pooled: -29% tokens vs naive, +25% cost).**



### diagnosis

_diagnosis: median **29% fewer input tokens**, **25% more cost** (1 task(s) at equal success)_

| Task (pass rate) | Dawn input (cached) | Naive input | Input ↓ | Dawn $ | Naive $ | Cost ↓ |
| --- | --: | --: | --: | --: | --: | --: |
| pilot-diagnosis-maxreadlines (d:1/1 n:1/1) | 12,993 (5,248) | 18,385 | −29% | $0.0188 | $0.0151 | +25% |



_Measured by github-copilot/gpt-4.1, Dawn repo @ cab86500, 1 rep(s)/task (median), 2026-07-03._


_⚠️ marks tasks where a mode did not pass its correctness check; those are excluded from the medians._


```bash
# Reproduce (requires Anthropic key + `claude` CLI for the Claude column):
bun run bench        # real API spend, non-deterministic
bun run bench:report # regenerate this table

# Free local verification of the mechanism delta (Dawn vs --naive only):
bun run bench --no-claude --model ollama/<model>   # or groq/<model>
```
<!-- BENCH:END -->

The snapshot above is intentionally generated from the committed `bench/results.json`. Rerun the
harness when you want broader evidence across more tasks, repetitions, providers, or models.

## Configuration

Dawn reads global config from `~/.config/dawn/config.json` and project config from `dawn.json`.
Project config overrides global config, with provider and MCP definitions merged.

Set a default model:

```json
{
  "model": "openrouter/deepseek/deepseek-chat-v3-0324:free"
}
```

Add a custom OpenAI-compatible provider:

```json
{
  "providers": {
    "huggingface": {
      "name": "Hugging Face",
      "baseURL": "https://router.huggingface.co/v1",
      "apiKeyEnv": "HF_TOKEN"
    }
  }
}
```

Pre-approve or deny tools:

```json
{
  "permissions": {
    "read": "allow",
    "bash": "ask",
    "edit": "ask"
  }
}
```

Configure MCP servers using the Claude Code `.mcp.json` shape:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}
```

## Architecture

```mermaid
flowchart LR
  CLI["CLI entrypoint"] --> TUI["Interactive TUI"]
  CLI --> Run["One-shot run"]
  TUI --> Agent["DawnAgent"]
  Run --> Agent
  Agent --> Tools["Read / edit / bash / git / web / expand tools"]
  Agent --> Providers["Model providers"]
  Agent --> Context["Context planner + working set"]
  Context --> Store["SQLite context store"]
  Agent --> Sessions["SQLite session store"]
  Agent --> Ext["MCP servers / plugins / skills / hooks"]
  Bench["Benchmark harness"] --> Agent
```

The repo is split into a small CLI entrypoint, shared core agent logic in `packages/core`, terminal UI
code in `packages/tui`, and benchmark scripts in `bench`.

## Development

```bash
bun install
bun run setup
bun test
bun run typecheck
bun run check
bun run preflight
```

Repo layout:

| Path | Purpose |
| --- | --- |
| `index.ts` | Dawn CLI entrypoint and command routing. |
| `packages/core` | Agent loop, providers, context budgeting, tools, sessions, config, MCP, plugins, skills. |
| `packages/tui` | Terminal UI, setup flow, slash commands, status views, markdown rendering. |
| `bench` | Measured token/cost benchmark harness and report generator. |

For contribution expectations, see [`CONTRIBUTING.md`](./CONTRIBUTING.md). For vulnerability
reporting, see [`SECURITY.md`](./SECURITY.md).

## License

MIT. See [`LICENSE`](./LICENSE).
