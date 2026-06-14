# AGENTS.md

## Project Overview
Dawn is a token-frugal AI coding agent designed for the terminal. The project is an early Bun and TypeScript monorepo built to support an interactive TUI and automation workflows. It includes multi-provider model selection, persisted/resumable sessions, permission prompts for side-effecting tools, and cost tracking mechanisms.

## Commands
- **Install/link:** `bun install && bun link` or `bun run setup`
- **Build/Setup:** `bun install && bun run setup`
- **Test:** `bun test`
- **Typecheck:** `bun run typecheck` (`tsc --noEmit`)
- **Lint/Check:** `bun run check` (`biome check .`)
- **Format:** `bun run format` (`biome format --write .`)
- **Run Agent:** `bun run dawn` (`bun run index.ts`)

## File/Folder Layout
- **`index.ts`**: Entry point for the Dawn CLI (`"dawn"` bin).
- **`packages/core`**: Shared agent logic, model catalog/provider integration, context budgeting, and model/cost utilities.
- **`packages/tui`**: Terminal UI implementation, slash commands, user-centric views, setup/connect flows, markdown rendering, and theme.
- **`biome.json`**: Project linting and formatting rules.
- **`package.json`**: Defines scripts and workspace structure.
- **`tsconfig.json`**: Compiler options tailored for Bun and React JSX.
- **`bunfig.toml`**: Uses Bun's hoisted linker for this workspace.

## Naming and Code-Style Conventions
- Use `camelCase` for variables and functions.
- Use `PascalCase` for React components and TypeScript types.
- Prefer double quotes for strings, as per `biome.json` rules.
- Semicolons are used as needed (`"asNeeded"` rule).
- Indent using 2 spaces.
- Wrap lines at 110 characters (`biome.json`).
- React components use `@opentui/react`-style JSX.
- Strict TypeScript types are enforced (`strict: true`, `noUncheckedIndexedAccess: true`).

## Do Not:
- Commit directly to the main branch without review.
- Depend on non-workspace private packages (use workspace references).
- Modify auto-generated files (e.g., cached models).
- Include explicit `any` unless strictly necessary (`noExplicitAny` is disabled).
- Treat the project as public/stable; `package.json` marks it private and early-stage.

## Gotchas
- The project assumes Bun 1.3 or higher.
- `bunfig.toml` uses the hoisted linker because Bun 1.3's isolated linker left dangling workspace symlinks.
- Cached model catalog (`models.dev`) ensures offline support but can be refreshed.
- Permission prompts (`write`, `edit`, `bash`) apply in interactive mode; automated (`--yolo`) bypasses them.
- Avoid overflows in token estimates; respect `contextBudget` utilities.
- Context planning should summarize/expire old data rather than re-reading or replaying everything.

## Adding Features
1. Place UI-centric changes in `packages/tui`.
2. Shared logic belongs in `packages/core`.
3. Add test coverage for new utilities or commands.
4. Update `README.md` if user-facing behavior changes.
