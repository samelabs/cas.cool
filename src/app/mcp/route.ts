/**
 * POST /mcp — official Model Context Protocol (MCP) streamable HTTP endpoint.
 *
 * Auth: Explicit Bearer API Key (unified credential).
 * Protocol: JSON-RPC 2.0 over Streamable HTTP (stateless, per-request lifecycle).
 */

import { after, NextRequest } from 'next/server'
import { drainEnqueuedSideEffects } from '@/lib/services/side-effect.service'
import { resolveIdentity } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { getSiteConfig } from '@/lib/site'
import { createMcpServerForRequest } from '@/lib/mcp/server'
import { isMutationTool } from '@/lib/mcp/tools'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_MCP_BODY_BYTES = 64 * 1024 // 64 KB

function jsonRpcError(code: number, message: string, status = 400, id: unknown = null) {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  )
}

function methodNotAllowed() {
  return new Response(
    JSON.stringify({ error: { code: 'method_not_allowed', message: 'Method Not Allowed. Use POST for MCP requests.' } }),
    {
      status: 405,
      headers: {
        Allow: 'POST',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  )
}

async function verifyOrigin(request: NextRequest): Promise<Response | null> {
  const origin = request.headers.get('origin')
  if (origin !== null) {
    const site = await getSiteConfig()
    const allowed = new Set([site.origin.toLowerCase()])
    if (process.env.NODE_ENV !== 'production') {
      allowed.add('http://localhost:3199')
      allowed.add('http://127.0.0.1:3199')
      allowed.add('http://localhost:3000')
      allowed.add('http://127.0.0.1:3000')
    }
    if (!allowed.has(origin.toLowerCase())) {
      return new Response('Forbidden origin', {
        status: 403,
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
  }
  return null
}

export async function GET(request: NextRequest) {
  const forbidden = await verifyOrigin(request)
  if (forbidden) return forbidden
  return methodNotAllowed()
}

export async function DELETE(request: NextRequest) {
  const forbidden = await verifyOrigin(request)
  if (forbidden) return forbidden
  return methodNotAllowed()
}

export async function PUT(request: NextRequest) {
  const forbidden = await verifyOrigin(request)
  if (forbidden) return forbidden
  return methodNotAllowed()
}

export async function PATCH(request: NextRequest) {
  const forbidden = await verifyOrigin(request)
  if (forbidden) return forbidden
  return methodNotAllowed()
}

export async function POST(request: NextRequest) {
  // ── 1. Origin verification ───────────────────────────────────
  const forbidden = await verifyOrigin(request)
  if (forbidden) return forbidden

  // ── 2. Authentication ────────────────────────────────────────
  // Remote MCP is a bearer-only surface. Reject cookies and query parameters.
  const authHeader = request.headers.get('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: 'Bearer API key required.' } }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="cascool-mcp"',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    )
  }

  const identity = await resolveIdentity({ allowSession: false })
  if (!identity.authenticated || !identity.user) {
    return new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid or expired API key.' } }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="cascool-mcp"',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    )
  }

  if (identity.user.status === 'suspended') {
    return new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: 'Account is suspended.' } }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    )
  }

  // ── 3. Headers & Media Type validation ───────────────────────
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return jsonRpcError(-32000, 'Unsupported Media Type: Content-Type must be application/json', 415)
  }

  const accept = request.headers.get('accept') || ''
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    return jsonRpcError(-32000, 'Not Acceptable: Client must accept both application/json and text/event-stream', 406)
  }

  // ── 4. Bounded body reading ──────────────────────────────────
  const contentLengthHeader = request.headers.get('content-length')
  if (contentLengthHeader) {
    const declaredLength = parseInt(contentLengthHeader, 10)
    if (!Number.isNaN(declaredLength) && declaredLength > MAX_MCP_BODY_BYTES) {
      return jsonRpcError(-32000, 'Payload Too Large: Maximum request size is 64KB', 413)
    }
  }

  let rawBodyText = ''
  if (request.body) {
    const reader = request.body.getReader()
    const decoder = new TextDecoder()
    let bytesRead = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytesRead += value.byteLength
        if (bytesRead > MAX_MCP_BODY_BYTES) {
          await reader.cancel()
          return jsonRpcError(-32000, 'Payload Too Large: Maximum request size is 64KB', 413)
        }
        rawBodyText += decoder.decode(value, { stream: true })
      }
      rawBodyText += decoder.decode()
    } finally {
      reader.releaseLock()
    }
  }

  let parsedBody: unknown
  try {
    parsedBody = rawBodyText ? JSON.parse(rawBodyText) : null
  } catch {
    return jsonRpcError(-32700, 'Parse error: Invalid JSON', 400)
  }

  if (parsedBody === null || typeof parsedBody !== 'object') {
    return jsonRpcError(-32600, 'Invalid Request: Body must be a JSON object', 400)
  }

  // Batch requests not supported — reject arrays to prevent bypasses of limits/guards.
  if (Array.isArray(parsedBody)) {
    return jsonRpcError(-32600, 'Batch requests are not supported', 400)
  }

  const rpc = parsedBody as Record<string, unknown>

  // ── 5. Rate limiting ─────────────────────────────────────────
  // Mutating tools share the write tier quota with REST (60/min).
  // Read tools and protocol handshakes share the read tier quota (120/min).
  const calledTool = rpc.method === 'tools/call' && typeof rpc.params === 'object' && rpc.params !== null
    ? (rpc.params as Record<string, unknown>).name
    : null

  const isWriteTool = typeof calledTool === 'string' && isMutationTool(calledTool)
  const rateLimitTier = isWriteTool ? 'write' : 'read'
  const limited = checkRateLimit(identity, rateLimitTier)
  if (limited) return limited
  after(async () => { await drainEnqueuedSideEffects([]) })

  // ── 6. Execute via isolated Server & Transport ───────────────
  const { server, transport } = await createMcpServerForRequest(identity)
  try {
    const response = await transport.handleRequest(request, { parsedBody })
    // Ensure responses are never cached and nosniff is set
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    response.headers.set('Pragma', 'no-cache')
    response.headers.set('X-Content-Type-Options', 'nosniff')
    return response
  } finally {
    await transport.close().catch(() => {})
    await server.close().catch(() => {})
  }
}
