# Dawn V2 — Architecture, Context & Long-Horizon Reliability Report

**Date:** 2026-08-11 · **Repo state:** `b111a4b` · **Status:** Phase 0 research complete;
long-horizon pilot **built but not yet run** (§I) · **Decision gate: no implementation
begun**

**Companion:** [Token-Goat study](./token-goat-study.md) (§E/§F/§G in full)
**Prior art:** [2026-07 cost & reliability audit](../audit/2026-07-cost-reliability-audit.md)
— cited throughout, not restated.

---

## 0. Executive summary

**Three findings shape everything below.**

**1. The V2 brief's primary metric is pointed the wrong way for Dawn.** The brief asks for
−30% to −60% *uncached input tokens per successful task*. Dawn's measured position is the
opposite by construction: it sends **~30% more** input tokens than its own naive ablation
and wins **−40% on cost per successful task** because that extra context bills at
cache-read rates. Optimizing the brief's metric means unwinding the mechanism that
produces the current win. **Decision taken: the headline stays cost per successful task
with the pass-rate parity gate**; uncached tokens become a reported diagnostic.

**2. The audit's own follow-up already refuted "less context is better."** Audit §11.4
measured that Dawn's costs were dominated by **model round-trips induced by
over-aggressive context reduction**, not by bytes per request. Compaction was destroying
context the budget could afford and the model paid extra tool calls to recover it
(`cat-budget`: 4 steps / 41.7 k tokens → 2 steps / 23.1 k once compaction stood down).
A V2 built on "minimize the working set" would re-introduce this exact failure. The V2
design rule that follows is in §J.5.

**3. The genuinely unsolved half is long-horizon reliability, and it is unmeasured.**
Dawn's longest benchmark task is **4 user turns**. The brief asks about 20–40+ step
sessions. There is no evidence either way about whether Dawn degrades over long sessions —
and one measured hint that its context machinery can *cause* failure: `probe-stale-edit`
is Dawn's only probe loss (1/2) while stateless naive went 2/2.

**What this report delivers:** a refreshed architecture map against current code (§A/§B),
a delta waste audit that separates fixed from open (§C), a structural degradation audit
(§D), the Token-Goat study (§E–§G), an honest restatement of the baseline (§H), a
**built-but-unrun** long-horizon experiment (§I), the V2 architecture (§J–§L), the
benchmark and migration plans (§M/§N), risks (§O), and the questions that genuinely need
a decision (§P).

**What it does not deliver:** any V2 implementation. Per brief §96, this is the gate.

---

## A. Dawn V1 architecture — current state `[refreshed]`

The audit's §1 describes **pre-P0 Dawn** and is now stale in six places. This section is
written from current code.

### A.1 Request assembly

`DawnAgent.requestMessages()` (`agent.ts:457`) runs **once per attempt** (`agent.ts:633`),
and `buildRequestMessages()` (`context/budget.ts:397`) produces the wire order
(`budget.ts:608-610`):

```
system                          (+cacheControl)   built once at boot (agent.ts:307)
[repo summary block]            (+cacheControl)   append-only, frozen once full
history[0 .. n-2]                                 trimmed to budget remainder
[working set + loaded skills]                     volatile — placed here on purpose
[answer guidance]                                 per-turn
history[n-1]                    (+moving cacheControl)
```

The volatile blocks sit **after** the cacheable prefix and **before** the moving
breakpoint — this is the append-only-prefix discipline the audit recommended (§7.3) and it
is now correct for the summary block too: `relevantSummaries()` is append-only,
insertion-ordered, never re-sorted, and frozen once it hits its cap (`agent.ts:1078-1083`),
explicitly so the rendered block stays byte-identical.

### A.2 Budgets

`budgetFor()` (`provider/profile.ts:48`):

| Model class | minimal | balanced | deep |
| --- | --- | --- | --- |
| Caching | `min(12k, win×6%)` | `min(20k, win×10%)` | `min(32k, win×15%)` |
| Non-caching (lean) | 6,000 | 8,000 | 12,000 |

Allocation is strictly sequential subtraction: system (incl. tool schemas) → summaries
(35% cached / 12% uncached share) → history → working set gets the remainder.

### A.3 The working set — the only lifecycle machinery that exists today

`ContextWorkingSet` (`context/working-set.ts:15`). Four kinds: `file`, `file-range`,
`summary`, `tool-result`. TTL is measured **in turns** (`budget.ts:39-47`):

| Kind | minimal | balanced | deep |
| --- | --- | --- | --- |
| summary | 6 | 10 | 14 | (and never actually expires — `decrementLeases` exempts them, `working-set.ts:51`) |
| file / file-range | 3 / 4 / 6 lean; **9999 when budget > 20k** | | |
| tool-result | 1 | 2 | 3 |

Plus a hard count cap, `MAX_TOOL_RESULT_ITEMS = 3` (`working-set.ts:13`), added after the
bench measured that TTLs alone bound echoes by *turns* not *count* — one investigate turn
firing a dozen tools retained all twelve, costing +112% input on `probe-multifile-rename`.

**This is a lease system, not a lifecycle.** There is no supersession, no pinning, no
provenance, and no state beyond "present with N turns left".

