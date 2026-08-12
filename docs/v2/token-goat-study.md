# Token-Goat Architecture Study

**Date:** 2026-08-11 · **Subject:** `github.com/DFKHelper/token-goat` (current `main`)
**Purpose:** research reference for Dawn V2. Supports §E / §F / §G of the
[V2 report](./2026-08-v2-architecture-and-long-horizon-report.md).

## 0. Ground rules

**Token-Goat is licensed PolyForm Noncommercial. Dawn is MIT.** Nothing in this document
is copied source, and no token-goat code may enter Dawn. What transfers is engineering
ideas, which are not the licensed artifact. This is a stricter constraint than the V2
brief's "do not copy" instruction, and it is the operative one.

**Sources read:** `CLAUDE.arch.md` (the project's own architecture document) and `README.md`
at current `main`. Both are primary-source descriptions written by the project, not
third-party summaries. Where a claim is marketing rather than measurement, it is labeled.

---

## 1. What Token-Goat is

A TypeScript CLI that **intercepts another agent's tool calls through a hook system** and
rewrites them into cheaper equivalents. It does not run an agent. It sits between an
existing harness (Claude Code, Codex, Gemini CLI, Copilot CLI, OpenClaw, …) and that
harness's own tools.

The control flow is, by construction:

```
host agent decides to call a tool
        ↓
token-goat hook intercepts (PreToolUse)
        ↓
token-goat rewrites / substitutes / caches
        ↓
host agent receives a cheaper result
```

Every design consequence in §4 follows from that one structural fact.

## 2. Architecture as described

### 2.1 Index

- **SQLite `global.db`** holding `files` (path, SHA, mtime, language), `symbols`
  (name, kind, line range, body, docstring), `refs` (call sites with enclosing scope),
  `chunks`, `symbols_fts` (FTS5), `chunk_vectors` (vec0, when `sqlite-vec` is present).
- **Tree-sitter** for TypeScript, Python, Go, Rust, Ruby, Java, C/C++; **regex adapters**
  for everything else. Graceful degradation is designed in, not bolted on.
- **Refs carry their enclosing scope.** `extractRefs()` tracks the containing
  function/method/class during the tree-walk and stores it in `refs.context`, which is
  what makes `refs --callers` able to group usages by caller. This is a small idea with a
  large payoff: it turns a flat reference list into a call graph for free.

### 2.2 Incremental update

A background worker polls `queue/dirty.txt` every 2 s, SHA-fingerprints each queued file,
skips unchanged ones, and reindexes the rest. Edits enqueue paths via a PostToolUse hook.
Indexing is a single transaction per file: delete existing rows, insert new ones.

### 2.3 Surgical reads

~50 CLI commands. The interesting shapes, not the full list:

| Command | What it returns |
| --- | --- |
| `read "file::symbol"` | one function/class body; supports `Class.method` and `@10-40` ranges |
| `skeleton "file"` | all signatures, no bodies |
| `outline "file"` | top-level symbols with line ranges and docstrings |
| `brief "file::symbol"` | symbol body + resolved callers + containing doc section |
| `refs` / `callers` / `call-chain` / `impact` | reference graph walks, forward and backward |
| `section "doc.md::Heading"` | one Markdown section |
| `json-query` / `yaml-query` / `csv-query` / `xlsx-query` / `pdf-extract` | structured extraction instead of whole-file reads |
| `recall ["query"] [--type bash\|web\|mcp]` | full-text search **across all cached tool outputs** |

### 2.4 Output compression

`src/tool_filters/` — a base 10-step pipeline (sanitize → cap → normalize → compress →
line cap → byte cap → notes) plus **roughly 200 hand-written per-tool filters** organized
into batches A–K2: test runners, package managers, linters, VCS, build tools, containers,
cloud/IaC, CI/security, shell utilities, language runtimes, DB clients. Dispatch is
ordered so specific filters beat overlapping general ones (`RgFilter` before `GrepFilter`).

### 2.5 Session state and recovery

Three layers persisted across hook processes (each tool call is a fresh process):
session JSON, content-addressed blob stores for bash/web output (24 h + 200-file
eviction), and a skill body/compact cache.

Re-read handling:
- SHA-256 fingerprint; unchanged file short-circuits the re-read check entirely.
- Changed file: **a unified diff is injected as a hint** — "full Read avoided when the
  diff covers the change." On by default for `.md`/`.rst`/`.txt`; behind
  `serve_diff_on_reread` for source files.
- The "already read" hint is suppressed after first injection so the same nag doesn't
  fire twice per session.
- Skills: a repeated invoke serves a cached ~400-token compact instead of the 40–65 k body,
  and permits a reload if compaction fired since the last load.

**Pre-compaction manifest** (`preCompactHandler`) returns a structured summary as
`systemMessage`: edited files, reads, fetches, active skills with recovery commands,
a sealed `### MUST_PRESERVE` block, `### What Worked` (last two green test runs), inline
git diffs, and `### TODOs`. Budget scales with session age and edit density
(`computeAdaptiveBudget()`). Recall hints are guarded on actual blob existence so a pruned
blob never yields a hint that would error.

### 2.6 Safety

- **Fail-soft everywhere:** every hook handler is wrapped by `failSoft()` — catch, log to
  stderr, return `{ continue: true }`. A broken token-goat must never block agent work.
- **Prompt-injection protection:** fetched web pages are scanned for attack patterns and
  wrapped in an untrusted-content fence, with the matched pattern name logged.
- **Path normalization** as a first-class correctness concern: every symbol/file row is
  keyed by a normalized absolute path at write time, and readers route user paths through
  the same helper so lookup keys match write keys byte-for-byte across Windows/WSL/macOS.

## 3. Benchmark claims — classified

The project's own README separates these, which is to its credit.

**Reproducible (test-suite benchmarks, source file named):**

| Measurement | Result |
| --- | --- |
| DB reindex (batched transaction + composite indexes) | 100 files / 10 K rows: 84 s → 1 s |
| Hook cold start (lazy imports) | 86 ms → 30 ms |
| Image shrink (WebP vs JPEG q85) | ~39% smaller |
| Repomap `--compact` trim | "denser overview for same byte budget" |
| Image cache LRU eviction | "higher hit rate on repeat screenshots" |

Even these carry **no sample size and no statistical statement**, and they are
*synthetic-fixture* benchmarks — engineering micro-measurements, not task outcomes.

**Marketing (no methodology, no baseline, no sample size) — not citable as evidence:**
"cuts costs 40–80%", "reduces token use 40–90%", "85% smaller reads", "97.4% image
compression", "3.7 GB never reached the model", "1.1 Gt tokens saved", per-tool figures
like pytest "97% saved".

**The structural gap:** every headline number is a *reduction in bytes at an interception
point*. None is a **task-success-holding** measurement. There is no ablation baseline, no
pass-rate gate, and no measurement of whether a redirected agent still completes the task.
That is precisely the failure mode Dawn's own audit measured in itself (§11.4: aggressive
context reduction bought extra model round-trips and cost *more*). A "97% smaller pytest
output" figure is not evidence of savings if the agent re-runs pytest to see what was cut.

