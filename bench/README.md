# Dawn token benchmark

This harness proves Dawn's headline claim with **measured** numbers instead of modeled
ones. It runs each task three ways against an isolated checkout of the Dawn repo and reads
the token counts straight from each agent's own usage accounting:

- **`dawn`** — Dawn in its default `balanced` mode (summaries, history trimming, tool-output
  compaction, prompt caching all on).
- **`naive`** — the *same* Dawn agent run with `--naive`: full files, full history, no
  compaction, no caching. This is the apples-to-apples baseline — identical model, system
  prompt, tools, and loop; only the context machinery differs.
- **`claude`** — Claude Code (`claude -p`) on the same task, when the `claude` CLI is on your
  `PATH`. **Indicative only**, not apples-to-apples: it's a different agent. By default it runs
  on Dawn's model when that's `anthropic/*`; pass `--claude-model <id>` to run it on any other
  provider (including a free one) — see below. Multi-turn tasks skip this column (`claude -p`
  is single-shot).

## Task types

- **Single-turn** tasks measure one send: read-heavy `cat`/`grep` work, structural edit checks,
  and four exact-answer pilots.
- **Multi-turn** tasks (`mt-*`, `prompts: [...]` in `tasks.ts`) send several user turns to the
  same agent/session. They are the only place the cross-turn machinery — history trimming,
  working-set TTLs, session memory, cross-turn prompt caching — actually gets exercised, which
  is exactly where Dawn is designed to win.
- Exact-count checks derive their expected numbers **from the pinned worktree itself** at run
  time (see `countMatchingLines`/`uniqueExportFiles` in `tasks.ts`), so they don't go stale
  when the pinned ref moves. "Name three X" checks accept *any* correct answer, including ones
  only visible in a compacted head/tail view — otherwise the check would bias against the very
  mechanism being measured.

## Model pinning and pacing

- Reps run with `autoFallback` disabled and the harness marks a rep **invalid** if the model
  changed mid-run — a silently switched model would bench something other than the recorded
  provenance. (Providers do reject catalog-listed models: GitHub Copilot's chat endpoint
  returns `model_not_supported` for Claude models unless they're enabled in your Copilot
  policy settings, even though its `/models` list includes them.)
- Runs are paced (`PACE_MS`) and rate-limited reps are retried after a pause
  (`RATE_LIMIT_PAUSE_MS`) — subscription providers like Copilot throttle burst traffic from
  multi-step agent turns.

## Run it

```bash
bun run bench            # full run: every task × dawn/naive[/claude] × 3 reps
bun run bench -- --smoke # 2 tasks, 1 rep — cheap end-to-end check
bun run bench:report     # render bench/results.json as a Markdown table
bun run bench:report -- --write-readme   # splice the table into README.md
```

Flags: `--reps N`, `--tasks id1,id2`, `--model provider/model`, `--claude-model <id>`,
`--no-claude`, `--ref <git-ref>`, `--timeout <ms>`.

You need a configured, tool-capable model (`dawn auth login <provider>`). The Dawn vs. `--naive`
comparison — the actual proof — runs on **any** model you have, including a free OpenRouter model
or a local Ollama model; you don't need Anthropic for it.

> **Caching matters.** Prompt caching is Anthropic-only, and Dawn leans on it to amortize the repo
> summaries it injects each turn. On non-caching providers that injection is paid in full every
> turn, so Dawn is tuned to inject a leaner summary share there (`SUMMARY_SHARE_UNCACHED` in
> [context/budget.ts](../packages/core/src/context/budget.ts)). Expect Dawn's edge to be largest on
> Anthropic and on read/search-heavy work with big, compressible tool outputs.

### Any OpenAI-compatible provider (e.g. Hugging Face)

Dawn can use any OpenAI-compatible endpoint via a custom provider in `dawn.json` — no code change
(see the repo's `dawn.json` for the Hugging Face entry):

```jsonc
{ "providers": { "huggingface": {
    "baseURL": "https://router.huggingface.co/v1",
    "apiKeyEnv": "HF_TOKEN"
} } }
```

```bash
HF_TOKEN=hf_… bun run bench -- --no-claude --model huggingface/Qwen/Qwen2.5-72B-Instruct
```

Free inference tiers (HF, OpenRouter `:free`) are rate-limited and credit-capped, so they're best
for a `--smoke` subset rather than a full run.

### Claude Code on a free model

The `claude` column normally runs on Dawn's model when that's `anthropic/*`. To run it on a free
or non-Anthropic model instead, point the `claude` CLI at that provider and pass its model id:

```bash
# Example: route Claude Code through an OpenAI-compatible / OpenRouter gateway
export ANTHROPIC_BASE_URL=https://openrouter.ai/api   # your gateway
export ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY
bun run bench -- --model openrouter/<model> --claude-model <model-id-your-gateway-expects>
```

`--claude-model` only changes which id the harness passes to `claude --model`; the `claude` CLI
must itself be configured to reach that provider. For the fairest indicative comparison, give Dawn
and Claude Code the **same** underlying model.

## Honesty notes

- **This is not a CI gate.** It spends real API budget, needs credentials, and is
  non-deterministic (no temperature is pinned anywhere in Dawn). Results are committed to
  `bench/results.json` and regenerated on demand; the README table is generated from them.
- **Determinism.** Each task runs `--reps` times (default 3) and the report uses the
  **median** over the reps a mode actually passed. The repo is pinned to a commit SHA and the
  model is fixed; `results.json` records all of this as provenance. Numbers are
  *representative and reproducible via this harness*, not exact.
- **What counts as success.** Read-heavy tasks run an explicit command that yields a large
  output (`cat` of a big file, a broad `grep`/`find`) and then check that the answer engaged
  with it — so both modes do the same work and the token delta is purely Dawn's compaction of
  that output, not one mode "winning" by doing less. Edit tasks check the worktree structurally.
  Tasks where a mode fails its check are excluded from the medians and marked ⚠️ in the table.
- **Why read-heavy.** Dawn's savings are workload-dependent: on a trivial one-shot question its
  per-turn summary injection can cost more than it saves. The win is real on the read/search-heavy,
  multi-step work these tasks model — broad searches and large files — where the naive baseline
  re-sends whole outputs and Dawn compacts them.
- **Tokens vs. cost.** The table reports input tokens (with Dawn's cache-read tokens in
  parentheses) *and* dollar cost. Cost already reflects the cache discount; input tokens show
  the raw context-shrinking effect. They're shown side by side so caching credit is visible
  but never double-counted.
- **Isolation.** Every run happens in a throwaway `git worktree` at the pinned SHA with its
  own temporary session/context databases, so your real working tree and `~/.cache/dawn` are
  never touched.