### A.4 Three memory mechanisms, only one of which uses an LLM

1. **File summaries** — deterministic. `summarizeEntry()` (`summarize.ts:22`) concatenates
   language + size + first 20 symbols + first 20 imports + an 8-line/600-char excerpt.
   Cached in SQLite on content hash.
2. **Session memory** — deterministic, template-based, **zero LLM calls**
   (`session-memory.ts`, header comment lines 11-12). `distillDroppedTurns()` diffs kept
   vs all messages by object identity, and captures per dropped turn: the user ask's first
   line, edited file paths, bash commands (80 chars), tool errors, and the assistant's
   first 2 closing lines. Capped at `MAX_MEMORY_CHARS = 4000`, newest-first.
3. **Overflow compaction** — the only LLM-backed one. `compactViaLlm()`
   (`compact-llm.ts:22`) summarizes the oldest half of turn-groups on the `utility` model,
   splices them out, `MAX_COMPACTIONS = 2` (`agent.ts:609`). Triggered **only** by a
   provider `context-overflow` error. Falls back to the deterministic distiller on failure.

### A.5 Tool surface and output handling

**26 tools, measured at 2,926 schema tokens** (measured this session via
`estimateToolSchemaTokens`), charged into `ContextPlan.systemTokens`. `visibleTools`
(`tools/index.ts:1367-1379`) drops 7 side-effecting schemas in plan mode and any
`deny`-permissioned tool — those cost zero prefix.

Three independent truncation layers:

| Layer | Where | Gated on `--naive`? |
| --- | --- | --- |
| Per-tool hard caps (`truncateMiddle`: bash 30 k, grep 15 k, git_diff 20 k, web_fetch 12 k chars; glob 500, ls 300) | tool handlers | **No** |
| `compactToolOutput` — `detectKind` → json/search/log/text compactors, with a **headroom stand-down** (`HEADROOM_KEEP_SHARE = 0.6`) and an inflation guard | `withCompaction` wrapper over `HEAVY_OUTPUT_TOOLS` | Yes |
| `pruneToolResults` — intra-turn, replaces older tool bodies ≥400 chars with `«expand:HASH»` stubs, protecting the newest `max(2000, budget/2)` tokens | `prepareStep` (`agent.ts:666-679`) | Yes |

**The observation store already exists in embryo.** Compacted originals go to a SQLite
`compacted_blobs` table keyed by `sha256(raw).slice(0,10)`, LRU-bounded at
`MAX_BLOBS = 2000` (`context/store.ts:14-15`, `249-278`), retrievable via the `expand` tool
with regex + offset/limit. This is the most V2-ready machinery in the codebase.

### A.6 Accounting

Tokens are **provider-measured**; dollars are **computed locally** from the models.dev
catalog across four buckets (`usage/ledger.ts:10-29`). Uncached input is *derived*
(`inputTokens − cached − cacheWrite`, `ledger.ts:21`), not reported by the provider.
The UI refuses to blend measured and estimated (`status.ts:178-180`).

### A.7 `--naive`

A single constructor flag disabling twelve mechanisms: summaries, history trimming,
working-set trimming, single-carrier dedup, all three cache breakpoints, intra-turn
pruning, tool-output compaction, session memory, and overflow-degrade rebuild. It does
**not** disable per-tool hard caps, read line/char caps, the 4 k tool-result echo
truncation, or TTL decrementing. It is the same agent — a genuinely fair ablation, and an
asset none of the surveyed competitors can offer.

---

## B. Request lifecycle `[refreshed]`

A turn (`agent.ts:535`):

1. Turn bookkeeping; user message pushed and persisted; shadow-git checkpoint. The
   plan-mode reminder rides **per-turn guidance only** and never enters stored history
   (`agent.ts:86-91`, `545-548`) — the audit's §2.6 complaint is fixed.
2. Skill auto-triggers into a 4 k LRU buffer; repo-overview questions force a
   `repo_overview` first step via `toolChoice`.
3. Attempt loop, `MAX_ATTEMPTS = 4` (2 retries + 2 model switches). Per attempt: resolve
   profile → filter visible tools → **compile context** → `streamText` with
   `stopWhen: stepCountIs(100)`.
4. **Per step**, `prepareStep` does three things: force `repo_overview` on step 0 when
   applicable; strip reasoning parts after step 0; run `pruneToolResults`. This is the
   only intra-turn context intervention — the summary/history/working-set plan is **not**
   recomputed mid-turn.
5. `onStepFinish` pushes `step.response.messages` into history and persists. History grows
   at clean step boundaries.
6. Stream handling: tool results become working-set echoes (`truncateMiddle(…, 4000)`,
   tagged with `toolCallId`); 3 identical tool failures inject a loop-break message; usage
   recorded per step; errors classified into retry / model-switch / overflow-compaction.

**The load-bearing asymmetry:** context is *planned* per attempt but *paid for* per step.
`pruneToolResults` bounds what accumulates within the turn, but the summary block, history
selection, and working-set membership are fixed for the whole turn regardless of how many
steps it runs.

---