**Stated limitations (from its own docs):** macOS untested; static indexing misses dynamic
dispatch and external callers; semantic search silently falls back to BM25 when embedding
deps are absent; a negative-lookahead regex "silently degrades to a literal substring
match" when the regex-compile fallback fires; Copilot CLI and OpenClaw bridges have no
context-injection channel (manifest and hints are notification-only); the OpenClaw bridge
"has not been validated against a live OpenClaw instance."

---

## 4. The architectural distinction that matters for Dawn

Token-Goat's ceiling is set by where it sits.

**It can only react to a decision already made.** By the time the hook fires, the host
agent has already decided to read `auth.ts`. Token-Goat can serve a smaller version of
that read, but it cannot cause the agent to have wanted the outline instead — it has no
access to the reasoning state, the task phase, or the remaining budget that would justify
one representation over another. Its own docs show it compensating with heuristics:
hint injection, config flags (`serve_diff_on_reread`), and nag suppression.

**Dawn owns the runtime.** It knows the budget, the mode, the working set, the plan, and
the phase *before* the tool schema is even offered to the model. It can decide the
representation before the call exists, and — the part token-goat structurally cannot do —
it can **measure the consequence**, because it also owns the loop that would have paid for
the recovery round-trip.

That asymmetry, not the feature list, is the honest Dawn-vs-Token-Goat story.

A second, less flattering asymmetry: token-goat works with **agents it did not write**,
across seven harnesses and dozens of languages. Dawn works with Dawn. Breadth is
token-goat's product; depth and measurability are Dawn's.

