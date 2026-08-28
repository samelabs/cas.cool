/**
 * POST /api/admin/verifications/[id]/reject — reject verification.
 *
 * Auth: Admin (write).
 * Body: { note?: string }
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const admin = auth.identity.user!
  const { id: submissionId } = await params

  const submission = await prisma.verificationSubmission.findUnique({
    where: { id: submissionId },
    select: { userId: true, status: true },
  })
  if (!submission) return jsonError(404, 'not_found', 'Submission not found.')
  // State machine: only pending submissions can be rejected.
  if (submission.status !== 'pending') {
    return jsonError(409, 'conflict', 'Submission is not pending review.')
  }

  const body = await request.json().catch(() => ({}))
  const note = typeof body?.note === 'string' ? body.note : undefined

  const now = new Date()

  // Optimistic lock: the update itself re-checks 'pending' (see approve).
  const [subResult] = await prisma.$transaction([
    prisma.verificationSubmission.updateMany({
      where: { id: submissionId, status: 'pending' },
      data: {
        status: 'rejected',
        reviewedBy: admin.id,
        reviewedAt: now,
        reviewNote: note?.trim() || null,
      },
    }),
    prisma.user.update({
      where: { id: submission.userId },
      data: { verificationStatus: 'unverified' },
    }),
  ])
  if (subResult.count === 0) {
    return jsonError(409, 'conflict', 'Submission is not pending review.')
  }

  return Response.json({ ok: true })
}
