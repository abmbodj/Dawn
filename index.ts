#!/usr/bin/env bun
import {
  Bus,
  type Catalog,
  connectedProviders,
  DawnAgent,
  type DawnConfig,
  listAuthProviders,
  loadCatalog,
  loadConfig,
  PermissionGate,
  removeApiKey,
  SessionStore,
  setApiKey,
  withOllama,
} from "@dawn/core"

const VERSION = "0.1.0"

const USAGE = `dawn — token-frugal AI coding agent

Usage:
  dawn                       interactive session in the current directory
  dawn -c, --continue        resume the most recent session for this directory
  dawn -m, --model <ref>     model as provider/model (e.g. anthropic/claude-opus-4-8)
  dawn run "<prompt>"        one-shot non-interactive run (add --yolo to allow edits/bash)
  dawn auth login <provider> store an API key (anthropic, openai, google, …)
  dawn auth list             show configured providers
  dawn auth logout <provider>
  dawn models [provider]     list known models for connected providers
  dawn --version | --help`

interface Flags {
  continue: boolean
  model?: string
  cwd: string
  yolo: boolean
  positional: string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { continue: false, cwd: process.cwd(), yolo: false, positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    switch (arg) {
      case "-c":
      case "--continue":
        flags.continue = true
        break
      case "-m":
      case "--model":
        flags.model = argv[++i]
        break
      case "--cwd":
        flags.cwd = argv[++i] ?? flags.cwd
        break
      case "--yolo":
        flags.yolo = true
        break
      default:
        flags.positional.push(arg)
    }
  }
  return flags
}

function pickDefaultModel(catalog: Catalog, config: DawnConfig): string {
  if (config.model) return config.model
  const connected = new Set(connectedProviders(catalog, config).map((p) => p.id))
  const preferred: Array<[string, string]> = [
    ["anthropic", "anthropic/claude-opus-4-8"],
    ["openai", "openai/gpt-5.5"],
    ["google", "google/gemini-3.5-flash"],
    ["groq", "groq/meta-llama/llama-4-scout-17b-16e-instruct"],
    ["xai", "xai/grok-3"],
    ["mistral", "mistral/mistral-large-latest"],
    ["deepseek", "deepseek/deepseek-chat"],
  ]
  for (const [provider, ref] of preferred) if (connected.has(provider)) return ref
  // Cloud providers without a preference entry: still safe to auto-select.
  for (const id of connected) {
    if (id === "ollama") continue // never silently default to a local model — see Setup wizard
    const models = Object.keys(catalog[id]?.models ?? {})
    if (models[0]) return `${id}/${models[0]}`
  }
  // Nothing usable yet (e.g. only Ollama reachable) — placeholder; the Setup
  // wizard runs first and overrides this with an explicit, persisted choice.
  return "groq/meta-llama/llama-4-scout-17b-16e-instruct"
}

async function promptHidden(label: string): Promise<string> {
  process.stdout.write(label)
  const stdin = process.stdin
  stdin.setRawMode?.(true)
  stdin.resume()
  let value = ""
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          // ctrl-c
          stdin.setRawMode?.(false)
          process.stdout.write("\n")
          process.exit(130)
        }
        if (byte === 13 || byte === 10) {
          stdin.off("data", onData)
          stdin.setRawMode?.(false)
          stdin.pause()
          process.stdout.write("\n")
          resolve(value)
          return
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1)
        } else if (byte >= 32) {
          value += String.fromCharCode(byte)
        }
      }
    }
    stdin.on("data", onData)
  })
}

