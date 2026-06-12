# Dawn

Dawn - a token-frugal AI coding agent for the terminal.

Dawn is an early Bun and TypeScript monorepo for running an AI coding agent from your shell. It includes
an interactive terminal UI, one-shot automation mode, multi-provider model selection, persisted sessions,
permission prompts for side-effecting tools, and token/cost tracking.

This project is currently private and early-stage (`"private": true` in `package.json`). Treat the README as
developer-facing setup and usage documentation, not as a production stability or package registry promise.

## Features

- Interactive TUI with persisted sessions and resumable conversations.
- One-shot `dawn run` mode for non-interactive prompts.
- Multi-provider model support through the AI SDK and OpenAI-compatible endpoints.
- API key storage with environment-variable fallback.
- Local Ollama discovery, including RAM-fit warnings for large local models.
- Permission prompts for `write`, `edit`, and `bash` tools in interactive mode.
- Session usage and cost tracking across models.
- Offline-friendly model catalog fallback with a cached `models.dev` refresh when available.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer is recommended.
- A terminal that can run the OpenTUI interface.
- At least one connected model provider, API key, or reachable Ollama server.

## Quickstart

Install dependencies and link the local `dawn` command:

```sh
bun install
bun run setup
```

Start the interactive agent in the current directory:

```sh
dawn
```

If the command is not linked yet, run it through Bun:

```sh
bun run dawn
```

Add an API key for a provider:

```sh
dawn auth login groq
```

List models available from connected providers:

```sh
dawn models
```

Run a one-shot prompt:

```sh
dawn run "summarize this repository"
```

## CLI Reference

```text
dawn                       Start an interactive session in the current directory.
dawn -c, --continue        Resume the most recent session for this directory.
dawn -m, --model <ref>     Use a model reference like provider/model.
dawn --cwd <path>          Run against a different working directory.
dawn run "<prompt>"        Run a one-shot non-interactive prompt.
dawn run --yolo "<prompt>" Allow read, write, edit, and bash tools without prompts.
dawn auth login <provider> Store an API key for a provider.
dawn auth list             Show providers with stored API keys.
dawn auth logout <provider> Remove a stored API key.
dawn models [provider]     List known tool-capable models for connected providers.
dawn --version             Print the current Dawn version.
dawn --help                Print command help.
```

Model references use the `provider/model` format, for example:

```sh
dawn --model anthropic/claude-opus-4-8
dawn --model groq/meta-llama/llama-4-scout-17b-16e-instruct
```

In `dawn run`, reads are pre-allowed. Write/edit/bash tools are denied unless `--yolo` is passed. In the
interactive TUI, Dawn asks before side-effecting tools run.

## Interactive Commands

Inside the TUI, submit these slash commands in the prompt:

```text
/model   Switch model across connected providers.
/usage   Show token and cost breakdown for the session.
/new     Start a fresh session.
/clear   Clear the visible transcript while keeping the conversation.
/help    Show TUI help.
/quit    Exit Dawn.
```

Keyboard shortcuts:

```text
Esc      Interrupt a running turn or close an active picker.
Ctrl+C   Quit.
```

When Dawn requests a tool permission:

```text
y        Allow once.
a        Always allow that tool for this session.
n/Esc    Deny.
```

## Providers

Dawn can use built-in provider metadata for Anthropic, OpenAI, Google, Groq, xAI, Mistral, DeepSeek,
Perplexity, Together AI, Fireworks AI, Cerebras, OpenRouter, and Ollama when a local Ollama server is
detected.

Provider credentials can come from Dawn's auth store or from each provider's environment variables, such as
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or `GROQ_API_KEY`.

The model catalog is loaded from cache, refreshed from `models.dev` when reachable, and falls back to an
embedded catalog so the agent can still boot offline.

## Configuration

Dawn merges global configuration with project configuration:

```text
Global config     ~/.config/dawn/config.json
Project config    dawn.json
Stored auth       ~/.local/share/dawn/auth.json
Model cache       ~/.cache/dawn/models.json
```

The project `dawn.json` overrides global settings for that working directory. Example:

```json
{
  "model": "groq/meta-llama/llama-4-scout-17b-16e-instruct",
  "providers": {
    "local-router": {
      "name": "Local Router",
      "baseURL": "http://localhost:8080/v1",
      "apiKeyEnv": "LOCAL_ROUTER_API_KEY"
    }
  },
  "permissions": {
    "bash": "ask",
    "write": "ask",
    "edit": "ask"
  }
}
```

Supported config fields:

- `model`: default model reference in `provider/model` format.
- `providers`: extra OpenAI-compatible providers by provider ID.
- `providers.<id>.name`: optional display name.
- `providers.<id>.baseURL`: OpenAI-compatible API base URL.
- `providers.<id>.apiKeyEnv`: environment variable for the provider API key.
- `permissions`: per-tool policy values of `allow`, `ask`, or `deny`.

Environment overrides:

```text
DAWN_HOME        Override the home directory Dawn uses for config/data/cache defaults.
DAWN_CONFIG_DIR  Override the config directory.
DAWN_DATA_DIR    Override the data/auth directory.
DAWN_CACHE_DIR   Override the cache directory.
DAWN_NO_ANIM     Disable TUI logo animation when set.
```

## Development

Install dependencies:

```sh
bun install
```

Run the local CLI:

```sh
bun run dawn
```

Run tests:

```sh
bun test
```

Typecheck:

```sh
bun run typecheck
```

Lint/check formatting with Biome:

```sh
bun run check
```

Format:

```sh
bun run format
```

The repository is organized as:

```text
index.ts             CLI entrypoint.
packages/core        Agent, providers, auth, config, sessions, tools, usage ledger.
packages/tui         OpenTUI React interface.
```

## Security Notes

- Do not commit API keys or local `dawn.json` files containing secrets.
- Prefer provider environment variables or `dawn auth login <provider>` over inline credentials.
- Stored API keys are written to Dawn's auth file with `0600` permissions.
- `dawn run --yolo` allows side-effecting tools without prompts; use it only in trusted worktrees.
- A dedicated `SECURITY.md`, `CONTRIBUTING.md`, license, and CI badges should be added when repository
  hosting and contribution policy are finalized.

## Support

For now, use the repository's configured issue tracker or discussions once hosting is available. Until then,
the most reliable local reference is:

```sh
dawn --help
dawn models
```
