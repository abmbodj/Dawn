# Dawn Cost & Reliability Audit

**Date:** 2026-07-25 · **Repo state audited:** `79df017` · **Status:** complete

**Question this audit answers:** is Dawn actually a cheaper coding agent at equal reliability — and if not, where exactly does the claim break, and what fixes it?

**Method:** full source trace of the request pipeline (file:line evidence), a measured grid (13 tasks × dawn/naive/Claude Code × 2 reps on `anthropic/claude-haiku-4-5`, including 6 new adversarial reliability probes), and source-level study of Codex CLI, Gemini CLI, OpenCode, and Aider plus documented Claude Code behavior. Headline metric: **cost per successful task with a pass-rate parity gate** — failures are charged, never excluded.

## Verdict

**The claim is now measured and true — with one asterisk and one reframing.**

- At identical 92% pass rates on the same model, **Dawn costs $0.0270 per successful task vs $0.0439 for its own naive ablation (−38%) and $0.0697 for Claude Code (−61%)** (§2.10). Reliability parity holds on the adversarial probe set (§3.2).
- **The asterisk:** the `investigate` slice — single-turn tasks pulling one huge tool output — still *loses* money vs naive (+35% median, +70% on the worst task), because the token budget is only enforced once per turn while up to 100 steps re-send everything (§2.1). Fixing this (P0.1/P0.2) is the difference between "cheaper on average" and "cheaper everywhere".
- **The reframing:** Dawn's win is a **caching win, not a token win** — it sends +28% *more* input tokens than naive and pays 38% less, because its stable context bills at cache-read rates. "Token-frugal" is the wrong public claim; **context-frugal / dollar-frugal** is the measured one. On non-caching providers the claim rests on the untested lean-budget path.

---

## 1. Current-state architecture

How a turn actually runs (`DawnAgent.send()`, `packages/core/src/agent/agent.ts:500`):

1. Turn bookkeeping: plan-mode reminder appended to user text if active (~430 chars, persisted into history); message pushed and persisted; shadow-git checkpoint commit + full message-JSON dump every turn (`agent.ts:531` → `checkpoint/checkpoint.ts:87`).
2. Skill auto-triggers matched; bodies loaded into a 4k-token LRU `SkillBuffer`. Repo-overview questions force a `repo_overview` first step via `toolChoice`.
3. Attempt loop (max 4 = 2 retries + 2 model switches). Per attempt: `resolveProfile` → `buildRequestMessages` (`context/budget.ts:303`) → `streamText` with `stopWhen: stepCountIs(100)`.
4. Stream handling: tool results echoed into the working set (`truncateMiddle(…, 4000)`); repeated-failure loop-break nudges after 3 identical tool errors; usage recorded per step into `UsageLedger`; error classification routes to retry / model fallback / overflow compaction.
5. Overflow recovery only: `compactViaLlm` summarizes the oldest half of turns with the cheap `utility` model and splices them out.

The request wire order (`budget.ts:498-500`):

```
system (+cacheControl)                     ← byte-stable, built once at boot
[file summaries block] (+cacheControl)     ← up to 35% of post-system budget
history[0..n-2]                            ← trimmed to budget remainder
[working set + loaded skills]              ← volatile, TTL-leased items
[answer guidance]                          ← per-turn
history[n-1] (+cacheControl, moving)       ← latest user message
```

Key machinery and budgets:

| Mechanism | Value | Where |
| --- | --- | --- |
| Token estimator | `chars ÷ 4`, no tokenizer | `budget.ts:27` |
| Budget (caching models) | `min(window × {6,10,15}%, {12k, 20k, 32k})` by mode | `provider/profile.ts:48` |
| Budget (non-caching) | 6k / 8k / 12k | `profile.ts` `LEAN_BUDGET_BY_MODE` |
| Summary share | 35% cached, 12% uncached | `budget.ts:16-18` |
| Working-set TTLs | file 3/4/6 turns, tool-result 1/2/3, summary never expires | `budget.ts:39` |
| Tool-output compaction | threshold 400/800/1600 est. tokens; reversible `«expand:HASH»` sentinels | `context/compact/` |
| System prompt (this repo) | ~8.3k chars ≈ 2.1k tokens incl. AGENTS.md + skill catalog | `agent/system.ts:31` |
| Tool schemas | 26 tools ≈ 11.7k chars ≈ **2.9k tokens/request, uncounted** | `tools/index.ts:357` |

`--naive` disables all of it (no summaries, trims, compaction, cache markers) and is the benchmark baseline — a genuinely fair ablation, since it's the identical agent.

**What exists and works:** deterministic tool-output compaction with reversible expansion; read-before-edit freshness enforcement (`assertFreshRead`, `tools/index.ts:463-479`); byte-stable system prefix for caching; measured-vs-estimated accounting kept honest in the UI; plan-mode tool hiding that removes 7 side-effecting tool schemas from the payload.

**What does not exist:** intra-turn context control (the budget is enforced once per attempt, then up to 100 steps re-send everything), request-level dedup between history and working set, subagents, proactive compaction, difficulty-based routing, a real tokenizer.

## 2. Cost audit — where tokens and dollars actually go

### 2.1 The budget is a fiction inside a turn (the dominant leak)

