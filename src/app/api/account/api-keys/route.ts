/**
 * /api/account/api-keys
 * GET    — list active API keys (unified credentials)
 * POST   — create a unified identity API key (active members)
 *
 * /api/account/api-keys/[id]
 * DELETE — revoke API key
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { generateApiKey } from '@/lib/api-key'
import { getSiteConfig } from '@/lib/site'

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
  const auth = await requireAuth()
  if (!auth.ok) return auth.response

  // API keys cannot create other API keys; credential management requires a web session.
  if (auth.identity.method === 'apikey') {
    return jsonError(403, 'forbidden', 'API keys cannot manage API keys.')
  }

  const user = auth.identity.user!
  if (user.status !== 'active') {
    return jsonError(403, 'forbidden', 'Account is not active.')
  }

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const body = await request.json().catch(() => null)
  if (!body) return jsonError(400, 'bad_request', 'Invalid JSON.')

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
  if (!name) return jsonError(400, 'bad_request', 'Name is required.')

  const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : undefined
  const parsedExpiry = expiresAt ? new Date(expiresAt) : null
  if (expiresAt && (!parsedExpiry || isNaN(parsedExpiry.getTime()))) {
    return jsonError(400, 'bad_request', 'Invalid expiry date.')
  }

  const site = await getSiteConfig()
  const { rawKey, keyHash, prefix } = generateApiKey(site.keyPrefix)

  try {
    const apiKey = await prisma.$transaction(async (tx) => {
      // Row lock on the user serializes concurrent key creations for this user.
      await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`
      const activeCount = await tx.apiKey.count({ where: { userId: user.id, revokedAt: null } })
      if (activeCount >= MAX_ACTIVE_KEYS) {
        throw new Error('KEY_LIMIT_REACHED')
      }
      return tx.apiKey.create({
        data: { userId: user.id, name, keyHash, prefix, expiresAt: parsedExpiry },
        select: { id: true, name: true, prefix: true, createdAt: true, expiresAt: true },
      })
    })

    return Response.json({ ...apiKey, rawKey }, { status: 201 })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'KEY_LIMIT_REACHED') {
      return jsonError(400, 'bad_request', 'Maximum active keys reached.')
    }
    throw error
  }
}
