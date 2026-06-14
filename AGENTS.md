# AGENTS.md

## Project Overview
Dawn is a token-frugal AI coding agent designed for the terminal. The project is an early Bun and TypeScript monorepo built to support an interactive TUI and automation workflows. It includes multi-provider model selection and cost tracking mechanisms.

## Commands
- **Build/Setup:**  `bun install && bun run setup`
- **Test:**  `bun test`
- **Typecheck:**  `bun run typecheck`
- **Lint/Check:**  `bun run check`
- **Format:**  `bun run format`
- **Run Agent:**  `bun run dawn`

## File/Folder Layout
- **`packages/core`**: Core utilities including model catalog and context planning.
- **`packages/tui`**: Terminal UI implementation, slash commands, and user-centric views.
- **`biome.json`**: Project linting and formatting rules.
- **`package.json`**: Defines scripts and workspace structure.
- **`tsconfig.json`**: Compiler options tailored for Bun and React JSX.
- **`index.ts`**: Entry point for the Dawn CLI.

## Naming Conventions
- Use `camelCase` for variables and functions.
- Use `PascalCase` for React components and TypeScript types.
- Prefer double quotes for strings, as per `biome.json` rules.
- Semicolons are used as needed (`"asNeeded"` rule).

## Coding Style
- Indent using 2 spaces.
- Wrap lines at 110 characters (`biome.json`).
- React components use `@opentui/react`-style JSX.
- Strict TypeScript types are enforced.

## Do Not:
- Commit directly to the main branch without review.
- Depend on non-workspace private packages (use workspace references).
- Modify auto-generated files (e.g., cached models).
- Include explicit `any` unless strictly necessary (`noExplicitAny` is disabled).

## Gotchas
- The project assumes Bun 1.3 or higher.
- Cached model catalog (`models.dev`) ensures offline support but can be refreshed.
- Permission prompts (`write`, `edit`, `bash`) apply in interactive mode; automated (`--yolo`) bypasses them.
- Avoid overflows in token estimates; respect `contextBudget` utilities.

## Adding Features
1. Place UI-centric changes in `packages/tui`.
2. Shared logic belongs in `packages/core`.
3. Add test coverage for new utilities or commands.
4. Update `README.md`, if user-facing behavior changes.