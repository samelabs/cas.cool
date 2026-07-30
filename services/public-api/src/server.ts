import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { authenticate } from './auth'
import { config } from './config'
import { closeDatabase, prisma } from './db'
import { apiError, clientIp, HttpError, json } from './http'
import { manifest } from './manifest'
import { readLimiter, unauthenticatedLimiter, writeLimiter } from './rate-limit'
import { resolveRoute } from './routes'

const server = createServer(async (req, res) => {
  const startedAt = Date.now()
  const requestId = randomUUID()
  res.setHeader('X-Request-Id', requestId)

  try {
    if (!req.url || !req.method) throw new HttpError(400, 'bad_request', 'Invalid request.')
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)

    if (url.pathname === '/healthz') {
      if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(404, 'not_found', 'Resource not found.')
      await prisma.$queryRaw`SELECT 1`
      json(res, 200, { status: 'ok' })
      return
    }

    if (!url.pathname.startsWith('/api/v1')) throw new HttpError(404, 'not_found', 'Resource not found.')

    // Discovery index — public, no auth required. This is the agent entry point.
    if (url.pathname === '/api/v1' || url.pathname === '/api/v1/') {
      json(res, 200, manifest)
      return
    }

    if (!url.pathname.startsWith('/api/v1/')) throw new HttpError(404, 'not_found', 'Resource not found.')
    if (!unauthenticatedLimiter.consume(clientIp(req))) {
      throw new HttpError(429, 'rate_limited', 'Too many requests.', { 'Retry-After': '1' })
    }

    const resolved = resolveRoute(req.method.toUpperCase(), url.pathname)
    if (!resolved) throw new HttpError(404, 'not_found', 'Resource not found.')

    const user = await authenticate(req)
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())
    const limiter = isWrite ? writeLimiter : readLimiter
    if (!limiter.consume(user.apiKeyId)) {
      throw new HttpError(429, 'rate_limited', 'Too many requests.', { 'Retry-After': '1' })
    }

    await resolved.handler({ req, res, url, user }, resolved.params)
  } catch (error) {
    if (error instanceof HttpError) {
      apiError(res, error.status, error.code, error.message, error.headers)
    } else {
      console.error(JSON.stringify({ level: 'error', requestId, event: 'request_failed', error: String(error) }))
      apiError(res, 500, 'server_error', 'An unexpected error occurred.')
    }
  } finally {
    console.log(JSON.stringify({
      level: 'info',
      requestId,
      method: req.method,
      path: req.url?.split('?')[0],
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }))
  }
})

server.requestTimeout = config.requestTimeoutMs
server.headersTimeout = config.requestTimeoutMs + 1000
server.keepAliveTimeout = 5000
server.maxRequestsPerSocket = 1000

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: 'info', event: 'server_started', host: config.host, port: config.port }))
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }))

  const forceTimer = setTimeout(() => process.exit(1), 10_000)
  forceTimer.unref()
  server.close(async () => {
    try {
      await closeDatabase()
      process.exit(0)
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'shutdown_failed', error: String(error) }))
      process.exit(1)
    }
  })
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
