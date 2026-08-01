/**
 * /api/account/api-keys
 * GET    — list active API keys
 * POST   — create new API key (verified users only)
 *
 * /api/account/api-keys/[id]
 * DELETE — revoke API key
 *
 * /api/account/verification
 * POST   — submit verification
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth, requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { generateApiKey } from '@/lib/api-key'

const MAX_ACTIVE_KEYS = 5

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

// ── GET /api/account/api-keys ─────────────────────────────────

export async function GET() {
  const auth = await requireAuth()
  if (!auth.ok) return auth.response

  const user = auth.identity.user!
  const keys = await prisma.apiKey.findMany({
    where: { userId: user.id, revokedAt: null },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  })

  return Response.json({ keys })
}

// ── POST /api/account/api-keys ────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!
  if (user.verificationStatus !== 'verified') {
    return jsonError(403, 'forbidden', 'Verification required.')
  }

  const body = await request.json().catch(() => null)
  if (!body) return jsonError(400, 'bad_request', 'Invalid JSON.')

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
  if (!name) return jsonError(400, 'bad_request', 'Name is required.')

  const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : undefined
  const parsedExpiry = expiresAt ? new Date(expiresAt) : null
  if (expiresAt && (!parsedExpiry || isNaN(parsedExpiry.getTime()))) {
    return jsonError(400, 'bad_request', 'Invalid expiry date.')
  }

  const activeCount = await prisma.apiKey.count({ where: { userId: user.id, revokedAt: null } })
  if (activeCount >= MAX_ACTIVE_KEYS) {
    return jsonError(400, 'bad_request', 'Maximum active keys reached.')
  }

  const { rawKey, keyHash, prefix } = generateApiKey()
  const apiKey = await prisma.apiKey.create({
    data: { userId: user.id, name, keyHash, prefix, expiresAt: parsedExpiry },
    select: { id: true, name: true, prefix: true, createdAt: true },
  })

  return Response.json({ ...apiKey, rawKey }, { status: 201 })
}
