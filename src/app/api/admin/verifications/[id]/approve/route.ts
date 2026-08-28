/**
 * POST /api/admin/verifications/[id]/approve — approve verification.
 *
 * Auth: Admin (write).
 * Body: { expiresAt?: string }
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
  // State machine: only pending submissions can be approved. Prevents
  // double-approve races and resurrecting a rejected submission.
  if (submission.status !== 'pending') {
    return jsonError(409, 'conflict', 'Submission is not pending review.')
  }

  const body = await request.json().catch(() => ({}))
  const expiresAt = typeof body?.expiresAt === 'string' ? body.expiresAt : undefined

  const now = new Date()
  const MAX_VERIFICATION_YEARS = 5
  let expiry: Date
  if (expiresAt) {
    const parsed = new Date(expiresAt)
    if (isNaN(parsed.getTime()))
      return jsonError(400, 'bad_request', 'Invalid expiry date.')
    if (parsed.getTime() > now.getTime() + MAX_VERIFICATION_YEARS * 365.25 * 24 * 3600 * 1000)
      return jsonError(400, 'bad_request', 'Expiry date is too far in the future.')
    expiry = parsed
  } else {
    expiry = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
  }

  // Optimistic lock: the update itself re-checks 'pending' — the pre-check
  // above is advisory (UX), this is the enforcement. A concurrent approve/
  // reject that wins the race makes updateMany hit 0 rows → 409, not a
  // double-apply.
  const [subResult] = await prisma.$transaction([
    prisma.verificationSubmission.updateMany({
      where: { id: submissionId, status: 'pending' },
      data: { status: 'approved', reviewedBy: admin.id, reviewedAt: now, expiresAt: expiry },
    }),
    prisma.user.update({
      where: { id: submission.userId },
      data: { verificationStatus: 'verified', verifiedAt: now, verificationExpiresAt: expiry },
    }),
  ])
  if (subResult.count === 0) {
    return jsonError(409, 'conflict', 'Submission is not pending review.')
  }

  return Response.json({ ok: true })
}
