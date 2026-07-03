import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServerConfig } from "./config"
import { isMcpStdio } from "./config"

const CONNECT_TIMEOUT_MS = 8000

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpConnection {
  name: string
  client: Client
  tools: McpToolInfo[]
  close(): Promise<void>
  error?: string
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP connect timed out after ${ms}ms: ${label}`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function connectOne(name: string, config: McpServerConfig, timeoutMs: number): Promise<McpConnection> {
  const client = new Client({ name: "dawn", version: "1.0.0" }, { capabilities: {} })

  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

  if (isMcpStdio(config)) {
    const baseEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) baseEnv[k] = v
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ? { ...baseEnv, ...config.env } : undefined,
    })
  } else {
    // HTTP/SSE
    const url = new URL(config.url)
    const headers = config.headers
    if (config.type === "sse") {
      transport = new SSEClientTransport(url, { requestInit: headers ? { headers } : undefined })
    } else {
      transport = new StreamableHTTPClientTransport(url, { requestInit: headers ? { headers } : undefined })
    }
  }

  await withTimeout(client.connect(transport), timeoutMs, name)

  const { tools: rawTools } = await withTimeout(client.listTools(), timeoutMs, `${name}.listTools`)
  const tools: McpToolInfo[] = rawTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
  }))

  return {
    name,
    client,
    tools,
    close: () => client.close(),
  }
}

/**
 * Connect to all configured MCP servers in parallel.
 * A server that fails to connect is recorded with `error` and skipped — never throws.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  opts: { timeoutMs?: number } = {},
): Promise<McpConnection[]> {
  const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS
  const entries = Object.entries(servers)
  if (entries.length === 0) return []

  const results = await Promise.allSettled(
    entries.map(([name, config]) => connectOne(name, config, timeoutMs)),
  )

  return results.map((result, i): McpConnection => {
    if (result.status === "fulfilled") return result.value
    const name = entries[i]?.[0] ?? `server-${i}`
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason)
    // Return a stub so /mcp can show the failed server with its error
    return {
      name,
      client: {} as Client,
      tools: [],
      close: async () => {},
      error,
    }
  })
}
