/**
 * GET /api/admin/verifications — list verification submissions.
 *
 * Auth: Admin (read).
 * Query: status, q
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'read')
  if (limited) return limited

  const sp = request.nextUrl.searchParams
  const status = sp.get('status') || 'pending'
  const q = (sp.get('q') ?? '').trim()

  const where: Record<string, unknown> = {}
  if (status !== 'all') where.status = status

  let submissions = await prisma.verificationSubmission.findMany({
    where,
    include: {
      user: {
        select: { id: true, username: true, displayName: true, avatar: true, email: true, verificationStatus: true },
      },
    },
    orderBy: { submittedAt: 'desc' },
    take: 100,
  })

  if (q) {
    const ql = q.toLowerCase()
    submissions = submissions.filter((s) => s.user.username.toLowerCase().includes(ql))
  }

  return Response.json({ submissions })
}
