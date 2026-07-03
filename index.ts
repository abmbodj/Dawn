#!/usr/bin/env bun
import fs from "node:fs"
import path from "node:path"
import {
  Asker,
  addPlugin,
  Bus,
  buildRepoIndex,
  type ContextMode,
  ContextStore,
  connectedProviders,
  DawnAgent,
  type DawnConfig,
  DEFAULT_CONTEXT_MODE,
  DEFAULT_TOKEN_BUDGET,
  type DoctorMode,
  type DoctorResult,
  listAuthProviders,
  listInstalledPlugins,
  loadCatalog,
  loadConfig,
  type ModelSelection,
  openExternalUrl,
  PermissionGate,
  pluginsDir,
  pollForToken,
  removeApiKey,
  removePlugin,
  resolveGithubClientId,
  runModelDoctor,
  SessionStore,
  saveConfig,
  selectInitialModel,
  setApiKey,
  startDeviceFlow,
  tryGhCliToken,
  withAllLiveModels,
  withLMStudio,
  withOllama,
} from "@dawn/core"

const VERSION = "0.1.0"

const USAGE = `dawn — token-frugal AI coding agent

Usage:
  dawn                       interactive session in the current directory
  dawn -c, --continue        resume the most recent session for this directory
  dawn -m, --model <ref>     model as provider/model (e.g. anthropic/claude-opus-4-8)
  dawn --budget <tokens>     cap estimated prompt tokens (default 8000)
  dawn --context <mode>      minimal, balanced, or deep (default balanced)
  dawn --naive               baseline mode: full files & history, no compaction or caching
  dawn run "<prompt>"        one-shot non-interactive run (add --yolo to allow edits/bash)
  dawn index                 build or refresh the repo context index
  dawn auth login <provider> store an API key (anthropic, openai, google, …)
  dawn auth list             show configured providers
  dawn auth logout <provider>
  dawn models [provider]     list known models for connected providers
  dawn models --refresh      re-fetch model list from models.dev
  dawn doctor models         smoke-test that models actually run (blessed by default)
  dawn doctor models --all   test every floor-passing model on connected providers
  dawn doctor models --provider <id>
  dawn --version | --help`

interface Flags {
  continue: boolean
  model?: string
  cwd: string
  yolo: boolean
  budget: number
  contextMode: ContextMode
  naive: boolean
  refresh?: boolean
  positional: string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    continue: false,
    cwd: process.cwd(),
    yolo: false,
    budget: DEFAULT_TOKEN_BUDGET,
    contextMode: DEFAULT_CONTEXT_MODE,
    naive: false,
    positional: [],
  }
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
      case "--naive":
        flags.naive = true
        break
      case "--budget": {
        const raw = argv[++i]
        const budget = Number(raw)
        if (!Number.isFinite(budget) || budget <= 0) {
          console.error("usage: --budget <positive token count>")
          process.exit(1)
        }
        flags.budget = Math.floor(budget)
        break
      }
      case "--context": {
        const mode = argv[++i] as ContextMode | undefined
        if (mode !== "minimal" && mode !== "balanced" && mode !== "deep") {
          console.error("usage: --context <minimal|balanced|deep>")
          process.exit(1)
        }
        flags.contextMode = mode
        break
      }
      case "--refresh":
        flags.refresh = true
        break
      default:
        flags.positional.push(arg)
    }
  }
  return flags
}

async function indexCommand(flags: Flags): Promise<void> {
  const store = new ContextStore()
  try {
    const result = await buildRepoIndex(flags.cwd, store)
    const status = store.indexStatus(flags.cwd)
    console.log(
      `indexed ${result.indexed} files for ${flags.cwd} (${result.skipped} skipped) ` +
        `at ${new Date(status.updatedAt ?? Date.now()).toLocaleString()}`,
    )
  } finally {
    store.close()
  }
}

function noInitialModelMessage(): string {
  return (
    "No live tool-capable model is available. Connect a provider first:\n" +
    "  dawn auth login <provider>   e.g. dawn auth login anthropic\n" +
    "  dawn                         guided setup (interactive)\n" +
    "or pass --model provider/model."
  )
}

function projectConfigHasModel(cwd: string): boolean {
  try {
    const project = JSON.parse(fs.readFileSync(path.join(cwd, "dawn.json"), "utf8")) as { model?: unknown }
    return typeof project.model === "string" && project.model.trim().length > 0
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    return false
  }
}

function runtimeConfig(config: DawnConfig, selection: ModelSelection | undefined): DawnConfig {
  return { ...config, model: selection?.ref }
}

