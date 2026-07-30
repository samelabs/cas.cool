'use server'

import { prisma } from '@/lib/db'
import { userSelect } from '@/lib/serialize'
import { upsertNotification } from '@/lib/notification'
import { revalidatePath } from 'next/cache'
import { ActionResult, ActionError } from './_shared'
import { withResult, requireAdmin } from './_guards'

// ─── User Management ──────────────────────────────────────────

export async function adminListUsers(params: {
  q?: string
  status?: string
  page?: number
}): Promise<ActionResult<{
  users: unknown[]
  total: number
  page: number
  pageSize: number
}>> {
  return withResult(async () => {
    await requireAdmin()

    const q = params.q?.trim()
    const status = params.status
    const page = Math.max(1, params.page ?? 1)
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

    return { users, total, page, pageSize }
  })
}

export async function adminUpdateUserStatus(userId: string, newStatus: 'active' | 'restricted' | 'suspended'): Promise<ActionResult<{ ok: boolean; status: string }>> {
  return withResult(async () => {
    const admin = await requireAdmin()

    if (userId === admin.id) throw new ActionError('BAD_REQUEST', 'Cannot change your own status.')

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } })
    if (!user) throw new ActionError('NOT_FOUND', 'User not found.')
    if (user.role === 'admin') throw new ActionError('BAD_REQUEST', 'Cannot modify admin accounts.')

    await prisma.user.update({ where: { id: userId }, data: { status: newStatus } })

    if (newStatus === 'suspended') {
      await prisma.session.deleteMany({ where: { userId } })
    }

    revalidatePath('/admin/users')
    return { ok: true, status: newStatus }
  })
}

export async function adminVerifyUser(userId: string): Promise<ActionResult<{ ok: boolean; expiresAt: string }>> {
  return withResult(async () => {
    const admin = await requireAdmin()

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!target) throw new ActionError('NOT_FOUND', 'User not found.')

    const now = new Date()
    const expiresAt = new Date(now)
    expiresAt.setFullYear(expiresAt.getFullYear() + 1)

    await prisma.user.update({
      where: { id: userId },
      data: { verificationStatus: 'verified', verifiedAt: now, verificationExpiresAt: expiresAt },
    })

    await prisma.verificationSubmission.updateMany({
      where: { userId },
      data: { status: 'approved', reviewedBy: admin.id, reviewedAt: now, expiresAt },
    }).catch(() => {})

    revalidatePath('/admin/users')
    revalidatePath('/admin/verifications')
    return { ok: true, expiresAt: expiresAt.toISOString() }
  })
}

export async function adminRevokeVerification(userId: string): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const admin = await requireAdmin()

    await prisma.user.update({
      where: { id: userId },
      data: { verificationStatus: 'unverified', verifiedAt: null, verificationExpiresAt: null },
    })

    await prisma.verificationSubmission.updateMany({
      where: { userId },
      data: { status: 'rejected', reviewedBy: admin.id, reviewedAt: new Date(), reviewNote: 'Verification revoked by admin.' },
    }).catch(() => {})

    revalidatePath('/admin/users')
    return { ok: true }
  })
}

// ─── Verification Review ──────────────────────────────────────

export async function adminListVerifications(params: {
  status?: string
  q?: string
}): Promise<ActionResult<{ submissions: unknown[] }>> {
  return withResult(async () => {
    await requireAdmin()

    const status = params.status || 'pending'
    const q = params.q?.trim()

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

    return { submissions }
  })
}

export async function adminApproveVerification(submissionId: string, expiresAt?: string): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const admin = await requireAdmin()

    const submission = await prisma.verificationSubmission.findUnique({
      where: { id: submissionId }, select: { userId: true },
    })
    if (!submission) throw new ActionError('NOT_FOUND', 'Submission not found.')

    const now = new Date()
    let expiry: Date
    if (expiresAt) {
      const parsed = new Date(expiresAt)
      if (isNaN(parsed.getTime())) throw new ActionError('BAD_REQUEST', 'Invalid expiry date.')
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

    revalidatePath('/admin/verifications')
    return { ok: true }
  })
}

export async function adminRejectVerification(submissionId: string, note?: string): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const admin = await requireAdmin()

    const submission = await prisma.verificationSubmission.findUnique({
      where: { id: submissionId }, select: { userId: true },
    })
    if (!submission) throw new ActionError('NOT_FOUND', 'Submission not found.')

    const now = new Date()

    await prisma.$transaction([
      prisma.verificationSubmission.update({
        where: { id: submissionId },
        data: { status: 'rejected', reviewedBy: admin.id, reviewedAt: now, reviewNote: note?.trim() || null },
      }),
      prisma.user.update({
        where: { id: submission.userId },
        data: { verificationStatus: 'unverified' },
      }),
    ])

    revalidatePath('/admin/verifications')
    return { ok: true }
  })
}

// ─── Report Management ────────────────────────────────────────

export async function adminListReports(status?: string): Promise<ActionResult<{ reports: unknown[]; pendingCount: number }>> {
  return withResult(async () => {
    await requireAdmin()

    const filterStatus = status || 'PENDING'

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

    return { reports, pendingCount }
  })
}

export async function adminResolveReport(
  reportId: string,
  action: 'warn' | 'delete' | 'suspend' | 'none',
  note?: string,
): Promise<ActionResult<{ ok: boolean; action: string }>> {
  return withResult(async () => {
    const admin = await requireAdmin()

    if (!['warn', 'delete', 'suspend', 'none'].includes(action)) {
      throw new ActionError('BAD_REQUEST', 'Invalid action.')
    }

    const report = await prisma.report.findUnique({
      where: { id: reportId },
      include: { post: { select: { id: true, authorId: true } } },
    })
    if (!report) throw new ActionError('NOT_FOUND', 'Report not found.')
    if (report.status !== 'PENDING') throw new ActionError('BAD_REQUEST', 'Report already handled.')

    if (action === 'delete' && report.postId) {
      // Soft-delete with full count maintenance (same as deletePost in posts.ts).
      // No .catch(() => {}) — a delete failure must abort the resolution.
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
      // Prevent suspending admin accounts (same guard as adminUpdateUserStatus)
      const target = await prisma.user.findUnique({
        where: { id: report.reportedUserId },
        select: { role: true },
      })
      if (target?.role === 'admin') {
        throw new ActionError('BAD_REQUEST', 'Cannot suspend admin accounts.')
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

    revalidatePath('/admin/reports')
    return { ok: true, action }
  })
}

export async function adminDismissReport(reportId: string): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const admin = await requireAdmin()

    const report = await prisma.report.findUnique({ where: { id: reportId }, select: { id: true, status: true } })
    if (!report) throw new ActionError('NOT_FOUND', 'Report not found.')
    if (report.status !== 'PENDING') throw new ActionError('BAD_REQUEST', 'Report already handled.')

    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: 'DISMISSED',
        handledBy: admin.id,
        handledAt: new Date(),
      },
    })

    revalidatePath('/admin/reports')
    return { ok: true }
  })
}
