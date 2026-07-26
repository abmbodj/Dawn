# Dawn token benchmark

This harness proves Dawn's headline claim with **measured** numbers instead of modeled
ones. It runs each task against an isolated checkout of the Dawn repo and reads token
counts straight from each agent's own usage accounting:

- **`dawn`** — Dawn in its default `balanced` mode (summaries, history trimming, tool-output
  compaction, prompt caching all on). Adaptive budgets apply unless you pass `--budget`.
- **`naive`** — the *same* Dawn agent run with `--naive`: full files, full history, no
  compaction, no caching. This is the apples-to-apples baseline — identical model, system
  prompt, tools, and loop; only the context machinery differs.
- **`claude`** — Claude Code (`claude -p`) on the same task, when the `claude` CLI is on your
  `PATH`. **Primary peer, indicative only** — not apples-to-apples.
- **`aider`** — Aider (`aider --message …`) when on `PATH`. **Secondary sanity check**; token/$
  accounting is often unavailable.

## Proof slices

Each task carries a `slice` used by `bench/report.ts`:

| Slice | Intent | Win bar |
| --- | --- | --- |
| `trivial` | Short one-shot | May tie/lose $ (informational) |
| `investigate` | Read/search-heavy | Must win $ vs `--naive` |
| `edit` | Structural edit | Prefer win; watch regressions |
| `long` | Multi-turn session | Must win $ vs `--naive` |

**Overall gate:** Dawn pooled $ ≤ `--naive` $ at equal success. Reclaim the public “cheaper”
tagline only after these gates pass (see
`docs/superpowers/specs/2026-07-24-cheaper-agent-thesis-design.md`).

## Task types

- **Single-turn** tasks measure one send: read-heavy `cat`/`grep` work, structural edit checks,
  and four exact-answer pilots.
- **Multi-turn** tasks (`mt-*`, `prompts: [...]` in `tasks.ts`) send several user turns to the
  same agent/session. They are the only place the cross-turn machinery — history trimming,
  working-set TTLs, session memory, cross-turn prompt caching — actually gets exercised, which
  is exactly where Dawn is designed to win.
- Exact-count checks derive their expected numbers **from the pinned worktree itself** at run
  time (see `countMatchingLines`/`uniqueExportFiles` in `tasks.ts`), so they don't go stale
  when the pinned ref moves.

## Run it

```bash
bun run bench            # full run: every task × dawn/naive[/claude][/aider] × 3 reps
bun run bench -- --smoke # 2 tasks, 1 rep — cheap end-to-end check
bun run bench:report     # render bench/results.json as a Markdown table
bun run bench:report -- --write-readme   # splice the table into README.md
```

Flags: `--reps N`, `--tasks id1,id2`, `--model provider/model`, `--claude-model <id>`,
`--no-claude`, `--no-aider`, `--ref <git-ref>`, `--timeout <ms>`.

You need a configured, tool-capable model (`dawn auth login <provider>`). The Dawn vs. `--naive`
comparison — the actual proof — runs on **any** model you have.

> **Caching matters.** Prompt caching amortizes repo summaries for any model with catalog
> `cache_read` pricing (`promptCaches`). Anthropic/Bedrock Claude also get explicit cache
> breakpoints. Non-caching providers use a leaner summary share
> (`SUMMARY_SHARE_UNCACHED` in [context/budget.ts](../packages/core/src/context/budget.ts)).

## Honesty notes

- **This is not a PR CI gate.** It spends real API budget, needs credentials, and is
  non-deterministic. PR CI runs deterministic planner invariant unit tests (`bun test`).
- **Tokens vs. cost.** The table reports input tokens *and* dollar cost so “fewer tokens,
  more $” regressions are obvious.
- **The fixture is pinned, and must stay pinned.** Tasks `cat`/`grep` Dawn's own source, so
  running them against `HEAD` makes the thing being measured move with every commit — adding
  110 lines to `context/budget.ts` grew `cat-budget`'s input by 21% with no change in context
  management at all, which reads exactly like a regression. `FIXTURE_REF` in `run.ts` pins the
  workdir; the agent under test always comes from the working tree. Comparing two runs is only
  valid when both used the same fixture ref (it is recorded in `provenance.gitSha`).
- **Slice-aware win bar.** Overall Dawn $ ≤ naive; win $ on investigate + long; trivial may
  tie/lose. See the design spec for reclaiming the “cheaper” tagline.