---

## 5. Classification

### ADOPT CONCEPTUALLY

| Idea | Why | Dawn's current state |
| --- | --- | --- |
| **Deterministic pre-compaction manifest** | Constructed from state the tool already has; no LLM re-derivation. Directly answers brief §42 (compaction without amnesia). | Dawn's `distillDroppedTurns` is already template-based and LLM-free — the same instinct. What's missing is a `MUST_PRESERVE` equivalent: pinned constraints that survive by construction. |
| **Sealed `MUST_PRESERVE` block** | The cleanest existing answer to constraint drift (brief §22, §70). | Absent. Dawn has no pinned-constraint concept. |
| **Refs carrying enclosing scope** | Turns a reference list into a caller graph at zero extra cost. | Absent — `find_symbol` does two ripgrep passes with no scope awareness. |
| **Fail-soft context machinery** | A context optimizer that breaks the agent is worse than no optimizer. | Partially present (compaction inflation guard, headroom stand-down). Worth stating as an explicit invariant. |
| **Untrusted-content fencing for fetched web pages** | Cheap, and the only defense against a fetched page issuing instructions. | **Absent in Dawn** — `web_fetch` truncates to 12 k chars and hands the text straight to the model. A real gap, orthogonal to context efficiency. |

### ADAPT FOR DAWN

| Idea | Adaptation | Why not adopt as-is |
| --- | --- | --- |
| **Tree-sitter symbol index + regex fallback** | Replace Dawn's regex-only, TypeScript/JavaScript-only `indexer.ts` (capped at 80 symbols, never run automatically). Keep the fallback ladder. | Dawn needs it inside the retrieval path, not as a CLI. And it must be gated on evidence — see the report's open questions. |
| **Dirty-queue incremental worker** | Dawn already knows exactly which paths it edited (`readRegistry`, edit handlers) — it needs no filesystem polling. Enqueue on edit, reindex synchronously or on idle. | The 2 s poll exists because token-goat cannot see the agent's edits directly. Dawn can. Copying the poll would be copying a workaround for a problem Dawn doesn't have. |
| **Diff-on-reread** | Dawn has per-path content hashes in `readRegistry` but stores **no body to diff against**. Storing the last-served body per range makes a diff possible. | Token-goat's flag-gated, extension-based policy (`.md` on, source behind a flag) is a heuristic standing in for budget knowledge. Dawn can decide by size: serve the diff when it's materially smaller than the range. |
| **`recall` — search across cached outputs** | Dawn's `compacted_blobs` store already has content-addressing, eviction (`MAX_BLOBS = 2000`) and filtered retrieval via `expand` (regex + offset/limit). The missing piece is search *across* blobs, not within one. | Only the search half is missing; the storage half is already better-integrated than token-goat's (it is wired into the compaction sentinel, not a side cache). |
| **Skeleton / outline / brief as retrieval tiers** | Adopt the *tiering* (outline → symbol → range → full file, brief §23/§26), not 50 commands. Dawn should expose the smallest useful set. | Brief §25 explicitly warns against dozens of redundant tools, and every tool schema costs ~110 tokens of prefix on every request (26 tools = 2,926 measured). |
| **Adaptive manifest budget by session age/edit density** | Reasonable signal, but Dawn should tie it to measured pressure, not age. | Age is a proxy; Dawn has the real number. |

### REJECT

| Idea | Why rejected |
| --- | --- |
| **~200 hand-written per-tool output filters** | Dawn's `detectKind()` router covers the same territory with four generic compactors (json / search / log / text) plus anchor preservation. The measured evidence (audit §11.4) is that *payload shaving is the low-value lever* — round-trips dominate. 200 filters is a large permanent maintenance surface for the lever that measured smallest. **Reconsider only** for `TestResult`/`BuildResult`, where the win is structural (failure-first rendering, brief §37/§38), not incremental byte-shaving. |
| **Embeddings / `chunk_vectors` semantic search** | Brief §51 requires structural retrieval to be proven first. Token-goat's own docs describe it as optional and silently degrading to BM25. No evidence any Dawn bench task needs it. |
| **The hook-interception architecture** | Dawn owns its runtime; interception is token-goat's constraint, not a design goal. Reimplementing it inside Dawn would add a layer that decides *after* the information it needs is already available. |
| **Image compression pipeline** | Dawn is a terminal coding agent; screenshots are not on its cost path. Also drags in a mandatory native `sharp` dependency, which its own docs flag as an install hazard. |
| **50-command CLI surface** | Schema/prefix cost is real and measured. Breadth here directly contradicts brief §25 and §66. |
| **Its benchmark methodology** | Byte-reduction-at-interception with no task-success gate and no ablation. Dawn already has the stronger instrument: an identical-agent `--naive` ablation and a cost-per-successful-task metric with a pass-rate parity gate. Adopting token-goat's framing would be a regression in measurement quality. |