async function authCommand(args: string[]): Promise<void> {
  const [sub, provider] = args
  switch (sub) {
    case "login": {
      if (!provider) {
        console.error("usage: dawn auth login <provider>")
        process.exit(1)
      }
      const key = await promptHidden(`API key for ${provider} (input hidden): `)
      if (!key.trim()) {
        console.error("no key entered, nothing saved")
        process.exit(1)
      }
      setApiKey(provider, key.trim())
      console.log(`saved key for ${provider}`)
      return
    }
    case "list": {
      const stored = listAuthProviders()
      if (stored.length === 0) console.log("no stored keys — keys from env vars still work")
      else for (const id of stored) console.log(`${id} (stored)`)
      return
    }
    case "logout": {
      if (!provider) {
        console.error("usage: dawn auth logout <provider>")
        process.exit(1)
      }
      console.log(removeApiKey(provider) ? `removed key for ${provider}` : `no stored key for ${provider}`)
      return
    }
    default:
      console.error("usage: dawn auth <login|list|logout> [provider]")
      process.exit(1)
  }
}

async function modelsCommand(filter: string | undefined, cwd: string): Promise<void> {
  const config = loadConfig(cwd)
  const catalog = await loadCatalog()
  await withOllama(catalog)
  for (const provider of connectedProviders(catalog, config)) {
    if (filter && provider.id !== filter) continue
    for (const model of Object.values(catalog[provider.id]?.models ?? {})) {
      if (model.tool_call === false) continue
      const cost = model.cost ? `$${model.cost.input}/$${model.cost.output}` : "-"
      console.log(`${provider.id}/${model.id}\t${cost}`)
    }
  }
}

async function oneShot(flags: Flags): Promise<void> {
  const prompt = flags.positional.join(" ").trim()
  if (!prompt) {
    console.error('usage: dawn run "<prompt>"')
    process.exit(1)
  }
  const config = loadConfig(flags.cwd)
  const catalog = await loadCatalog()
  await withOllama(catalog)
  const bus = new Bus()
  const gate = new PermissionGate()
  gate.preAllow("read")
  if (flags.yolo) gate.allowAll = true

  const store = new SessionStore()
  const session = store.createSession(flags.cwd, prompt.slice(0, 80))
  const agent = new DawnAgent({
    cwd: flags.cwd,
    modelRef: flags.model ?? pickDefaultModel(catalog, config),
    bus,
    gate,
    catalog,
    config,
    store,
    sessionId: session.id,
  })

  let failed = false
  bus.subscribe((ev) => {
    switch (ev.type) {
      case "text-delta":
        process.stdout.write(ev.text)
        break
      case "text-end":
        process.stdout.write("\n")
        break
      case "tool-start":
        console.error(`⚒ ${ev.name} ${ev.title}`)
        break
      case "error":
        failed = true
        console.error(`error: ${ev.message}`)
        break
      default:
        break
    }
  })

  await agent.send(prompt)
  const totals = agent.ledger.totals()
  console.error(
    `\n[${agent.modelRef}] ↑${totals.inputTokens} ↓${totals.outputTokens} tokens · ` +
      `${totals.cachedInputTokens} cached · $${totals.cost.toFixed(4)}`,
  )
  store.close()
  process.exit(failed ? 1 : 0)
}

async function interactive(flags: Flags): Promise<void> {
  const config = loadConfig(flags.cwd)
  const catalog = await loadCatalog()
  await withOllama(catalog)

  const store = new SessionStore()
  const existing = flags.continue ? store.lastSession(flags.cwd) : undefined
  const session = existing ?? store.createSession(flags.cwd)
  const initialMessages = existing ? store.loadMessages(existing.id) : []

  const bus = new Bus()
  const gate = new PermissionGate()
  const agent = new DawnAgent({
    cwd: flags.cwd,
    modelRef: flags.model ?? pickDefaultModel(catalog, config),
    bus,
    gate,
    catalog,
    config,
    store,
    sessionId: session.id,
    initialMessages,
  })

  const { launchTui } = await import("@dawn/tui")
  await launchTui({ agent, store, session, catalog, config, gate })
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE)
    return
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`dawn ${VERSION}`)
    return
  }
  const [command, ...rest] = argv
  switch (command) {
    case "auth":
      await authCommand(rest)
      return
    case "models": {
      const flags = parseFlags(rest)
      await modelsCommand(flags.positional[0], flags.cwd)
      return
    }
    case "run":
      await oneShot(parseFlags(rest))
      return
    default:
      await interactive(parseFlags(argv))
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
