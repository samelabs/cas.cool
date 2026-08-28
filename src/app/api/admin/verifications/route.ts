/**
 * GET /api/admin/verifications — list verification submissions.
 *
 * Auth: Admin (read).
 * Query: status (pending|approved|rejected|all), q (username/displayName
 *        search), cursor (id cursor), take (page size, max 100)
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
  const cursor = sp.get('cursor')
  const takeRaw = Number(sp.get('take'))
  const take = Number.isFinite(takeRaw) && takeRaw > 0 ? Math.min(takeRaw, 100) : 20

  // All filters are pushed down to the DB — the previous post-fetch
  // in-memory username filter silently dropped matches beyond the first
  // 100 rows and provided no pagination.
  const where: Record<string, unknown> = {}
  if (status !== 'all') where.status = status
  if (q) {
    where.user = {
      OR: [
        { username: { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
      ],
    }
  }

  const rows = await prisma.verificationSubmission.findMany({
    where,
    include: {
      user: {
        select: { id: true, username: true, displayName: true, avatar: true, email: true, verificationStatus: true },
      },
    },
    orderBy: { submittedAt: 'desc' },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })

  const hasMore = rows.length > take
  const submissions = hasMore ? rows.slice(0, take) : rows
  const nextCursor = hasMore ? submissions[submissions.length - 1].id : null

  return Response.json({ submissions, nextCursor })
}