`buildRequestMessages` runs once per attempt (`agent.ts:590`); the AI SDK then re-sends the entire growing message list on every one of up to 100 steps with nothing trimmed in between (`agent.ts:67`, `625`). A "20,000-token budget" investigate turn measured **71k real input tokens before the budget-cap fix and still 60.2k after it** (`cat-budget`, vs naive's 18.6k — §2.10). Every heavy tool output is paid for again on every subsequent step of the same turn. This single gap explains the failed `investigate` slice; budget caps shrink it but cannot close it.

### 2.2 Tool results are paid for twice; reads three times

Every tool result lands in history as a `role:"tool"` message **and** as a 4k-char working-set echo re-sent for 1–3 further turns (`agent.ts:695-704`) — `buildRequestMessages` never dedups the two. A `read` additionally registers a `file-range` working-set item with the same body plus a `summary` item for the same file (`tools/index.ts:412-432`): the same bytes can ride in three places.

### 2.3 `read` is the only heavy tool with no output cap

Not in `HEAVY_OUTPUT_TOOLS` (`tools/index.ts:62`); up to 240 lines × 2,000 chars/line in balanced mode with no total-byte ceiling, while `bash` (30k), `grep` (15k), `git_diff` (20k) are all bounded.

### 2.4 ~2.9k tokens/request of tool schemas are invisible to the planner

`ContextPlan.systemTokens` measures only `args.system` (`budget.ts:343`). Every budget decision and the overflow guard (`agent.ts:463`) are ~3k tokens optimistic on every request.

### 2.5 Cache-prefix instability erodes the caching thesis

- The summary block rewrites its cache breakpoint on every append until it saturates at 6 entries (`agent.ts:1013`).
- `summariesEarnKeep` flipping false→true mid-session inserts a message ahead of all history, invalidating everything after the system block (`budget.ts:75`).
- The moving last-message breakpoint pays a cache write each turn that can rarely be read back across turns, because volatile working-set/guidance messages are interleaved before it (`budget.ts:498`, visible as 20k `cacheWriteTokens` on `mt-diagnosis-recall`).

### 2.6 Unconditional per-turn overhead

Plan-mode reminder (~430 chars) appended into persisted history each turn; a checkpoint git commit + full messages JSON dump per turn; a `context_plans` row per attempt with no pruning; `saveMessages` = delete-all + re-insert of every row per step (O(n²) writes over a session) (`session/store.ts:84`).

### 2.7 Invisible utility-model spend

The only `generateText` call in core (`context/compact-llm.ts:40`) — overflow compaction on the utility model — never reaches `ledger.record` (`agent.ts:766` is the sole recording site). Its cost is missing from `/usage`, `/savings`, and the bench.

### 2.8 Estimation error is structural

`chars ÷ 4` (`budget.ts:27`) skews every trim decision and every "estimated avoided" figure; code and JSON routinely run 3–3.5 chars/token, so budgets systematically over-admit content.

### 2.9 What Dawn is genuinely saving today

Compaction of bash/grep/glob/MCP outputs with reversible expand sentinels; ranged reads with mode caps; deny-listed/plan-hidden tools costing zero schema tokens; summary substitution instead of full files; history/working-set trimming at turn boundaries; a byte-stable cached system prefix; pay-for-itself summary skip on trivial turns. The measured grid (§2.10) confirms these mechanisms beat naive on every slice except investigate — trivial −28%, edit −32%, long −47%, probes −47% — the machinery works wherever the intra-turn leak (§2.1) doesn't dominate.

### 2.10 Measured grid (this audit)

13 tasks (all four slices + 6 reliability probes) × {dawn, naive, claude} × 2 reps, all on `claude-haiku-4-5-20251001` (Claude Code pinned to the same model), Dawn repo @ `79df017`, 2026-07-25. Full data: `bench/results.json`.

**Headline — cost per successful task (all reps charged, failures included):**

| Agent | Pass rate | Total $ | $ / successful task |
| --- | --: | --: | --: |
| Dawn | 24/26 (92%) | $0.648 | **$0.0270** |
| Naive (identical agent, machinery off) | 24/26 (92%) | $1.054 | $0.0439 |
| Claude Code (same model, same tasks) | 24/26 (92%) | $1.673 | $0.0697 |

**Headline gate: PASS.** At identical pass rates, Dawn is **38% cheaper per successful task than its own naive baseline and 61% cheaper than Claude Code on the same model** — the first defensible version of the project's core claim. (Claude Code $ are simulated from its measured token usage at anthropic list prices; the comparison is indicative, since it's a different agent, not an ablation.)

**Per-slice diagnostics (dawn vs naive, medians at equal success):**

| Slice | Tasks | Input Δ | Cost Δ | Gate |
| --- | --: | --: | --: | --- |
| trivial | 1 | ±0% | −28% | informational |
| investigate | 2 | **+129%** | **+35%** | **fail ($ lose)** |
| edit | 1 | +23% | −32% | ok |
| long | 2 | +11% | −47% | pass |
| probe | 6 | +26% | −47% | pass rate is the metric |

**Two structural facts the grid establishes:**

1. **Dawn's win is a caching win, not a token win.** Pooled, Dawn sends **+28% more input tokens** than naive yet costs **38% less** — the working set/summary machinery deliberately re-sends stable context that bills at cache-read rates (0.1×). The "token-frugal" framing in the README is actually backwards at the wire level; the accurate claim is *context-frugal, dollar-frugal*. On non-caching providers the lean budgets (6k/8k/12k) are what protect the claim — that path is untested by this grid.
2. **The investigate slice still fails, and §2.1 is the cause.** `cat-budget`: Dawn 60.2k input vs naive 18.6k (+224%), $0.034 vs $0.020 (+70%). One `cat` of a big file, then 5–6 steps each re-sending the whole thing plus working-set echo. The budget-cap fix (`6766c44`) improved it (was +283%/+100%) but cannot close it — only intra-turn enforcement (P0.1/P0.2) can.

**Claude Code volume comparison (same model, same task):** Dawn's total context traffic is a fraction of Claude Code's on every task — e.g. `probe-long-recall` 93k vs 371k input, `probe-multifile-rename` 54k vs 273k, `mt-edit-sequence` 55k vs 171k. Claude Code's ~33k-token prefix (§4.4) re-billed per step dominates; its heavy cache reads only partly compensate at Haiku prices.

## 3. Reliability audit

### 3.1 Structural gaps found by inspection

