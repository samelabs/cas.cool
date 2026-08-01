/**
 * POST /api/reports — submit a report (post or user).
 *
 * Auth: API Key or Session (write).
 * Body (JSON): { targetType: 'POST' | 'USER', targetId: string, reason: string, detail?: string }
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

const VALID_REASONS = new Set([
  'spam', 'harassment', 'misinformation', 'illegal_substance',
  'scam_fraud', 'impersonation', 'other',
])

export async function POST(request: NextRequest) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError(400, 'bad_request', 'Invalid JSON.')

  const targetType = typeof body.targetType === 'string' ? body.targetType : ''
  const targetId = typeof body.targetId === 'string' ? body.targetId : ''
  const reason = typeof body.reason === 'string' ? body.reason : ''
  const clampedDetail =
    typeof body.detail === 'string' && body.detail ? body.detail.trim().slice(0, 500) : null

  if (!targetType || !targetId || !reason)
    return jsonError(400, 'bad_request', 'Missing required fields.')
  if (targetType !== 'POST' && targetType !== 'USER')
    return jsonError(400, 'bad_request', 'Invalid target type.')
  if (!VALID_REASONS.has(reason))
    return jsonError(400, 'bad_request', 'Invalid reason.')

  let reportedUserId: string
  let postId: string | null = null

  if (targetType === 'POST') {
    const post = await prisma.post.findUnique({ where: { id: targetId }, select: { authorId: true } })
    if (!post) return jsonError(404, 'not_found', 'Post not found.')
    reportedUserId = post.authorId
    postId = targetId
  } else {
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } })
    if (!target) return jsonError(404, 'not_found', 'User not found.')
    reportedUserId = target.id
  }

  if (reportedUserId === user.id)
    return jsonError(400, 'bad_request', 'Cannot report yourself.')

  const existing = await prisma.report.findFirst({
    where: {
      reporterId: user.id,
      targetType: targetType as 'POST' | 'USER',
      ...(postId ? { postId } : { postId: null, reportedUserId }),
      status: 'PENDING',
    },
  })

  if (existing) {
    await prisma.report.update({ where: { id: existing.id }, data: { reason, detail: clampedDetail } })
  } else {
    await prisma.report.create({
      data: {
        reporterId: user.id,
        targetType: targetType as 'POST' | 'USER',
        postId,
        reportedUserId,
        reason,
        detail: clampedDetail,
      },
    })
  }

  return Response.json({ ok: true }, { status: 201 })
}
