/**
 * GET /api/admin/users — list users with pagination.
 *
 * Auth: Admin (read).
 * Query: q, status, page
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'read')
  if (limited) return limited

  const sp = request.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const status = sp.get('status') ?? undefined
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1)
  const pageSize = 50

  const where: Record<string, unknown> = {}
  if (status && status !== 'all') where.status = status
  if (q) where.OR = [{ username: { contains: q, mode: 'insensitive' } }]

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true, username: true, displayName: true, avatar: true, email: true,
        role: true, verificationStatus: true, status: true, createdAt: true,
        postCount: true, followerCount: true, followingCount: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ])

  return Response.json({ users, total, page, pageSize })
}