## C. Context waste audit — delta `[refreshed]`

### C.1 Closed since the audit

| Audit finding | Status | Evidence |
| --- | --- | --- |
| §2.1 budget enforced once per turn | **fixed** | `pruneToolResults` in `prepareStep`, `agent.ts:666-679` |
| §2.2 tool results paid twice | **fixed** | single-carrier dedup by `toolCallId`, `budget.ts:488-495` |
| §2.3 `read` uncapped | **fixed** | 120/240/600 lines, 24/40/80 kB, `budget.ts:49-61` |
| §2.4 schema tokens invisible | **fixed** | `schemaTokensCache`, `agent.ts:445-455`; measured 2,926 |
| §2.6 plan reminder persisted per turn | **fixed** | rides guidance only, `agent.ts:545-548` |
| §2.7 utility spend unledgered | **fixed** | `agent.ts:888-891` |

### C.2 Still open

**1. `read` produces two carriers for the same file.** A single read registers a
`file-range` item (`tools/index.ts:469-481`) **and** a `summary` item for the same path
(`tools/index.ts:482-492`). Audit §7.1 proposed suppressing the summary while a
file-range is live; that did not land.

**2. Range-overlap blindness.** `hasFileRange` matches on an exact composite key
(`working-set.ts:39-42`). Reading lines 1–200 after having read 1–240 misses the dedup
entirely and re-sends the whole range. This is the weakest possible form of repeat-read
prevention and is the direct seam for brief §30/§31.

**3. The repo index is regex-only, TypeScript/JavaScript-only, and never runs
automatically.** `parseLightweight()` (`indexer.ts:101-133`) returns three empty arrays for
every non-TS/JS file (`indexer.ts:109`), caps each category at 80 entries, and runs only
via `dawn index` or the bench harness. Retrieval is a linear scan over ≤2000 rows scoring
term overlap (`store.ts:138-158`). Everything the brief §24 calls "code intelligence" is
absent.

**4. No typed tool results.** `detectKind` (`compact/detect.ts:10-37`) routes to four
generic compactors — json / search / log / text. A `bun test` run lands in `log` or `text`
and is rendered as head + tail + up to 20 anchor-matched error lines, **not** as pass/fail
counts and failed test names. Brief §37/§38 is entirely unimplemented. (The anchor rule is
better than it sounds: `ERROR_RE` matches `error|exception|fail|panic|fatal|warn|traceback`,
so genuine failures do survive middle-elision.)

**5. `chars ÷ 4` estimator — direction now uncertain, and that is itself a finding.**
The audit asserted (§2.8) that the estimator systematically over-admits content. I tried to
measure this from 271 historical context plans paired with the provider's own token counts
for the same request. **The historical data cannot settle it:**

| Sample | n | Median measured/estimated | Implied chars/token |
| --- | --: | --: | --: |
| Pre-schema-accounting plans (raw) | 195 | 1.442 | 2.77 |
| Pre-schema-accounting, +2,926 schema tokens added back | 195 | 0.717 | 5.58 |
| **Post-schema-accounting (current code)** | **6** | **1.072** | **3.73** |

The 195 pre-P0 plans omit the ~2.9 k tool-schema term entirely, so their apparent 44%
under-count is mostly that missing term, not tokenizer error — and a flat correction
over-shoots in the other direction, because those sessions ran older code with a different
tool set. The only clean sample is n=6 on one provider (`openrouter/free`, unknown
tokenizer, one obvious outlier at 0.49). **The honest statement is that once schema tokens
are counted the estimator is roughly right, and the audit's §2.8 claim is no longer
supported by evidence.** The horizon pilot (§I) records `planEstimate` against
`firstStepInput` per turn on a pinned model and will settle it.

**6. `/savings` models the naive baseline rather than measuring it.** `savingsMetrics`
(`status.ts:452-466`) computes "would send (naive)" as *measured input + estimated saved
tokens*. The UI labels it "Estimated avoided" and never blends it into a dollar headline,
which is honest — but the only defensible naive comparison is the bench.

**7. No untrusted-content handling on `web_fetch`.** It strips tags and hands the text
straight to the model (`tools/index.ts:818-854`); grepping the whole source for
`untrusted|injection` finds only unrelated comments. Orthogonal to context efficiency, but
a real hole and cheap to close (§J.7).

---

## D. Long-horizon degradation audit `[new]`

### D.1 What Dawn structurally cannot currently do

Mapping the brief's degradation modes against the code:

