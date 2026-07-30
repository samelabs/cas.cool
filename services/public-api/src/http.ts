import type { IncomingMessage, ServerResponse } from 'node:http'

export interface ApiErrorBody {
  error: { code: string; message: string }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

export function apiError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  json(res, status, { error: { code, message } } satisfies ApiErrorBody, headers)
}

export async function readJson(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const contentType = req.headers['content-type'] || ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.')
  }

  const declaredLength = Number(req.headers['content-length'] || 0)
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large.')
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limitBytes) {
      throw new HttpError(413, 'payload_too_large', 'Request body is too large.')
    }
    chunks.push(buffer)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body must be valid JSON.')
  }
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
  return first?.trim() || req.socket.remoteAddress || 'unknown'
}
