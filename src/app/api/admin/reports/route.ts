/**
 * GET /api/admin/reports — list reports.
 *
 * Auth: Admin (read).
 * Query: status
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'
import { userSelect } from '@/lib/serialize'

export async function GET(request: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'read')
  if (limited) return limited

  const sp = request.nextUrl.searchParams
  const filterStatus = sp.get('status') || 'PENDING'

  const [reports, pendingCount] = await Promise.all([
    prisma.report.findMany({
      where: filterStatus === 'all' ? {} : { status: filterStatus as 'PENDING' | 'RESOLVED' | 'DISMISSED' },
      include: {
        reporter: { select: userSelect },
        reportedUser: { select: userSelect },
        post: {
          select: {
            id: true, shortCode: true, content: true, images: true, createdAt: true,
            author: { select: userSelect },
          },
        },
        handledByUser: { select: userSelect },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.report.count({ where: { status: 'PENDING' } }),
  ])

  return Response.json({ reports, pendingCount })
}
