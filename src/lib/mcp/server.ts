/**
 * Per-request Model Context Protocol server factory.
 * Each stateless request instantiates an isolated server and transport lifecycle.
 */

import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  PingRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js'
import type { AuthIdentity } from '@/lib/api-auth'
import { getSiteConfig } from '@/lib/site'
import { VERSION } from '@/lib/version'
import { ALL_TOOLS, getToolsForIdentity } from './tools'

export async function createMcpServerForRequest(identity: AuthIdentity) {
  const site = await getSiteConfig()
  const server = new Server(
    // serverInfo reuses the single version source (src/lib/version.ts) —
    // no second hardcoded copy that can drift from package.json/VERSION.
    { name: site.name.toLowerCase(), version: VERSION },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  // ── Ping ──
  server.setRequestHandler(PingRequestSchema, async () => ({}))

  // ── Dynamic tool list based on current caller identity ──
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getToolsForIdentity(identity)
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    }
  })

  // ── Tool execution with per-call server-side authorization ──
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params
    const tool = ALL_TOOLS.find((t) => t.name === name)
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`)
    }

    try {
      return await tool.handler(toolArgs ?? {}, identity)
    } catch (e: unknown) {
      const errId = randomUUID().slice(0, 8)
      // Safe server logging: exclude credentials or client auth headers
      console.error(`[MCP] Tool error [${errId}] for ${name}:`, e instanceof Error ? e.stack : e)
      return {
        isError: true,
        content: [{ type: 'text', text: `An internal error occurred while executing ${name}. (Error ID: ${errId})` }],
      }
    }
  })

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })

  await server.connect(transport)
  return { server, transport }
}