| Degradation mode | Dawn's defense today | Verdict |
| --- | --- | --- |
| **Forgotten user constraints** | None. Constraints live in conversation history and are trimmed by `trimHistory` like any other group. Session memory captures the *first line* of each dropped user ask (`session-memory.ts:29`) — a constraint stated in sentence three is gone. | **Undefended** |
| **Stale code after edits** | `assertFreshRead` gates *edits* on a content hash. Nothing invalidates a `file-range` or `summary` item already in context after the agent edits that file. | **Partially defended, and measured to fail** — `probe-stale-edit` is Dawn's only probe loss (1/2 vs naive 2/2) |
| **Repeated failed approaches** | Only 3 identical *tool errors* trigger a nudge (`agent.ts:810-827`). No semantic memory of an approach that ran successfully and produced a wrong result. | **Undefended** |
| **Repeated reads/searches** | Exact-key range suppression only (C.2 item 2). | **Weakly defended** |
| **Superseded requirements** | None. Requirement A and requirement B coexist in history with no supersession marker. | **Undefended** |
| **Buried evidence in huge outputs** | Genuinely defended — `compactText` force-keeps up to 20 anchor-matched error lines from the elided middle, and the original stays recoverable via `expand`. | **Defended** |
| **Compaction amnesia** | Overflow-only, `MAX_COMPACTIONS = 2`; deterministic session memory survives and accumulates. Better than an LLM-only summary, but what survives is a *template digest*, not the pinned facts. | **Partially defended** |
| **History explosion** | `this.messages` grows unboundedly; only overflow trims it. Trimming affects what is *sent*, not what is *held*. | **Undefended (availability cliff)** |

**The pattern:** Dawn's context machinery is good at *bounding volume* and has essentially
no concept of *information state*. Nothing in the codebase can express "this is superseded",
"this is pinned", or "this was tried and failed".

### D.2 The one measured signal, and why it points the right way

`probe-stale-edit` mutates a file underneath the agent between turns. Dawn 1/2; naive 2/2;
Claude Code 2/2. Naive holds no cached file state, so it cannot be misled by one. This is
the clearest available evidence that **context machinery can actively cause failure**, and
it is exactly the class of bug V2's source versioning must eliminate rather than deepen.

### D.3 Why the existing bench cannot answer the brief's question

Longest existing task: **4 user turns** (`probe-long-recall`). The brief asks about 20–40+
step sessions. The `long` slice is 3 tasks at 3 turns each. Nothing in the suite runs long
enough for history trimming, TTL expiry, session-memory accumulation, or compaction to
compose into a failure. **§I builds that instrument.**

---

## E / F / G. Token-Goat `[new]`

Full study: **[docs/v2/token-goat-study.md](./token-goat-study.md)** — architecture,
benchmark-claim classification, the ADOPT/ADAPT/REJECT table with reasons, and the §G
comparison matrix.

The four things that matter here:

1. **License:** PolyForm Noncommercial vs Dawn's MIT. Ideas only; no code, ever.
2. **The structural distinction:** token-goat intercepts a decision already made and must
   infer intent from the intercepted call. Dawn owns the runtime and can choose the
   representation *before* the call exists — and can measure the round-trip consequence,
   which an interceptor structurally cannot.
3. **Its benchmarks do not measure what Dawn needs to know.** Every headline figure is
   *bytes prevented at an interception point*: no ablation, no pass-rate gate, no
   task-success measurement. Its own README separates five reproducible micro-benchmarks
   (reindex 84 s → 1 s; hook cold start 86 ms → 30 ms) from unmethodologised marketing
   claims ("40–90% cost", "1.1 Gt tokens saved"). Only the former are citable, and even
   they carry no sample size.
4. **Biggest genuine adoptions:** the deterministic pre-compaction manifest with a sealed
   `MUST_PRESERVE` block (answers Dawn's undefended constraint-drift mode directly);
   refs carrying enclosing scope; diff-on-reread; cross-blob `recall` search. **Biggest
   rejection:** ~200 hand-written per-tool output filters — Dawn's four generic compactors
   already cover that ground, and audit §11.4 measured payload-shaving as the *low*-value
   lever.

---

## H. V1 benchmark baseline `[cited, with scope corrected]`

Committed run: `bench/results.json`, generated 2026-07-26, model
`anthropic/claude-haiku-4-5-20251001`, fixture pinned to `79df017`, `temperature: 0`,
2 reps.

**Scope correction the README does not state:** the file contains **13 of the 26 tasks**
in `tasks.ts`, and **dawn + naive lanes only** (`claudeModel: null`). The $0.0697 Claude
Code figure quoted in the README comes from a *separate, earlier* run and is not in this
file.

| Agent | Pass rate | Total $ | $ / successful task |
| --- | --: | --: | --: |
| Dawn | 25/26 (96%) | $0.6960 | **$0.0278** |
| Naive | 23/26 (88%) | $1.0632 | $0.0462 |

**Headline gate: pass** (parity ok, cheaper ok). Dawn is 40% cheaper per successful task
than its own ablation *while passing more tasks*.

Three things to read carefully:

- **The token inversion is real and is the point.** Pooled, Dawn sends **+30% input
  tokens** and costs **−35%**. The report's own prose says so: "more input tokens (caching
  discount offsets cost)" (`report.ts:284`). Cache reads bill at ~10% of input.