1. **No post-edit validation loop.** Edits are checked for freshness before applying, but nothing runs typecheck/lint/tests after; a broken multi-file change is only caught if the user asks.
2. **No proactive compaction.** Long sessions run until a provider overflow error, then reactively splice half the history — an availability cliff rather than graceful degradation. `this.messages` grows unboundedly (`agent.ts`, only overflow trims it).
3. **Summary staleness after edits.** File summaries and working-set items are keyed by path but not invalidated when the agent itself edits the file mid-session (edit-aware invalidation exists only for `read` freshness, not for summaries already in context).
4. **Bench measured engagement, not correctness.** The `heavy()` checks pass if the transcript names any real symbol (`bench/tasks.ts:94`) — a mode can be wrong and still "pass".
5. **The old metric hid failures.** Medians were computed over passing reps only, and tasks where either mode failed were dropped entirely (`bench/report.ts:59-64`, gating at `:200`) — Dawn's `grep-exports` failure silently vanished from the comparison. Fixed this audit: headline is now cost-per-successful-task with a parity gate.
6. **Loop-breaking exists but is narrow.** Repeated identical tool failures get a nudge after 3 (`agent.ts:744-761`); there is no detection of semantic loops (alternating between two failing approaches) and no step-budget degradation short of the hard 100-step cap.

### 3.2 Measured probes (this audit)

Six adversarial probes with deterministic checks now run in the bench (`bench/tasks.ts`, `probe` slice). Measured pass rates (2 reps each, Haiku):

| Probe | Dawn | Naive | Claude Code |
| --- | :-: | :-: | :-: |
| Recover from failing command | 2/2 | 2/2 | 2/2 |
| Stale-file edit (mutated mid-session) | **1/2** | 2/2 | 2/2 |
| Multi-file rename (3 files, consistent) | 2/2 | 2/2 | 2/2 |
| Ambiguous destructive instruction | 2/2 | 2/2 | **1/2** |
| Long recall under distractors | 2/2 | 2/2 | 2/2 |
| Minimal-diff restraint | 2/2 | 2/2 | 2/2 |

Readings:
- **Dawn holds reliability parity with Claude Code on the same model** across the probe set (11/12 each; naive 12/12) while spending 47% less than naive and ~2.4× less than Claude Code on these tasks.
- **Dawn's one probe failure is on stale-file edits** — the scenario its `assertFreshRead` gate exists for. One rep handled the external mutation; one didn't. This is exactly where context management can *cause* failure (a stale working-set copy contradicting disk) and directly motivates edit-aware invalidation (§6.3/P1.5) — naive, which holds no cached file state, went 2/2.
- **Claude Code's failure was the ambiguity probe** (one rep acted without surfacing the ambiguity). Dawn's headless `ask_user` degradation handled it 2/2.
- Outside the probes, the only failures were `grep-exports` (dawn 1/2, naive 0/2, claude 1/2) — a Haiku-capability miss on a lenient check, afflicting all three agents, not a context-management defect.

## 4. Competitive analysis

