import { dynamicTool, jsonSchema, type ToolSet } from "ai"
import { compactBudget } from "../context/budget"
import { compactToolOutput } from "../context/compact"
import type { ToolContext } from "../tools/index"
import type { McpConnection } from "./client"

const DENIED = "Permission denied by user. Ask before retrying, or propose an alternative."

/**
 * Maps MCP connections to an AI SDK ToolSet.
 * Keys follow the Claude Code convention: mcp__<server>__<tool>.
 * All MCP tools are permission-gated (external side effects) and their
 * outputs are compacted the same way as other heavy tools.
 */
export function mcpToolsToToolSet(connections: McpConnection[], ctx: ToolContext): ToolSet {
  const tools: ToolSet = {}
  const mode = ctx.contextMode ?? "balanced"

  for (const conn of connections) {
    if (conn.error) continue // failed connections have no tools
    for (const toolInfo of conn.tools) {
      const key = `mcp__${conn.name}__${toolInfo.name}`

      tools[key] = dynamicTool({
        description: toolInfo.description
          ? `[MCP: ${conn.name}] ${toolInfo.description}`
          : `[MCP: ${conn.name}] ${toolInfo.name}`,
        inputSchema: jsonSchema(toolInfo.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (input: unknown) => {
          const allowed = await ctx.gate.ask({
            tool: key,
            title: `${conn.name} / ${toolInfo.name}`,
            detail: JSON.stringify(input, null, 2).slice(0, 200),
          })
          if (!allowed) return DENIED

          let result: string
          try {
            const response = await conn.client.callTool({
              name: toolInfo.name,
              arguments: input as Record<string, unknown>,
            })
            // Flatten content array to a string
            result = (response.content as Array<{ type: string; text?: string }>)
              .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type} content]`))
              .join("\n")
            if (response.isError) result = `MCP error: ${result}`
          } catch (err) {
            result = `MCP call failed: ${err instanceof Error ? err.message : String(err)}`
          }

          // Route through compaction like other heavy tools
          if (ctx.contextStore) {
            const budget = compactBudget(mode)
            const outcome = compactToolOutput(result, {
              tool: key,
              budget,
              store: ctx.contextStore,
              sessionId: ctx.sessionId,
            })
            if (outcome.compacted) ctx.onCompaction?.(outcome.beforeTokens, outcome.afterTokens)
            return outcome.text
          }
          return result
        },
      })
    }
  }

  return tools
}