- **The investigate slice passes by 1%.** Not a comfortable margin.
- **`cat-budget` still loses: +156% input, +66% cost** (47,562 tokens, 20,075 cached, vs
  naive's 18,576). Audit §11.5 already established it is *not* a compaction problem —
  `compactedOutputs: 0`, the file arrives whole, and the model then chooses to grep for
  callers and read a second file. Dawn's richer context invites exploration naive doesn't
  attempt. Two reps cannot settle whether that is waste or diligence, and the same session
  traced twice produced 2 steps once and 4 the next — **`temperature: 0` does not make this
  deterministic.**

**Denominator note:** the headline charges failures (total $ ÷ successful reps) while the
per-slice diagnostics are medians over *successful reps only* (`report.ts:59-64`). The
tables are not contradictory; they answer different questions.

**Repo health at `b111a4b`:** `bun run preflight` green — 501 tests pass, `tsc --noEmit`
clean, `biome check` clean (verified this session, includes the new bench tests).

---

## I. Long-horizon baseline `[new — instrument built, pilot NOT run]`

### I.1 Status, stated plainly

**The harness is built, tested, and committed. The measurement has not been taken.** The
Anthropic OAuth session on this machine has expired (`dawn auth login anthropic` is an
interactive flow), and every alternative stored provider is either policy-blocked for
Claude models or a weak free-tier model on which an 11-turn agentic task would fail for
capability reasons that cannot be distinguished from horizon effects.

**No numbers are reported in this section because none were measured.** Anything else
would violate brief §60 and §94.

### I.2 What was built

**Five horizon tasks** (`bench/tasks.ts`, `slice: "horizon"`), 11–12 user turns each, with
cheap read/grep distractor turns between the setup and the question so that session length
— not task difficulty — is the variable:

| Task | Degradation mode | Structural check |
| --- | --- | --- |
| `hz-constraint-retention` | forgotten constraints (brief §70) | turn-1 edit landed **and** the frozen directory is untouched 11 turns later **and** the agent surfaced the conflict |
| `hz-stale-code` | stale source (brief §71) | recalled value is the post-edit one (33000), **not** the pre-edit one (8000) |
| `hz-failed-approach` | failed-approach resurrection (brief §72) | the explicitly-rejected fix (editing the assert) was not reused after the bug was reintroduced at turn 10 |
| `hz-buried-evidence` | buried evidence (brief §73) | the checksum from one FATAL line in 1,000 lines of noise is recalled without re-running |
| `hz-requirement-change` | requirement supersession (brief §74) | final value satisfies requirement B (50), not superseded A (20) |

Every check is structural — file contents, `git status`, subprocess exit codes, or an
exact `FINAL: <value>` token. No transcript-vibes checks of the kind the audit flagged at
§3.1.4.

**Per-step instrumentation** (`bench/run.ts`), recorded for horizon tasks only so
`results.json` stays readable for the other 26:

- `stepTrace[]` — per model call: turn, provider-measured input / cached / cache-write /
  output tokens. This is the context-vs-step curve the brief §78 asks for.
- `turnTrace[]` — per user turn: `planEstimate` (the chars÷4 model's own number) against
  `firstStepInput` (the provider's count for that same request), working-set tokens and
  item count, tool calls. **This settles §C.2 item 5 as a side effect.**
- `capacityLimit` — distinguishes `step-limit` / `timeout` / `context-overflow` from a
  wrong answer. Without this the reliability numbers are noise: `MAX_STEPS = 100` and
  `MAX_COMPACTIONS = 2` are structural ceilings, and a rep that hits one failed for a
  capacity reason, not a context-quality reason.

### I.3 Two design traps found and avoided while building it

**The fixture is pinned to `79df017`, which predates much of the current code.** My first
draft of `hz-stale-code` targeted `MAX_TOOL_RESULT_ITEMS` — a constant added *after* the
pinned ref. The task would have failed 2/2 in both lanes for a reason unrelated to
horizon length. A new guard test (`bench/tasks.test.ts`) now asserts that **every
`packages/…` path any task prompt names exists at `FIXTURE_REF`**, so this class of rot
fails in CI instead of silently corrupting a paid run.

**The bash tool's own 30 kB cap is not gated on `--naive`.** `hz-buried-evidence`
originally emitted ~43 kB with the FATAL line at the midpoint — squarely inside the region
`truncateMiddle` drops, **for both lanes**. The task would have measured the tool cap, not
context management. It is now sized to ~27 kB (1,000 lines), under the tool cap and well
over the 800-token compaction threshold, with the signal at the midpoint outside the
compactor's 80-line head and tail — so only `compactText`'s anchor rule can save it.

### I.4 What the pilot will produce when run

`bun run bench --tasks hz-constraint-retention,hz-stale-code,hz-failed-approach,hz-buried-evidence,hz-requirement-change --reps 2 --no-claude --no-aider --model anthropic/claude-haiku-4-5-20251001`

Estimated **$5–15**, ~60–90 min. Deliverables: per-lane pass rates by degradation mode;
context-vs-step curves for dawn and naive; the estimator ratio on a pinned model; and a
capacity-vs-quality failure split.

**Pre-registered interpretation limits, so the result cannot be spun after the fact:**
n=2 on 5 tasks **cannot** establish a reliability difference — it can only show a
direction and rule out gross effects. Per-task deltas under ~15% are noise (audit §8).
A comparison is valid only when `provenance.gitSha` matches across runs. If Dawn shows no
long-horizon advantage over naive, **that is the finding**, and it should change V2's
priorities rather than be re-run until it flatters them.

---

## J. Proposed Dawn V2 architecture `[new]`

### J.1 The one-sentence problem

Dawn bounds context *volume* well and has no representation of context *state*. Every
undefended degradation mode in §D is a missing state transition, not a missing byte cap.

### J.2 Module boundaries and ownership

```
                      USER
                        │
                 ┌──────▼──────┐
                 │   RUNTIME   │  coordinates only — no policy
                 └──────┬──────┘
                        │
        ┌───────────────▼────────────────┐
        │        CONTEXT LEDGER          │  owns identity + lifecycle
        └───┬───────────┬───────────┬────┘
            │           │           │
   ┌────────▼──┐ ┌──────▼──────┐ ┌──▼──────────────┐
   │   CODE    │ │  WORKING    │ │  OBSERVATION    │
   │  INTEL    │ │  MEMORY     │ │  STORE          │
   │(versioned │ │(goals,      │ │(typed results,  │
   │ sources)  │ │ constraints,│ │ expandable)     │
   │           │ │ failures)   │ │                 │
   └────────┬──┘ └──────┬──────┘ └──┬──────────────┘
            └───────────┼───────────┘
                 ┌──────▼──────┐
                 │  COMPILER   │  budget + pressure → ContextPackage
                 └──────┬──────┘
                        ▼
                      MODEL → TOOLS → state updates → next step
```

Ownership rules, to prevent the god-object the brief warns about (§94):

- The **runtime** never decides what goes in context; it asks the compiler.
- The **compiler** never fetches; it selects from what the ledger holds and asks retrieval
  for named gaps.
- The **ledger** owns state transitions and is the only thing that may mark an item
  superseded, expired, or pinned.
- Nothing writes into the request array except the compiler.

### J.3 The Context Ledger

Generalizes today's `WorkingSetItem` (4 kinds, a TTL, no state) into an artifact with
identity, provenance, cost, and lifecycle:

```
id            ctx_041
kind          source-symbol | source-range | observation | fact | constraint |
              decision | failed-approach | summary | repo-map
origin        tool call / user turn / derived-from(ctx_012)
sourceVersion auth.ts@abc123          (source kinds only)
tokens        384                     (measured, not estimated, where possible)
state         candidate | active | pinned | compressed | superseded | archived | expired
reason        "active failing test"
introducedStep / lastUsedStep
```

The states that do not exist today and each buy a specific §D defense:

- **`pinned`** — never trimmed, never expired, re-emitted from state at every compaction.
  Defends forgotten constraints.
- **`superseded`** — an edit to `auth.ts` marks every `source-*` item at the old version
  superseded; a passing test supersedes the failure observation; requirement B supersedes
  A. Defends stale code, conflicting state, and requirement drift.
- **`archived`** — body lives in the blob store, a stub with a handle rides in context.
  Already effectively implemented by `«expand:HASH»`; this makes it a first-class state.

### J.4 Source versioning and diff-on-reread

Every read attaches `path@contentHash`. The registry already holds the hash
(`agent.ts:194`) — what is missing is the **body** to diff against. Storing the last-served
body per range makes three things possible: overlap-aware dedup (fixing §C.2 item 2),
diff-on-reread when the diff is materially smaller than the range, and — most importantly —
**supersession on edit**, which is the direct fix for Dawn's only measured probe failure.

### J.5 The design rule that must survive from V1

> **Every context-reduction mechanism is presumed guilty of inducing extra model
> round-trips until an ablation shows otherwise.**

This is not a slogan; it is the measured lesson of audit §11.4, and the existing
`HEADROOM_KEEP_SHARE = 0.6` stand-down (`tools/index.ts:1175`) is the precedent — *don't
compact what the budget can already afford*. V2 must carry this forward and extend it: a
smaller working set that causes one extra tool call is a loss, not a win. The ablation
suite (§M.3) is how this rule is enforced rather than merely stated.

### J.6 Working memory and the observation store

**Working memory** — structured, deterministic, LLM-free where possible: goals,
constraints (pinned), facts, hypotheses, **failed approaches**, decisions, verification
status, open questions. The failed-approach record is the brief's §34 and is the one item
with no precedent anywhere in Dawn today.

**Observation store** — promote `compacted_blobs` from opaque bodies to typed observations
(`TestResult`, `BuildResult`, `LintResult`, `SearchResult`, `GenericShellResult`) with
failure-first rendering (brief §38) and cross-blob search. The storage, addressing,
eviction, and expansion tool already exist; the typing and the search do not.

### J.7 Smaller items worth carrying

- Untrusted-content fence on `web_fetch` (§C.2 item 7).
- Suppress the `summary` item while a `file-range` for the same path is live (§C.2 item 1).
- Proactive reclamation ladder — prune before summarize, compact at ~80% of window on the
  utility model with clipped input, leaving provider overflow as the never-hit fallback.
  Gemini CLI's 50%-trigger / two-full-history-Pro-calls compaction is the cautionary tale.

---

## K. Context lifecycle

```
                    ┌────────────┐
   retrieval  ─────►│ candidate  │  proposed, not yet paid for
                    └─────┬──────┘
                selected  │
                    ┌─────▼──────┐
                    │   active   │◄──── re-referenced (lastUsedStep bumped)
                    └─────┬──────┘
          ┌───────────────┼────────────────┬──────────────┐
   pin    │        extract useful state    │   edit /     │  budget
          │               │                │   new result │  pressure
    ┌─────▼────┐   ┌──────▼──────┐   ┌─────▼──────┐  ┌────▼──────┐
    │  pinned  │   │ compressed  │   │ superseded │  │  expired  │
    │(survives │   │(stub + hash │   │(old version│  │(lease ran │
    │ compact) │   │ in context) │   │ never sent)│  │  out)     │
    └──────────┘   └──────┬──────┘   └─────┬──────┘  └───────────┘
                          │                │
                    ┌─────▼────────────────▼─────┐
                    │        archived            │
                    │  body in blob store,       │
                    │  recoverable via expand()  │
                    └────────────────────────────┘
```

The invariant that makes this safe: **compression and supersession never destroy
evidence.** An item leaves active context only into a state from which its content is
recoverable — which is why the existing `«expand:HASH»` blob store is the load-bearing
piece rather than a nicety.

---

## L. Long-horizon strategy — mode by mode

| Failure mode | V2 mechanism | Measured by |
| --- | --- | --- |
| Forgotten constraints | `pinned` ledger state; constraints re-emitted from state at every compaction, never trusted to a summary | `hz-constraint-retention` |
| Stale code | source versioning; edit marks prior versions `superseded`; diff-on-reread | `hz-stale-code`, `probe-stale-edit` |
| Failed-approach resurrection | failed-approach records in working memory, carried across compaction | `hz-failed-approach` |
| Buried evidence | typed observations + failure-first rendering + anchor preservation (already works) | `hz-buried-evidence` |
| Requirement drift | supersession on the constraint/goal items themselves | `hz-requirement-change` |
| History explosion | proactive prune-then-compact ladder; ledger bounds what is *held*, not just what is *sent* | context-vs-step curves |
| Compaction amnesia | deterministic manifest reconstructed from ledger + working memory, never an LLM re-derivation | `hz-compaction` (designed, not built — see §P) |

---

## M. Benchmark plan

**M.1 Efficiency (unchanged, and deliberately so).** Cost per successful task with the
pass-rate parity gate — total $ across all reps including failures, ÷ successful reps,
valid only when Dawn's pass rate ≥ naive's. Implemented in `bench/report.ts` (`headline`,
`costPerSuccess`) with unit tests that specifically assert parity failure fails the gate
*even when Dawn is cheaper* (`report.test.ts:42-48`).

**M.2 Uncached tokens as a diagnostic.** Reported per task and pooled, never as the
headline — the +30% figure is an architectural choice, not a regression, and framing it as
the primary metric would misdescribe the design. **Open gap:** the non-caching lean-budget
path (6 k/8 k/12 k) remains unmeasured, so "the architecture is not merely a caching trick"
is currently an assertion. §P.1.

**M.3 Reliability.** Probe slice (existing) plus the horizon slice (new), judged on pass
rate. Success-by-session-length (brief §79) becomes reportable once horizon data exists:
short (1 turn) / medium (3–4) / long (11–12), with $/success at each.

**M.4 Ablations (brief §85) — the enforcement mechanism for §J.5.** Once V2 lands, disable
one mechanism at a time: source versioning, diff-on-reread, pinned constraints,
failed-approach memory, typed observations, proactive compaction. Any mechanism that does
not move either the headline or a horizon pass rate does not earn its complexity.

**M.5 Fairness rules (retained):** same model everywhere; `temperature: 0`; `autoFallback:
false`; `FIXTURE_REF` pinned; comparisons valid only when `provenance.gitSha` matches.

---

## N. Migration plan

Re-sequenced from the brief's Phase 1–13 by **measured leverage**, not by the brief's
order — the audit's §11.4 lesson is that the intuitive ranking was wrong three times out
of four. Every phase must leave `bun run preflight` green.

| Phase | Goal | Modules | Exit criteria | Risk |
| --- | --- | --- | --- | --- |
| **0** *(this report)* | Evidence + design | docs, bench | Report reviewed; gate decision taken | Report acts on stale assumptions — mitigated by §C refresh |
| **1** | **Run the horizon pilot** | none (harness built) | Real curves + pass rates in §I; degradation direction known | Auth blocker (current); n=2 over-read |
| **2** | Context Ledger as a *shadow* structure — recorded, not yet driving selection | `context/ledger.ts`, `working-set.ts` | Ledger state matches actual send decisions on the full bench; **zero** headline movement | Silent behavior change — mitigated by requiring zero movement |
| **3** | Source versioning + supersession on edit | `tools/index.ts`, ledger | `probe-stale-edit` 2/2; `hz-stale-code` improves; headline holds | Over-invalidation causing re-reads (**the §J.5 trap**) |
| **4** | Pinned constraints + working memory | `context/memory.ts`, compaction path | `hz-constraint-retention` improves; headline holds | Pinned items crowd the budget |
| **5** | Typed observations + failure-first rendering | `context/compact/`, blob store | Test/build outputs render as structured results; headline holds | Parser brittleness across runners |
| **6** | Proactive reclamation ladder | `agent.ts`, `compact-llm.ts` | Overflow compaction becomes never-hit; long-session $ improves | Compaction cost exceeding benefit (Gemini's lesson) |
| **7** | Diff-on-reread + overlap-aware dedup | `working-set.ts`, read path | Repeat-read tokens down; headline holds | Diff larger than the range on scattered edits |
| **8** | Code intelligence — **only if §P.2 resolves yes** | `context/indexer.ts` | Investigate slice improves measurably | Large complexity for unproven gain |
| **9** | Ablations + legacy removal | all | Every mechanism justified by §M.4; V1 paths deleted | Removing something the bench doesn't cover |

**Sequencing rationale:** phases 3–5 attack the *measured* and *structurally undefended*
failures. Phase 8 is last and conditional because the audit gated code intelligence on
investigate-slice evidence, and P0 has since largely resolved that slice — the original
justification has weakened, not strengthened.

---

## O. Risks

Led by the two the evidence actually supports.

1. **Over-reduction inducing round-trips (measured, audit §11.4).** The dominant risk, and
   the reason for §J.5 and §M.4. Mitigation: headroom-aware stand-down survives into V2;
   every mechanism ablated.
2. **Benchmark self-reference (measured, audit §11.3).** Tasks read Dawn's own source, so
   the substrate moves with every commit. Mitigation: `FIXTURE_REF` pinned; the new
   `bench/tasks.test.ts` guard catches fixture rot; comparisons gated on matching
   `gitSha`.
3. **Small-n over-reading.** n=2 cannot separate a reliability difference from sampling.
   `temperature: 0` demonstrably does **not** make tool-call counts deterministic (§H).
   Mitigation: pre-registered interpretation limits (§I.4); noise floor ~15%.
4. **Over-invalidation from source versioning.** Marking too much superseded forces
   re-reads — risk 1 wearing a different hat. Mitigation: phase 3 gated on `probe-stale-edit`
   *and* the headline together.
5. **Ledger complexity becoming the god object the brief warns about (§94).** Mitigation:
   the ownership rules in §J.2, and phase 2 shipping it as a shadow structure first.
6. **Pinned-context crowding.** Constraints that never expire consume budget in long
   sessions. Mitigation: pinned items are small and text-only; budget them explicitly.
7. **Provider variation.** The whole win is priced on cache-read economics; the non-caching
   path is unmeasured (§P.1).
8. **Storage growth.** `MAX_BLOBS = 2000` bounds blobs; `context_plans` still has no
   pruning (audit §2.6, unfixed).
9. **Migration risk.** Nine phases against a repo that must stay demo-ready for recruiters
   (a standing constraint). Mitigation: preflight green at every phase; no phase removes a
   V1 path before its replacement is measured.

---

## P. Open design questions

Only the ones that genuinely need a decision.

**P.1 — Does the non-caching lean-budget path get measured before V2 commits to provider
independence?** The entire measured win is cache-read pricing. The claim "Dawn's
architecture is not merely a caching trick" currently rests on the 6 k/8 k/12 k lean
budgets, which no run has ever exercised. This is a one-flag bench lane on a
non-caching provider. **Recommendation: yes, and early** — it is cheap, and if the lean
path loses to naive, that reframes the whole V2 thesis.

**P.2 — Does AST code intelligence still earn its complexity?** The audit gated it as P2
"pending investigate-slice evidence". P0 then fixed the investigate slice by other means
(headroom-aware compaction), so the original justification has *weakened*. Tree-sitter,
a symbol/ref schema, and an incremental worker are the single largest complexity increase
in the V2 plan. **Recommendation: hold at phase 8 and require the horizon pilot or a new
investigate task to demonstrate a retrieval failure that symbol-level access would fix.**
Building it because the brief lists it would be exactly the feature-count optimization
brief §66 forbids.

**P.3 — Should `hz-compaction` be built, given it costs ~$1+/rep?** Dawn compacts only at
provider overflow, so forcing it on a 200 k window means genuinely filling the window.
Options: (a) build it and pay; (b) add a test-only forced-compaction hook and measure
survival deterministically without the token cost; (c) defer until phase 6 makes
compaction proactive and therefore cheap to trigger. **Recommendation: (b)** — the thing
being tested is whether state survives compaction, which is a deterministic property.

**P.4 — Does the ledger replace the working set, or wrap it?** Replacing is cleaner and
risks a large silent behavior change on the one subsystem the whole benchmark measures.
Wrapping keeps the measured behavior and carries a translation layer. **Recommendation:
wrap in phase 2 (shadow), replace in phase 9 once ablations prove each state transition.**

---

## Decision gate

Per brief §96: **stop here.** No Phase 1+ implementation has begun. The backend is
unchanged; the only source changes are additive benchmark scaffolding (a `horizon` slice,
per-step tracing, and two guard tests), with `bun run preflight` green.

**The one action needed to complete this report:** re-authenticate Anthropic
(`dawn auth login anthropic`) so §I can be filled with measurements instead of a plan.
Everything else is done.
