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
    select: { userId: true },
  })
  if (!submission) return jsonError(404, 'not_found', 'Submission not found.')

  const body = await request.json().catch(() => ({}))
  const expiresAt = typeof body?.expiresAt === 'string' ? body.expiresAt : undefined

  const now = new Date()
  let expiry: Date
  if (expiresAt) {
    const parsed = new Date(expiresAt)
    if (isNaN(parsed.getTime()))
      return jsonError(400, 'bad_request', 'Invalid expiry date.')
    expiry = parsed
  } else {
    expiry = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
  }

  await prisma.$transaction([
    prisma.verificationSubmission.update({
      where: { id: submissionId },
      data: { status: 'approved', reviewedBy: admin.id, reviewedAt: now, expiresAt: expiry },
    }),
    prisma.user.update({
      where: { id: submission.userId },
      data: { verificationStatus: 'verified', verifiedAt: now, verificationExpiresAt: expiry },
    }),
  ])

  return Response.json({ ok: true })
}
