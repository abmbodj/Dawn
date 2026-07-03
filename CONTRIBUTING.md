# Contributing

Thanks for taking a look at Dawn. The project is public and source-first, but still maintainer-led:
bug reports, documentation fixes, small focused patches, and clear reproduction cases are the best
way to help.

For larger behavior changes, open an issue first so the scope and direction can be discussed before
you spend a lot of time on code.

## Development Setup

```bash
bun install
bun run setup
```

Useful commands:

```bash
bun test
bun run typecheck
bun run check
bun run preflight
```

Run `bun run preflight` before opening a pull request. CI enforces the same test, typecheck, and
Biome checks.

## Pull Requests

- Keep pull requests small and focused.
- Add or update tests for behavior changes.
- Update `README.md` when user-facing behavior changes.
- Put UI-centric changes in `packages/tui`.
- Put shared agent logic, providers, context planning, tools, and persistence in `packages/core`.
- Do not modify generated or cached files unless the change is specifically about those artifacts.

## Benchmarks

The benchmark harness spends real API budget and can be nondeterministic. Do not run it casually as
part of normal development.

```bash
bun run bench:report
```

Use `bun run bench` only when a change is specifically about the benchmark data or token/cost
behavior.
