# Cheaper-Agent Thesis Implementation Plan

> **For agentic workers:** Economics-core first. Spec:
> `docs/superpowers/specs/2026-07-24-cheaper-agent-thesis-design.md`

**Goal:** Make Dawn’s planner beat `--naive` on $ (slice-aware), with honest Measured vs Estimated UX.

**Architecture:** Split `promptCaches` / `cacheBreakpoints` on `ModelProfile`; adaptive `budgetFor` when CLI omits `--budget`; skip trivial-turn summaries; split savings UI; expand benches.

## Tasks (shipped in this change set)

1. Cache capability profile + `budgetFor(mode)` + CLI adaptive default
2. `summariesEarnKeep` pay-for-itself injection
3. Measured vs Estimated `/savings` + tagline soften
4. Bench slices + Aider harness + report win-bar + PR invariant tests