function persistRepairedModel(cwd: string, selection: ModelSelection | undefined): void {
  if (!selection?.repairedFrom || projectConfigHasModel(cwd)) return
  saveConfig({ model: selection.ref })
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

async function authCommand(args: string[], cwd: string): Promise<void> {
  const [sub, provider] = args
  switch (sub) {
    case "login": {
      if (!provider) {
        console.error("usage: dawn auth login <provider>")
        process.exit(1)
      }
      if (provider === "github-copilot") {
        const ghToken = await tryGhCliToken()
        if (ghToken) {
          setApiKey("github-copilot", ghToken)
          console.log("GitHub Copilot connected via GitHub CLI.")
          return
        }
        const config = loadConfig(cwd)
        const clientId = resolveGithubClientId(config)
        if (!clientId) {
          console.error("Run `gh auth login` for automatic sign-in, or paste a token below.")
          const key = await promptHidden("GitHub Copilot token (input hidden): ")
          if (!key.trim()) {
            console.error("no token entered, nothing saved")
            process.exit(1)
          }
          setApiKey("github-copilot", key.trim())
          console.log("saved token for github-copilot")
          return
        }
        const flow = await startDeviceFlow(clientId)
        const opened = await openExternalUrl(flow.verificationUri)
        if (opened) console.log("Opened GitHub device authorization in your browser.")
        else console.log(`Open: ${flow.verificationUri}`)
        console.log(`Code: ${flow.userCode}`)
        console.log("Waiting for authorization…")
        const token = await pollForToken(clientId, flow.deviceCode, flow.interval)
        setApiKey("github-copilot", token)
        console.log("GitHub Copilot connected.")
        return
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

async function modelsCommand(
  filter: string | undefined,
  refresh: boolean | undefined,
  cwd: string,
): Promise<void> {
  const config = loadConfig(cwd)
  const catalog = await loadCatalog({ refresh })
  await Promise.all([withOllama(catalog), withLMStudio(catalog)])
  await withAllLiveModels(catalog, config)
  for (const provider of connectedProviders(catalog, config)) {
    if (filter && provider.id !== filter) continue
    for (const model of Object.values(catalog[provider.id]?.models ?? {})) {
      if (model.tool_call === false) continue
      const cost = model.cost ? `$${model.cost.input}/$${model.cost.output}` : "-"
      console.log(`${provider.id}/${model.id}\t${cost}`)
    }
  }
}

async function doctorCommand(args: string[], cwd: string): Promise<void> {
  const [subject, ...rest] = args
  if (subject !== "models") {
    console.error("usage: dawn doctor models [--all | --provider <id>]")
    process.exit(1)
  }

  let mode: DoctorMode = "blessed"
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--all") mode = "all"
    else if (rest[i] === "--provider") {
      const provider = rest[++i]
      if (!provider) {
        console.error("usage: dawn doctor models --provider <id>")
        process.exit(1)
      }
      mode = { provider }
    }
  }

  const config = loadConfig(cwd)
  const catalog = await loadCatalog()
  await Promise.all([withOllama(catalog), withLMStudio(catalog)])
  await withAllLiveModels(catalog, config)

  const label = typeof mode === "object" ? mode.provider : mode
  console.log(`Running model doctor (${label})… one canonical tool-call task per model.\n`)

  const fmt = (r: DoctorResult) =>
    `${r.ok ? "✓ PASS" : "✗ FAIL"}  ${r.ref}  ·  ${r.failureKind}  (${(r.durationMs / 1000).toFixed(1)}s)` +
    (r.ok ? "" : `\n         ${r.detail}`)

  const results = await runModelDoctor(catalog, config, mode, (r) => console.log(fmt(r)))

  if (results.length === 0) {
    console.log("No matching connected models to test. Connect a provider or pass --provider <id>.")
    return
  }
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} passed.`)
  process.exit(passed === results.length ? 0 : 1)
}

async function oneShot(flags: Flags): Promise<void> {
  const prompt = flags.positional.join(" ").trim()
  if (!prompt) {
    console.error('usage: dawn run "<prompt>"')
    process.exit(1)
  }
  const config = loadConfig(flags.cwd)
  const catalog = await loadCatalog()
  await Promise.all([withOllama(catalog), withLMStudio(catalog)])
  await withAllLiveModels(catalog, config)
  const selection = selectInitialModel(catalog, config, { requestedModel: flags.model })
  if (!selection) {
    console.error(`error: ${noInitialModelMessage()}`)
    process.exit(1)
  }
  persistRepairedModel(flags.cwd, selection)
  const activeConfig = runtimeConfig(config, selection)
  const bus = new Bus()
  const gate = new PermissionGate()
  gate.preAllow("read")
  if (flags.yolo) gate.allowAll = true
  for (const [toolName, perm] of Object.entries(activeConfig.permissions ?? {})) {
    if (perm === "allow") gate.preAllow(toolName)
  }

  const store = new SessionStore()
  const contextStore = new ContextStore()
  const session = store.createSession(flags.cwd, prompt.slice(0, 80))
  const agent = new DawnAgent({
    cwd: flags.cwd,
    modelRef: selection.ref,
    planModelRef: activeConfig.planModel,
    bus,
    gate,
    catalog,
    config: activeConfig,
    store,
    sessionId: session.id,
    contextStore,
    contextMode: flags.contextMode,
    tokenBudget: flags.budget,
    naive: flags.naive,
  })

  const mcpServers = agent.resolveMcpServers()
  if (Object.keys(mcpServers).length > 0) {
    const conns = await agent.initMcp(mcpServers)
    for (const c of conns) {
      if (c.error) console.error(`mcp: ${c.name} failed — ${c.error}`)
      else console.error(`mcp: ${c.name} connected (${c.tools.length} tools)`)
    }
  }

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
  contextStore.close()
  process.exit(failed ? 1 : 0)
}

async function interactive(flags: Flags): Promise<void> {
  const config = loadConfig(flags.cwd)
  const catalog = await loadCatalog()
  await Promise.all([withOllama(catalog), withLMStudio(catalog)])
  await withAllLiveModels(catalog, config)
  const selection = selectInitialModel(catalog, config, { requestedModel: flags.model })
  persistRepairedModel(flags.cwd, selection)
  const activeConfig = runtimeConfig(config, selection)

  const store = new SessionStore()
  const contextStore = new ContextStore()
  const existing = flags.continue ? store.lastSession(flags.cwd) : undefined
  const session = existing ?? store.createSession(flags.cwd)
  const initialMessages = existing ? store.loadMessages(existing.id) : []

  const bus = new Bus()
  const gate = new PermissionGate()
  for (const [toolName, perm] of Object.entries(activeConfig.permissions ?? {})) {
    if (perm === "allow") gate.preAllow(toolName)
  }
  const asker = new Asker()
  const agent = new DawnAgent({
    cwd: flags.cwd,
    modelRef: selection?.ref ?? "github-copilot/gpt-4o",
    planModelRef: activeConfig.planModel,
    bus,
    gate,
    asker,
    catalog,
    config: activeConfig,
    store,
    sessionId: session.id,
    initialMessages,
    contextStore,
    contextMode: flags.contextMode,
    tokenBudget: flags.budget,
    naive: flags.naive,
  })

  const mcpServers = agent.resolveMcpServers()
  if (Object.keys(mcpServers).length > 0) {
    const conns = await agent.initMcp(mcpServers)
    for (const c of conns) {
      if (c.error) console.error(`mcp: ${c.name} failed — ${c.error}`)
      else console.error(`mcp: ${c.name} connected (${c.tools.length} tools)`)
    }
  }

  const { launchTui } = await import("@dawn/tui")
  await launchTui({ agent, store, session, catalog, config: activeConfig, gate, asker })
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
    case "auth": {
      const flags = parseFlags(rest)
      await authCommand(flags.positional, flags.cwd)
      return
    }
    case "models": {
      const flags = parseFlags(rest)
      await modelsCommand(flags.positional[0], flags.refresh, flags.cwd)
      return
    }
    case "index":
      await indexCommand(parseFlags(rest))
      return
    case "doctor": {
      const flags = parseFlags(rest)
      await doctorCommand(flags.positional, flags.cwd)
      return
    }
    case "plugin": {
      const [subCmd, ...pluginArgs] = rest
      switch (subCmd) {
        case "add": {
          const source = pluginArgs[0]
          if (!source) {
            console.error("usage: dawn plugin add <git-url|path>")
            process.exit(1)
          }
          const plugin = await addPlugin(source)
          console.log(
            `Installed plugin "${plugin.name}" (${plugin.commands.length} commands, ${plugin.skills.length} skills).`,
          )
          console.log(
            `Enable it by adding "${plugin.name}" to plugins.enabled in dawn.json or ~/.config/dawn/config.json.`,
          )
          return
        }
        case "remove": {
          const name = pluginArgs[0]
          if (!name) {
            console.error("usage: dawn plugin remove <name>")
            process.exit(1)
          }
          removePlugin(name)
          console.log(`Removed plugin "${name}" from ${pluginsDir()}.`)
          return
        }
        default: {
          const plugins = listInstalledPlugins()
          if (plugins.length === 0) {
            console.log(`No plugins installed in ${pluginsDir()}.`)
          } else {
            for (const p of plugins) {
              console.log(`  ${p.name}  ${p.manifest.description ?? ""}`)
              console.log(`    dir: ${p.dir}`)
              console.log(
                `    commands: ${p.commands.length}  skills: ${p.skills.length}  mcp-servers: ${Object.keys(p.mcpServers).length}`,
              )
            }
          }
          return
        }
      }
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
