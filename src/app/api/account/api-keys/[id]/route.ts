/**
 * DELETE /api/account/api-keys/[id] — revoke API key
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth()
  if (!auth.ok) return auth.response

  if (auth.identity.method === 'apikey') {
    return jsonError(403, 'forbidden', 'API keys cannot manage API keys.')
  }

  const user = auth.identity.user!
  if (user.status !== 'active') {
    return jsonError(403, 'forbidden', 'Account is not active.')
  }

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const { id } = await params

  await prisma.apiKey.updateMany({
    where: { id, userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  return Response.json({ ok: true })
}
