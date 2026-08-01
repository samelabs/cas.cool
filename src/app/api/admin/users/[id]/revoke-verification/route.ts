/**
 * POST /api/admin/users/[id]/revoke-verification — revoke verification.
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

  await prisma.user.update({
    where: { id: userId },
    data: { verificationStatus: 'unverified', verifiedAt: null, verificationExpiresAt: null },
  })

  await prisma.verificationSubmission.updateMany({
    where: { userId },
    data: {
      status: 'rejected',
      reviewedBy: admin.id,
      reviewedAt: new Date(),
      reviewNote: 'Verification revoked by admin.',
    },
  }).catch(() => {})

  return Response.json({ ok: true })
}