---

## 6. Dawn vs Token-Goat (report §G table)

| Problem | Dawn V1 (current, post-P0) | Token-Goat | Dawn V2 direction | Reason |
| --- | --- | --- | --- | --- |
| Whole-file reads | Ranged reads with mode caps (120/240/600 lines, 24/40/80 kB); no symbol tier | `read file::symbol`, `skeleton`, `outline`, `brief` over a tree-sitter index | Retrieval tiers driven by the planner, smallest useful tool set | Dawn can pick the tier from budget + phase; token-goat must infer it from an intercepted call |
| Repeat reads | Exact-key range suppression only (`hasFileRange`); overlapping ranges miss entirely | SHA fingerprint + unchanged-file short-circuit | Version-aware source with overlap awareness | Exact-key matching is the weakest possible form of the idea |
| Re-read after edit | Full body re-served; `assertFreshRead` gates the edit but does not shrink the read | Unified diff injected as a hint | Diff-on-reread, chosen by size not extension | Dawn knows the budget; a flag is a proxy for it |
| Stale source after edit | Hash-based freshness gate before edits; **no supersession of context already sent** | Not addressed (interception cannot see reasoning state) | Source versioning with explicit supersession | The measured probe failure (`probe-stale-edit`, dawn 1/2 vs naive 2/2) is exactly this |
| Huge tool output | Three layers: per-tool caps, `detectKind` compaction with anchor preservation, intra-turn prune; original stored in `compacted_blobs`, retrievable via `expand` | ~200 per-tool filters; content-addressed blob store; `recall` search | Keep the router; add typed `TestResult`/`BuildResult`; add cross-blob search | Dawn's generic router already measured competitive; typing is the structural gap |
| Compaction amnesia | Overflow-triggered only (`MAX_COMPACTIONS = 2`); template-based session memory survives | Deterministic pre-compact manifest with `MUST_PRESERVE`, `What Worked`, TODOs | Proactive ladder + pinned constraints reconstructed from state | Dawn compacts reactively at a cliff; the manifest idea is strictly better |
| User constraints over long sessions | **Nothing** — constraints live in history and age out with it | `MUST_PRESERVE` sealed block | Pinned constraint items, re-injected from state at every compaction | Brief §22; unmeasured in Dawn today (see report §I) |
| Failed approaches | **Nothing** — repeated identical *tool errors* nudge after 3, but no semantic memory | Not addressed | Structured working memory with failed-approach records | Brief §34 |
| Code intelligence | Regex, TS/JS only, 80-symbol cap, never runs automatically | Tree-sitter, 7 languages, refs with scope, incremental | Evidence-gated upgrade | Audit gated this as P2; the report revisits whether that still holds |
| Prompt injection | **Nothing** on `web_fetch` | Pattern scan + untrusted-content fence | Adopt the fence | Cheap, and a real hole |
| Proving it works | Identical-agent `--naive` ablation; cost per successful task with pass-rate parity gate; provider-measured tokens | Synthetic byte-reduction micro-benchmarks; marketing percentages | Keep Dawn's instrument; add the horizon slice | Dawn's measurement is the stronger asset and should not be traded away |

---

## 7. The one lesson worth carrying into V2 unchanged

Token-Goat's numbers are all *bytes prevented*. Dawn measured the same instinct in itself
and found it misleading: over-aggressive reduction bought extra model round-trips and cost
more money (audit §11.4, `cat-budget` 4 steps/41.7 k → 2 steps/23.1 k when compaction stood
down). Every mechanism adapted from this study must be judged on **cost per successful
task**, not on bytes removed at the point of interception — and must be presumed guilty of
inducing retries until an ablation shows otherwise.
