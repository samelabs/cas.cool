/**
 * POST /api/admin/users/[id]/verify — verify user (1-year expiry).
 *
 * Auth: Admin (write).
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const admin = auth.identity.user!
  const { id: userId } = await params

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
  if (!target) return jsonError(404, 'not_found', 'User not found.')

  const now = new Date()
  const expiresAt = new Date(now)
  expiresAt.setFullYear(expiresAt.getFullYear() + 1)

  await prisma.user.update({
    where: { id: userId },
    data: { verificationStatus: 'verified', verifiedAt: now, verificationExpiresAt: expiresAt },
  })

  await prisma.verificationSubmission.updateMany({
    where: { userId },
    data: { status: 'approved', reviewedBy: admin.id, reviewedAt: now, expiresAt },
  }).catch(() => {})

  return Response.json({ ok: true, expiresAt: expiresAt.toISOString() })
}
