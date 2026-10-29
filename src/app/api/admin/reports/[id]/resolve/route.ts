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
import { deleteReportedPost } from '@/lib/services/post-write.service'
import { revalidateTrending } from '@/lib/services/user.service'
import {
  drainSideEffects,
  enqueueSideEffects,
  type SideEffectInput,
} from '@/lib/services/side-effect.service'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

const VALID_ACTIONS = new Set(['warn', 'delete', 'suspend', 'none'])

class ReportResolveError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ReportResolveError'
    this.status = status
    this.code = code
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin('write')
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

  // Atomic moderation transaction:
  // 1. Preemptively claim PENDING report before any penalty is applied.
  // 2. If preemption fails, no penalty has been written.
  // 3. If any penalty fails, transaction throws and rolls back completely.
  try {
    const txResult = await prisma.$transaction(async (tx) => {
      const updated = await tx.report.updateMany({
        where: { id: reportId, status: 'PENDING' },
        data: {
          status: 'RESOLVED',
          handledBy: admin.id,
          handledAt: new Date(),
          adminNote: note?.trim() || null,
        },
      })
      if (updated.count === 0) {
        const existing = await tx.report.findUnique({
          where: { id: reportId },
          select: { status: true },
        })
        if (!existing) {
          throw new ReportResolveError(404, 'not_found', 'Report not found.')
        }
        throw new ReportResolveError(400, 'bad_request', 'Report already handled.')
      }

      const report = await tx.report.findUnique({
        where: { id: reportId },
        select: {
          id: true,
          reporterId: true,
          reportedUserId: true,
          postId: true,
        },
      })
      if (!report) {
        throw new ReportResolveError(404, 'not_found', 'Report not found.')
      }

      if (action === 'suspend') {
        const target = await tx.user.findUnique({
          where: { id: report.reportedUserId },
          select: { role: true },
        })
        if (target?.role === 'admin') {
          throw new ReportResolveError(400, 'bad_request', 'Cannot suspend admin accounts.')
        }
        await tx.user.update({
          where: { id: report.reportedUserId },
          data: { status: 'suspended' },
        })
      }

      let imagesToDelete: string[] = []
      if (action === 'delete' && report.postId) {
        const del = await deleteReportedPost(report.postId, tx)
        if (del.deleted) {
          imagesToDelete = del.images
        }
      }

      // Durable side effects (transactional outbox): enqueued in the SAME
      // transaction as the resolution, executed after commit. A failure
      // keeps the task pending (attempts/lastError) for retry instead of
      // surfacing as a false 500 for an already-committed resolution.
      // Notification payloads carry a persistent eventKey so at-least-once
      // execution yields exactly one notification row per event — including
      // user-only reports where postId is NULL (the compound notification
      // unique constraint cannot dedup those).
      const tasks: SideEffectInput[] = [
        {
          kind: 'notification',
          payload: {
            userId: report.reporterId,
            fromId: admin.id,
            type: 'REPORT_RESOLVED' as const,
            postId: report.postId,
            eventKey: `report:${report.id}:resolved:reporter:${report.reporterId}`,
          },
        },
      ]
      if (
        (action === 'delete' || action === 'suspend') &&
        report.reportedUserId !== report.reporterId
      ) {
        tasks.push({
          kind: 'notification',
          payload: {
            userId: report.reportedUserId,
            fromId: admin.id,
            type: 'REPORT_RESOLVED' as const,
            postId: report.postId,
            eventKey: `report:${report.id}:resolved:reported:${report.reportedUserId}`,
          },
        })
      }
      for (const url of imagesToDelete) {
        tasks.push({ kind: 'upload_cleanup', payload: { url } })
      }
      const taskIds = await enqueueSideEffects(tx, tasks)

      return {
        report: {
          id: report.id,
          reporterId: report.reporterId,
          reportedUserId: report.reportedUserId,
          postId: report.postId,
        },
        taskIds,
      }
    })

    // Post-commit side effects — best-effort by design. The outbox rows are
    // durable: any failure stays pending and is trackable / retryable via
    // POST /api/admin/side-effects/retry. The committed resolution itself
    // responds 200 regardless (a 500 here would invite a client retry that
    // can only fail with 400 'Report already handled').
    if (txResult.report.postId && ['delete', 'suspend'].includes(action)) {
      revalidateTrending()
    }

    try {
      const drained = await drainSideEffects({ ids: txResult.taskIds })
      if (drained.failed > 0) {
        console.error('[AdminResolve] side-effect tasks failed (pending retry):', {
          reportId,
          failed: drained.failedTasks,
        })
      }
    } catch (drainErr) {
      console.error('[AdminResolve] side-effect drain crashed (tasks stay pending):', {
        reportId,
        taskIds: txResult.taskIds,
        error: drainErr,
      })
    }

    return Response.json({ ok: true, action })
  } catch (err: unknown) {
    if (err instanceof ReportResolveError) {
      return jsonError(err.status, err.code, err.message)
    }
    throw err
  }
}