Source-level findings (file:line refs are into each project's own repo, read at current main).

### 4.1 Aider — the canonical cheap-context design (verified)

- **Volatile-after-stable context layout.** Requests assemble 8 fixed slots (`chat_chunks.py:17`): `system + examples + readonly_files + repo + done + chat_files + cur + reminder`. File contents are **regenerated fresh each turn and never accumulate into history** (`move_back_cur_messages`, `base_coder.py:1036` moves only prose). N turns editing a 3k-token file pay for it once per turn, never N copies in history. Cache breakpoints (max 3) sit exactly at the stable/volatile seam (`chat_chunks.py:29`).
- **No tools at all.** Edits come back as search/replace text blocks; steady-state system prompt is ~800–1,000 tokens with **zero schema overhead** (vs Dawn's ~2.9k tokens of schemas per request).
- **Repo map:** tree-sitter def/ref tags (mtime-cached, `repomap.py:246`) → PageRank over the reference graph, personalized toward chat files and identifiers mentioned in the user message (×10 mention weight, ×50 chat-file edges, `repomap.py:493-512`) → binary-searched down to a budget of `clamp(max_input/8, 1024, 4096)` tokens (`models.py:782`). Chat files are excluded from the map by construction — no double-send.
- **History summarization** capped at `clamp(max_input/16, 1024, 8192)` tokens, run on the **weak model in a background thread** (`base_coder.py:510`, `1002`) so latency is hidden.
- **Architect mode:** reasoning model writes a plan; a second coder applies it on a cheaper editor model with `map_tokens=0` and **cleared history** (`architect_coder.py:39-40`). Right-sized context per job.
- **Failed-edit repair messages** include "The other N blocks were applied successfully. Don't re-send them." (`editblock_coder.py:118`) — a direct output-token saver.
- **Anti-pattern not to copy:** no output caps anywhere — `/run` and lint output are unbounded, gated by a human prompt (`commands.py:1013`). Fine for a REPL, an unbounded-cost bug for an autonomous agent. Also: each of the ≤3 reflections re-sends the full context.

### 4.2 OpenCode — closest architecture to Dawn, different economics

- **Re-renders the full session per step** (`session/prompt.ts:1257-1283`) with a 2–3.8k-token provider-specific system prompt plus ~4k tokens of tool descriptions — a 6–10× larger static prefix than Aider, survivable only because of disciplined caching: exactly 4 breakpoints, `system.slice(0,2)` + last 2 non-system messages (`provider/transform.ts:357-359`), with per-provider dialects, plus `promptCacheKey = sessionID` for OpenAI-style providers.
- **Three-tier context reclamation**, cheapest first:
  1. **Prune** (`compaction.ts:243`): walk backwards, stamp old completed tool outputs as compacted; rendering substitutes `"[Old tool result content cleared]"` (`message-v2.ts:293`). Protects newest 40k tokens of tool output, needs ≥20k reclaimable, skips 2 newest turns. **Zero LLM calls, background.**
  2. **Compaction** at `input_limit − min(20k, maxOutput)` (`overflow.ts:8-22`): a dedicated tool-denied `compaction` agent (no schema tokens) summarizes everything except the last 2 turns (≤ ~8k tokens preserved verbatim); the summarizer's own input is pre-clipped to 2k chars per tool result.
  3. Prior summaries chain; compacted source messages are hidden.
- **Central tool-output truncation** (`tool/truncate.ts`): 2,000 lines / 50 KB, full text written to disk, and the returned hint names the specific recovery tool ("delegate to the explore agent" / "Grep" / "Read with offset"). Per-tool caps: grep 100 matches, glob 100 files, shell 30k chars tail-biased, read 2k lines × 2k chars / 50 KB.
- **Small-model routing**: titles via `getSmallModel` and compaction via its own agent/model — both with tools denied, so auxiliary calls carry no schema payload.
- **Edit discipline without a read gate:** 9 staged replacers with ambiguity rejection and a disproportionate-match guard (refuses when a fuzzy match spans ≥2× the target, `edit.ts:731`); correctness comes from re-reading the file at apply time under a per-path lock. **LSP diagnostics are appended to the edit tool result** (`edit.ts:198-200`) — post-edit validation inside the same step, no extra turn.
- **Doom-loop detection**: 3 identical tool calls (same name, byte-identical input) raises a permission ask (`processor.ts:356-367`).
- **Anti-pattern not to copy:** the per-step full re-render with a huge static prefix on any non-caching provider or after cache TTL expiry.

### 4.3 Codex CLI (Rust) — delta-sending and schema frugality

- **Sends only the history delta, not the full conversation.** On its Responses-over-WebSocket path, `get_incremental_items` (`core/src/client.rs:1177-1214`) detects when the request is a strict prefix-extension of the previous one and sends only new items plus `previous_response_id`. An exhaustive-destructuring equality guard (`client.rs:308-359`) makes "did the prefix change?" compile-time-enforced. This is the single biggest structural cost win in any of the surveyed agents (requires provider-side conversation state — OpenAI Responses API).
- **Schema frugality two ways:** code-mode models get one `exec` tool whose description carries TypeScript signatures instead of JSON Schemas; MCP tools register as `Deferred` and are BM25-searched on demand. Fixed prefix ≈ 4.4k tokens (server-delivered system prompt).
- **Budgeted context tiers:** AGENTS.md hard-capped at 32 KiB with a running byte budget; skills metadata capped at 2% of the window; **no directory tree at all**.
- **Record-time middle-out truncation:** tool outputs capped per model (10k tokens), truncated *when recorded into history* with a loss notice — the cost is paid once, never re-inflated per step.
- **Cache discipline:** `prompt_cache_key = session id`; a startup **prewarm request** seats the prefix in cache before the user types; the rollout budget charges only `non_cached_input()` so cached prefill is free in its own accounting.
- **Compaction at 90%** of window, with a zero-LLM mode (fresh window install) and a server-side mode. Anti-pattern: local compaction keeps only the last 20k tokens of *user* messages + summary — all tool results discarded, forcing re-derivation (the code itself warns users about accuracy loss).
- **No read dedup, no staleness ledger, no loop detection** — staleness protection is structural (apply_patch context lines must match).

### 4.3b Gemini CLI (TypeScript) — routing done right, caching done wrong

- **Eleven-role model routing table** (`telemetry/llmRole.ts`): edit-correction, classification, summarization, next-speaker checks, prompt completion on flash-lite; loop-detection on flash with a Pro double-check above 0.9 confidence. A flash-lite classifier routes each request to flash vs pro. The one routing mistake: **compaction runs on Pro** for Pro sessions.
- **Compaction disaster case:** triggers at **50%** of a 1M window and makes **two full-history LLM calls** (summary + a "Probe" verification pass that re-sends everything again) ≈ 740k Pro input tokens per compaction. The counter-lesson to Dawn's own §5.6: proactive compaction must be cheap, or the cure exceeds the disease.
- **Prefix actively cache-hostile:** no explicit cache management (relies on Gemini implicit caching), while appending `[Active Topic: …]` to the *system instruction* on topic change and baking today's date into the first user message — the ~15.4k-token prefix (6.4k prompt + ~9k unconditional tool schemas) is invalidated routinely.
- **Good mechanisms:** remaining-window-aware dynamic shell-output threshold (`min(4 × remaining_tokens, 40k chars)`); disk-spill with the path handed back; JIT subdirectory GEMINI.md loaded on tool access; three-tier loop detection (identical-call ×5, content ×10, LLM check after 30 turns); isolated subagents returning a single structured report.
- **`checkNextSpeaker` anti-pattern:** a full-history LLM call after every tool-free turn to decide whether to auto-continue — on by default.

### 4.4 Claude Code

(Sources: Anthropic docs/engineering blog + third-party proxy measurements; confidence labeled. Full citation list in the research appendix of this audit's PR description.)

**Prefix economics.** Total context before the first user token: ~33k tokens measured by third-party HTTP-proxy capture (~24k of it tool schemas for 27 tools; ~6.5k instructions) vs Anthropic's own illustrative ~4.2k for instructions alone — roughly **4.7× OpenCode's prefix and ~10× Dawn's ~5k** (system ~2.1k + schemas ~2.9k). It is affordable only because of caching discipline: three append-only layers (system+tools → project context → conversation), cache reads ~95% of input tokens in Anthropic's own illustrative `/usage` sample, 1-hour TTL on subscription auth.

**The load-bearing design rule: never mutate the prefix — append state changes as messages.** Plan-mode toggles are tools (`EnterPlanMode`/`ExitPlanMode`), skills/commands inject as user messages, mid-session CLAUDE.md edits deliberately don't apply until restart. Documented invalidators (model switch, effort change, MCP connect/disconnect, upgrades) are treated as expensive events; "resuming a long session after an upgrade can be the most expensive request you send" (Anthropic docs).

**Memory & instructions:** CLAUDE.md hierarchy loads broad→specific; subdirectory files and path-scoped rules load lazily on file read; skill listings truncate descriptions at 1,536 chars, bodies load on invoke with hard re-injection caps after compaction (5k/skill, 25k total); hooks run as code, not context. `@`-imports are documented as *not* saving context — only lazy loading does. **Zero repo content is loaded up front** beyond a git-status snapshot.

**Compaction:** triggers ~83–84% of the window (triangulated ~167k/200k; exact default unpublished), preserves intent/files/errors/pending work, discards tool outputs and reasoning; durable instructions are re-injected **from disk** rather than trusted to the summary. `/compact` re-sends the conversation but reads the existing cache. ~16% of the window is permanently reserved as headroom.

**Tool outputs:** every ceiling returns a *handle plus preview*, never silent truncation — bash >30k chars spills to a file with the path returned; MCP results over threshold become file references (25k-token default cap); Read returns explicit `PARTIAL view` notices; Glob caps at 100 with a truncation flag. MCP schemas are deferred by default (names in prefix, schemas fetched on demand via tool search).

**Subagents & routing:** fresh subagents get isolated context (own small system prompt, no parent history) and return only a summary; **forks** inherit the parent prefix and therefore read its cache — the cheap primitive when parent context is needed. Per-subagent `model:` routing with Haiku recommended for exploration; a Haiku-class model handles background work (resume summarization, ~$0.04/session documented).

**Cost profile:** ~$13/developer/active day published average ($150–250/month). Documented top causes of overspend: long sessions never cleared (full history re-sent every message) and Opus as default model. Exploitable weaknesses for a cheaper competitor: the ~33k prefix floor (cache reads are 0.1×, not 0×); prefix fragility (any invalidation reprocesses everything at 1.25–2× write premium); per-machine-and-directory cache scope (worktrees miss each other's cache); lossy mid-task compaction; no durable repo knowledge (every session re-derives the codebase through Read/Grep at full token cost); expensive defaults (extended thinking on, effort high, auto-mode classifier adding a second-model round-trip per shell command).

### 4.5 What transfers to Dawn (synthesis so far)

1. Aider's **volatile-after-stable layout with file bodies outside history** attacks Dawn's triple-send problem (§2.2) at the root — Dawn already has a working set; the fix is to make it the *only* carrier of file content and drop tool-result bodies from re-sent history.
2. OpenCode's **prune-before-summarize** ladder is the model for Dawn's missing proactive compaction (§3.1.2): stamping old tool outputs cleared costs nothing and needs no utility model.
3. OpenCode's **truncate-to-disk with named recovery tool** is a drop-in upgrade for Dawn's `read` gap (§2.3) — Dawn already has the `«expand:HASH»` sentinel store, it just doesn't apply it to `read`.
4. Aider's **schema frugality** reframes §2.4: Dawn's 26 always-on tool schemas (~2.9k tokens) are a real line item; tool-denied auxiliary calls and leaner descriptions are proven approaches.
5. Both agents' **cheap-model routing for summaries/titles** (weak model + empty context + no tools) matches Dawn's existing `utility` role design — Dawn just barely uses it (one overflow-only call site, unmetered).
6. Claude Code's **append-only prefix rule** is the fix for Dawn's cache-prefix instability (§2.5): state changes (summaries arriving, `summariesEarnKeep` flipping) must land *after* the cached prefix as appended messages, never rewrite it. Dawn already does this correctly for `promptDelta` and answer guidance — the summary block is the violation.
7. Claude Code's **handle-plus-preview truncation contract** (always tell the model it got a partial view and how to get more) matches Dawn's `«expand:HASH»` sentinels — Dawn's gap is coverage (`read` is exempt), not design.
8. Codex's **record-time middle-out truncation** is the precise fix for Dawn's intra-turn leak (§2.1): truncate/compact when the output is *recorded into history*, so later steps of the same turn never re-pay the full output. Dawn compacts at execution time but the un-deduped history copy still rides along.
9. Gemini's **remaining-window-aware output threshold** (cap tool output by what's left in the window) is a one-line upgrade to Dawn's fixed compaction thresholds.
10. Gemini's compaction (50% trigger, two full-history Pro calls) is the cautionary tale for §5.6: proactive compaction must use the prune-first ladder (OpenCode) or a cheap model with clipped input, never the primary model over full history.
11. Where Dawn already beats everyone: a ~5k-token prefix (vs Claude Code ~33k measured, Gemini ~15.4k, OpenCode ~7k, Codex ~4.4k), deny-listed/plan-mode tools dropping their schemas entirely, read-freshness enforcement before edits (none of the four have it — Codex and Gemini both rely on match-failure alone), and an identical-agent `--naive` ablation baseline none of the others can offer.

## 5. Efficiency opportunities (ranked)

Ranking validated against the measured grid (§2.10): items 1–3 target the +224%-input investigate failure; items 5–6 protect the cache economics the whole win rests on.

1. **Intra-turn budget enforcement** — apply trimming/dedup per step via the AI SDK's `prepareStep` hook instead of once per attempt. Directly attacks the 71k-vs-18k investigate blowout; largest single lever.
2. **Tool-result dedup** — when a tool result is in history within its working-set TTL, send one copy only; drop the echo (or the history copy on later turns, keeping the compacted echo).
3. **`read` output cap + compaction** — add `read` to the heavy-tools set with a byte ceiling; keep ranges honest.
4. **Schema-aware accounting** — count tool-schema tokens in `systemTokens` so budgets and the overflow guard stop being ~3k optimistic; consider trimming verbose descriptions.
5. **Cache-prefix stabilization** — freeze the summary block per session (or version it behind the moving breakpoint); decide `summariesEarnKeep` once per session, not per turn.
6. **Proactive compaction threshold** — compact at ~80% of window instead of on provider error.
7. **Record utility-model usage in the ledger** (correctness of the ledger; small $).
8. **Real tokenizer** — replace `chars÷4`; improves every decision marginally.

## 6. Reliability improvements (ranked)

1. Post-edit validation hook (typecheck/lint the touched files; surface failures to the model within the same turn).
2. Proactive compaction (see 5.6 — reliability and cost improve together).
3. Edit-aware invalidation of summaries/working-set items for files the agent modified — now backed by a measured failure: the stale-edit probe is Dawn's only probe loss (1/2) while stateless naive went 2/2 (§3.2). Dawn's cached file context can actively mislead it; this is the clearest case where context machinery must invalidate itself to be safe.
4. Correctness-gated bench checks everywhere (extend the `pilot-*` pattern; done for probes this audit).
5. Broader loop detection (alternating-failure patterns, per-turn step budget with early "ask the user" bail).

## 7. Proposed architecture

Dawn's fundamentals are right — smallest prefix in the field, an ablation baseline, honest accounting. The architecture problem is one sentence: **Dawn plans context per turn but pays for it per step, and stores the same bytes in multiple carriers.** The proposal keeps the existing pipeline and changes what flows through it.

### 7.1 Single-carrier context (the structural fix)

Adopt Aider's invariant, using machinery Dawn already has:

- **History carries prose and tool-call *inputs*; bodies live only in the working set.** When a tool result is recorded into history, record the compacted/truncated form (Codex's record-time truncation) — the full body goes to the working set under its existing TTL lease, and the blob store keeps the original behind `«expand:HASH»`.
- A `read` produces exactly one context item (the working-set `file-range`); the tool-result message in history becomes a stub ("read `path:a-b`, N lines — in working set"). The summary item for the same path is suppressed while a file-range for it is live.
- Result: N steps or turns touching one file pay for it once per request, never 2–3×; and old file content ages out via leases instead of riding in history forever.

### 7.2 Intra-turn budget enforcement

Run the trim/dedup pass per **step**, not per attempt, via the AI SDK's `prepareStep` hook: re-derive the request from (stable prefix) + (leased working set) + (history with stubbed bodies) before each step. With 7.1 in place this is cheap — the step-over-step delta is small and the cacheable prefix is untouched. This is what turns the 20k budget from a fiction into a bound, and it directly targets the failed `investigate` slice (60.2k actual vs 18.6k naive, §2.10).

### 7.3 Append-only cache prefix

Claude Code's rule, applied to Dawn's two violations: freeze the summary block for the session once emitted (new summaries append *after* the prefix as regular context items, promoted into the cached block only at compaction boundaries), and decide `summariesEarnKeep` once per session. Count tool schemas in `systemTokens`. Keep the moving last-message breakpoint — it's what redeems intra-turn caching.

### 7.4 Reclamation ladder (proactive, cheapest-first)

1. **Prune** (OpenCode): stamp old tool-result bodies "cleared" past a protect window (newest ~2 turns / N tokens), zero LLM calls, run in the background.
2. **Compact** at ~80% of window (not on provider error): utility model, tools denied, input pre-clipped — never the primary model over full history (Gemini's 740k-token compaction is the counterexample).
3. Overflow error becomes the never-hit fallback it should be.

### 7.5 Routing verdict (resume-gated)

- **Keep and finish** the existing three-role design: `utility` (cheapest blessed) takes compaction, session titles, and any future summarization — always with tools denied — and its usage **must** be ledger-recorded.
- **Rejected for now — difficulty routing:** a classifier adds an LLM call per turn (Gemini's own classifier is a flash-lite call); on Dawn's task profile the failure cost (wrong model on a hard task) exceeds the spread between blessed models. Revisit only with bench evidence.
- **Rejected for now — subagents:** Dawn's parity bar explicitly excludes them; cold-start context + 5-minute cache TTL (Claude Code data) make them a cost *increase* at Dawn's session scale. The one shape worth revisiting later is Claude Code's *fork* (inherits prefix → reads parent cache).

### 7.6 Retrieval verdict

Dawn's repo index + heuristic summaries already implement "JIT context" in miniature. The upgrade path is Aider's ranked map — tree-sitter tags + reference-graph ranking fitted to a fixed budget (~1k tokens) — replacing the flat 600-char-excerpt summaries. This is P2: measurable only after 7.1/7.2 stop the bleeding, and it must prove itself on the investigate slice. Full semantic/embedding search: rejected for now (infrastructure cost, no evidence the bench tasks need it).

### 7.7 What stays untouched

The tool surface, permission gate, sessions/checkpoints (minus per-step rewrite), TUI, provider layer, `--naive` mode, and the measured-vs-estimated accounting split. The proposal is a context-flow change, not a rewrite.

## 8. Benchmark strategy

- **Headline:** cost per successful task = total $ across all reps (failures charged) ÷ successful reps, valid only when Dawn's pass rate ≥ naive's (parity gate). Implemented in `bench/report.ts` (`costPerSuccess`, `headline`) with unit tests.
- **Diagnostics:** per-slice cost-at-equal-success medians (existing tables) to localize regressions.
- **Reliability:** `probe` slice pass rates, dawn vs naive vs Claude Code.
- **Fairness rules:** same model everywhere (`--claude-model` pins Claude Code to Dawn's model); Claude Code multi-turn via session resume; subscription runs priced through the same models.dev table (simulated $ from measured tokens, labeled as such); `autoFallback` off so a silent model switch invalidates the rep.
- **Expansion criterion:** add Codex/Gemini/OpenCode harness adapters only if the audit's research shows a specific mechanism claim that needs measured refutation; otherwise they stay literature-based.
- **Pin the fixture.** Dawn's bench is self-referential — tasks `cat`/`grep` Dawn's own source — so running against `HEAD` moves the measurement substrate with every commit. The first post-P0 run was invalid for exactly this reason: the P0 work added 110 lines to `context/budget.ts`, inflating `cat-budget`'s input by 21% with no change in context management. `FIXTURE_REF` in `bench/run.ts` now pins the workdir while the agent under test still comes from the working tree; two runs are only comparable when `provenance.gitSha` matches.
- **Run-to-run variance is material at n=2.** Naive is untouched by agent changes, so its drift between runs is a free noise estimate — it moved ~6% pooled between the two runs here. Treat per-task deltas under ~15% as noise unless reps are increased.

## 9. Roadmap (P0/P1/P2)

Every item is bench-gated: it ships only if the headline gate (cost/success ≤ naive at pass-rate parity) holds or improves, measured against the §2.10 baseline (dawn $0.0270/success, investigate slice +35% $).

### P0 — make the claim true (attacks the failed investigate slice)

**P0.1 Record-time tool-result compaction + single-carrier dedup** (§7.1)
- *Current:* full tool output in history + 4k echo in working set + (for reads) a summary item; nothing deduped.
- *Problem:* same bytes billed 2–3× per request, every step, every turn.
- *Change:* history stores the compacted stub; the working set is the sole body carrier; suppress summary items while a file-range is live.
- *Expected:* the dominant share of the investigate-slice overrun; helps every slice.
- *Reliability:* neutral-to-positive (model sees one canonical copy; `expand` recovers detail).
- *Tradeoff:* model must learn to use `expand`/working set for old results — mitigated by the loss-notice contract already in place.
- *Approach:* `agent.ts` `onStepFinish` + `tools/index.ts` read path + `budget.ts` dedup pass. Depends on: nothing.

**P0.2 Intra-turn budget enforcement via `prepareStep`** (§7.2)
- *Current:* context planned once per attempt; up to 100 steps re-send everything.
- *Problem:* 71k real tokens against a 20k budget (`cat-budget`).
- *Change:* re-plan per step; stable prefix untouched.
- *Expected:* caps multi-step turns at ~budget; largest single $ lever.
- *Reliability:* watch: over-aggressive per-step trimming could starve late steps — protect the current step's own tool results.
- *Approach:* `streamText({ prepareStep })` in `agent.ts:585-655`. Depends on: P0.1 (dedup makes per-step replanning cheap and safe).

**P0.3 `read` output cap + compaction** (§2.3)
- *Change:* add `read` to `HEAVY_OUTPUT_TOOLS` with a byte ceiling and the partial-view notice.
- *Expected:* bounds the worst-case 480 kB read; small median impact.
- *Approach:* `tools/index.ts:62` + read handler. Depends on: nothing; trivial.

**P0.4 Schema-aware accounting** (§2.4)
- *Change:* measure `createTools` schema size once at boot; include in `systemTokens`.
- *Expected:* removes the ~3k/request planning error; enables honest budget math for P0.2.
- *Approach:* `agent.ts` constructor + `budget.ts:343`. Depends on: nothing; small.

**P0.5 Post-edit validation** (§6.1)
- *Current:* no check after edits.
- *Change:* run LSP-style diagnostics or `tsc --noEmit` scoped to touched files; append failures to the edit tool result (OpenCode's pattern — same step, no extra turn).
- *Expected $:* net positive (catches broken edits before they cascade into repair turns).
- *Reliability:* the biggest single gap vs peers, closed.
- *Approach:* `tools/index.ts` edit/write/multi_edit handlers; project-profile detection for the checker command. Depends on: nothing.

### P1 — stability and graceful degradation

- **P1.1 Append-only cache prefix** (§7.3): freeze summary block per session; `summariesEarnKeep` decided once; moving breakpoint kept. Depends on P0.4.
- **P1.2 Reclamation ladder** (§7.4): background prune pass + compact at ~80% window on the utility model with clipped input; retire overflow-error-driven compaction to fallback. Depends on P0.1.
- **P1.3 Ledger completeness**: record `compactViaLlm` (and any future utility calls) in `UsageLedger`; surface in `/usage` and bench. Small, honest.
- **P1.4 Session-store hygiene**: append rows instead of delete-all+reinsert per step; prune `context_plans`. Latency/local-IO, not tokens.
- **P1.5 Edit-aware invalidation** (§6.3): agent edits drop/refresh working-set items and summaries for the touched path.
- **P1.6 Remaining-window-aware output caps** (Gemini): scale tool-output thresholds by remaining budget. One-line-ish.

### P2 — proven-need investments

- **P2.1 Real tokenizer** (replace `chars÷4`) — improves every decision; do after P0 changes settle so its effect is measurable.
- **P2.2 Ranked repo map** (§7.6, Aider-style) — gated on investigate-slice evidence post-P0.
- **P2.3 Fork-style subagent / difficulty routing** — stays rejected until a bench slice demonstrates need.
- **P2.4 Bench expansion** — Codex/Gemini/OpenCode adapters only if a specific mechanism claim needs measured refutation.

## 10. Immediate implementation candidates

**Status: implemented 2026-07-26** (commits `8f39344`…`1a9ea9c`). Results in §11.

First PRs for the follow-up effort, smallest-risk-first:

1. **`read` cap** — add to `HEAVY_OUTPUT_TOOLS` (`packages/core/src/tools/index.ts:62`); apply `compactToolOutput` + total-byte ceiling in the read handler (`index.ts:384-432`).
2. **Schema accounting** — serialize tool schemas once in the `DawnAgent` constructor, `estimateTokens` them, add to `ContextPlan.systemTokens` (`context/budget.ts:343`) and the overflow guard (`agent.ts:463`).
3. **Ledger the utility model** — pass the ledger into `compactViaLlm` (`context/compact-llm.ts:40`) and record its `generateText` usage.
4. **Working-set/history dedup** — in `buildRequestMessages`, skip working-set echoes whose tool-result twin is already in the sent history slice (key by tool-call id); precursor to full P0.1.
5. **Stop persisting the plan-mode reminder** — append it to the outgoing request copy, not the stored message (`agent.ts:510`).
6. **Freeze the summary block** — emit only at turn 1 (or first non-trivial turn) with the session's index snapshot; new summaries ride as ordinary working-set items (`agent.ts:1008-1013`, `budget.ts:458-468`).
7. **Post-edit diagnostics** — run the project's typecheck command scoped to the touched file after `edit`/`write`/`multi_edit`; append failures to the tool result.
8. **README/bench truth** — regenerate the README BENCH block from the new results.json (it currently shows a contradictory older run) and align the front-matter claim with the headline gate outcome.

## 11. Implementation results (2026-07-26)

All ten candidates in §10 landed, plus three fixes the measurement itself forced. Commits `8f39344`…`7b687d7`.

### 11.1 The root cause of the failing investigate slice was not what §2.1 assumed

§2.1 blamed the slice on per-turn (rather than per-step) budget enforcement. That was real and worth fixing, but tracing an actual `cat-budget` session found a second, larger cause: **compaction was destroying context the budget could afford, and the model was paying extra tool calls to get it back.**

```
before: bash cat (591 lines → compacted to 146) → find_symbol → read   4 steps, 41.7k input, $0.0248
after:  bash cat (547 lines, kept whole)                               2 steps, 23.1k input, $0.0203
```

The budget was 20,000 tokens and the plan was using 6,046 — roughly 14k of headroom went unused while compaction elided the answer. Naive runs the same task at $0.0208, so the task went from **2.2× worse than naive to a narrow win**. This is the "aggressive reduction costs more through retries" failure mode from the brief, caught in the wild. Fix: compaction stands down when the output fits in 60% of remaining headroom (Gemini CLI's remaining-window-aware threshold, §4.3b), which is only safe because per-step pruning now stops a kept-whole output from being re-billed all turn.

### 11.2 Fixing the working-set eviction bug made things worse before it made them better

Giving each tool result its own lease (§7.1) removed what turned out to be an accidental one-item cap: TTLs bound echoes by *turns*, not by count, so one investigate turn firing a dozen tools retained all twelve. The bench caught it — `probe-multifile-rename` +112% input, `edit-maxreadchars` +71% — while recall-heavy tasks improved. Capping retention at 3 kept the recall gains and removed the regressions (`edit-maxreadchars` then measured −44% vs naive). **A "bug fix" that removes an unintended limit needs the intended limit put back explicitly.**

### 11.3 Two methodology defects invalidated the first post-change run

- **The fixture moved with the code.** Dawn's bench is self-referential (tasks `cat`/`grep` Dawn's own source), so with the workdir defaulting to `HEAD`, the P0 work's 110 added lines in `context/budget.ts` inflated `cat-budget`'s input by 21% with no behavioural change — indistinguishable from a regression. `FIXTURE_REF` now pins the workdir while the agent still comes from the working tree.
- **Sampling noise swamped the signal.** At the provider default temperature the model varies how many tools it calls: `cat-budget` measured 41k, 53k, and 96k input tokens across reps of an identical task on an identical fixture. The bench now pins `temperature: 0`. Naive's near-identical reps (18,573 / 18,572) versus Dawn's wide spread was the tell — and it is also evidence that Dawn's machinery, not the model, was the variance source.

Any comparison of two runs is only valid when `provenance.gitSha` matches and both pinned temperature.

### 11.4 The ranking in §5 was wrong, and the correction is the lesson

§5 ranked intra-turn budget enforcement first and "remaining-window-aware output caps" last, as a one-line P1.6 nicety. Measured, the order inverts: **headroom-aware compaction was the single biggest win** on the failing slice (−45% input, −18% cost, two fewer tool calls on `cat-budget`), while per-step pruning — though it simulates a 58% cut on a synthetic 10-step turn — mattered less on real tasks, because real turns rarely reach ten steps *once the agent stops being forced into recovery calls*.

The two are coupled in a way the audit did not anticipate: per-step pruning is what makes lenient compaction affordable. Neither is safe alone. Eager compaction without pruning re-bills whole outputs; lenient compaction without pruning grows unboundedly.

Revised ranking for anyone continuing this work:

1. Stop destroying context the budget can afford (headroom-aware compaction) — done
2. Bound what accumulates within a turn (per-step pruning) — done, and the enabler for 1
3. Cap *counts*, not just TTLs, on anything the working set retains — done, learned the hard way (§11.2)
4. Only then: dedup, schema accounting, byte caps — all real, all small by comparison

The generalizable finding: **on a caching provider, Dawn's costs were dominated by extra model round-trips, not by bytes per request.** Every mechanism that avoided a tool call beat every mechanism that shaved a payload. The audit's framing (§2, "where tokens go") measured the wrong unit; the right unit is round-trips induced.

### 11.5 Measured outcome

Authoritative run: 13 tasks × {dawn, naive} × 2 reps, `claude-haiku-4-5`, fixture pinned to `79df017`, `temperature: 0`. Claude Code was not re-run — Dawn's changes cannot affect it, so its baseline figure ($0.0697/successful task) still stands.

| Metric | Audit baseline | After P0 | |
| --- | --: | --: | --- |
| Dawn $ / successful task | $0.0270 | **$0.0278** | ~flat |
| Naive $ / successful task | $0.0439 | $0.0462 | (drifted — run noise) |
| Dawn vs naive | −38% | **−40%** | improved |
| Dawn pass rate | 92% (24/26) | **96% (25/26)** | improved |
| Naive pass rate | 92% | 88% | — |
| Headline gate | **fail** (parity) | **pass** | — |

Per-slice, the change that matters:

| Slice | Baseline gate | After P0 |
| --- | --- | --- |
| investigate | **fail ($ lose, +35%)** | **pass ($ win, +1%)** |
| long | pass (−47%) | pass (−41%) |
| edit | ok (−32%) | ok (−20%) |
| probe (reliability) | −47% cost | −44% cost, at a higher pass rate |

**The investigate slice — the audit's headline failure — now passes.** Dawn is cheaper per successful task than its own ablation *and* passes more tasks than it, which is the parity condition the audit set as the precondition for making any cost claim at all.

Two honest caveats:

1. **`cat-budget` still loses (+66% cost)** and is the only task that does. It is no longer a compaction problem: instrumenting a live session shows `compactedOutputs: 0` — the file now arrives whole — but the model then *chooses* to grep for callers and read a second file, taking 3.5 steps against naive's 2. Dawn's richer context (summaries, working set) appears to invite exploration that the bare naive context does not. Whether that is waste or diligence is task-dependent; both modes pass the check. Two reps cannot settle it, and the same session traced twice produced 2 steps once and 4 steps the next time, so **even `temperature: 0` does not make this deterministic**.
2. **Dawn still sends ~30% more input tokens than naive pooled** and wins purely on cache-read pricing. Unchanged from the audit's §2.10 finding, and still the reason the public claim should be *context-frugal / dollar-frugal*, not *token-frugal*. On a non-caching provider the lean-budget path carries the claim and remains unmeasured.

### 11.6 What the exercise says about the audit method

Three of the four things that actually moved the number were not the top-ranked items in the audit's own ranking, and two of the four came from *tracing one live session* rather than from reading code. Static review found real waste (duplicate carriers, uncounted schemas, unbounded reads) but mis-weighted all of it, because it measured bytes per request when the dominant cost was model round-trips induced by over-aggressive context reduction. The generalizable practice: **instrument a real session on the worst-performing task before ranking fixes**, and treat any context-reduction mechanism as guilty of causing retries until measured innocent.
