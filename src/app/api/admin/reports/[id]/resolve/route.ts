/**
 * POST /api/admin/reports/[id]/resolve — resolve report.
 *
 * Auth: Admin (write).
 * Body: { action: 'warn' | 'delete' | 'suspend' | 'none', note?: string }
 *
 * Includes post soft-delete (with count maintenance) and user suspend.
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'
import { upsertNotification } from '@/lib/notification'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

const VALID_ACTIONS = new Set(['warn', 'delete', 'suspend', 'none'])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const admin = auth.identity.user!
  const { id: reportId } = await params

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object')
    return jsonError(400, 'bad_request', 'Invalid JSON.')

  const action = typeof body.action === 'string' ? body.action : ''
  if (!VALID_ACTIONS.has(action))
    return jsonError(400, 'bad_request', 'Invalid action.')

  const note = typeof body.note === 'string' ? body.note : undefined

  const report = await prisma.report.findUnique({
    where: { id: reportId },
    include: { post: { select: { id: true, authorId: true } } },
  })
  if (!report) return jsonError(404, 'not_found', 'Report not found.')
  if (report.status !== 'PENDING')
    return jsonError(400, 'bad_request', 'Report already handled.')

  if (action === 'delete' && report.postId) {
    // Soft-delete with full count maintenance (same as deletePost in posts.ts).
    const post = await prisma.post.findUnique({
      where: { id: report.postId },
      select: { authorId: true, parentId: true, chemicals: { select: { casNumber: true } } },
    })
    if (post) {
      await prisma.$transaction(async (tx) => {
        await tx.post.update({
          where: { id: report.postId! },
          data: { deletedAt: new Date(), content: '', images: [], chemicals: { set: [] } },
        })
        if (post.parentId) {
          await tx.post.update({ where: { id: post.parentId }, data: { replyCount: { decrement: 1 } } })
        }
        await tx.user.update({ where: { id: post.authorId }, data: { postCount: { decrement: 1 } } })
        for (const chem of post.chemicals) {
          await tx.chemical.update({ where: { casNumber: chem.casNumber }, data: { postCount: { decrement: 1 } } })
        }
      })
    }
  }

  if (action === 'suspend') {
    const target = await prisma.user.findUnique({
      where: { id: report.reportedUserId },
      select: { role: true },
    })
    if (target?.role === 'admin') {
      return jsonError(400, 'bad_request', 'Cannot suspend admin accounts.')
    }
    await prisma.user.update({
      where: { id: report.reportedUserId },
      data: { status: 'suspended' },
    })
  }

  await prisma.report.update({
    where: { id: reportId },
    data: {
      status: 'RESOLVED',
      handledBy: admin.id,
      handledAt: new Date(),
      adminNote: note?.trim() || null,
    },
  })

  await upsertNotification({
    userId: report.reporterId,
    fromId: admin.id,
    type: 'REPORT_RESOLVED',
    postId: report.postId,
  })

  if ((action === 'delete' || action === 'suspend') && report.reportedUserId !== report.reporterId) {
    await upsertNotification({
      userId: report.reportedUserId,
      fromId: admin.id,
      type: 'REPORT_RESOLVED',
      postId: report.postId,
    })
  }

  return Response.json({ ok: true, action })
}
