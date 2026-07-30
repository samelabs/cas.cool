/**
 * Notification service — first-page prefetch, badge counts.
 * Shared by Server Components (SSR) and Server Actions.
 */

import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { userSelect, serializeUser } from '@/lib/serialize'
import type { SafeNotification } from '@/lib/types'

const PAGE_SIZE = 30

export interface NotificationPage {
  notifications: SafeNotification[]
  nextCursor: string | null
}

/**
 * Fetch first page of notifications for SSR.
 * Captures original read/unread state BEFORE marking as read.
 * Also performs cleanup: deletes read notifications older than 30 days.
 */
export async function getNotificationsFirstPage(
  userId: string,
): Promise<NotificationPage> {
  // 1. Fetch first page (captures original read/unread state)
  const rows = await prisma.notification.findMany({
    where: { userId },
    include: { from: { select: userSelect } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE,
  })

  // 2. Mark as read (silent)
  const hasUnread = rows.some((n) => !n.read)
  if (hasUnread) {
    await prisma.notification
      .updateMany({ where: { userId, read: false }, data: { read: true } })
      .catch(() => {})
  }

  // 3. Cleanup: delete read notifications older than 30 days
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  await prisma.notification
    .deleteMany({ where: { userId, read: true, createdAt: { lt: cutoff } } })
    .catch(() => {})

  // Batch-lookup shortCodes for posts referenced in notifications
  const postIds = rows.map((n) => n.postId).filter((id): id is string => !!id)
  const shortCodeMap = new Map<string, string>()
  if (postIds.length > 0) {
    const posts = await prisma.post.findMany({
      where: { id: { in: postIds } },
      select: { id: true, shortCode: true },
    })
    for (const p of posts) {
      if (p.shortCode) shortCodeMap.set(p.id, p.shortCode)
    }
  }

  const notifications = rows.map((n) => ({
    id: n.id,
    type: n.type,
    from: serializeUser(n.from),
    postId: n.postId,
    postShortCode: n.postId ? shortCodeMap.get(n.postId) ?? null : null,
    read: n.read,
    createdAt: n.createdAt,
  })) satisfies SafeNotification[]

  const nextCursor =
    rows.length >= PAGE_SIZE && rows.length > 0
      ? `${rows[rows.length - 1].createdAt.toISOString()}|${rows[rows.length - 1].id}`
      : null

  return { notifications, nextCursor }
}

/**
 * Paginated notification fetch (for client-side infinite scroll via Server Actions).
 */
export async function getNotificationsPage(
  userId: string,
  cursor?: string,
): Promise<NotificationPage> {
  let cursorWhere: Prisma.NotificationWhereInput | undefined
  if (cursor) {
    const [iso, id] = cursor.split('|')
    const cursorDate = new Date(iso)
    cursorWhere = {
      OR: [
        { createdAt: { lt: cursorDate } },
        { createdAt: cursorDate, id: { lt: id } },
      ],
    }
  }

  const rows = await prisma.notification.findMany({
    where: { userId, ...(cursorWhere ?? {}) },
    include: { from: { select: userSelect } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE,
  })

  const postIds = rows.map((n) => n.postId).filter((id): id is string => !!id)
  const shortCodeMap = new Map<string, string>()
  if (postIds.length > 0) {
    const posts = await prisma.post.findMany({
      where: { id: { in: postIds } },
      select: { id: true, shortCode: true },
    })
    for (const p of posts) {
      if (p.shortCode) shortCodeMap.set(p.id, p.shortCode)
    }
  }

  const notifications = rows.map((n) => ({
    id: n.id,
    type: n.type,
    from: serializeUser(n.from),
    postId: n.postId,
    postShortCode: n.postId ? shortCodeMap.get(n.postId) ?? null : null,
    read: n.read,
    createdAt: n.createdAt,
  })) satisfies SafeNotification[]

  const nextCursor =
    rows.length >= PAGE_SIZE && rows.length > 0
      ? `${rows[rows.length - 1].createdAt.toISOString()}|${rows[rows.length - 1].id}`
      : null

  return { notifications, nextCursor }
}

/**
 * Unread badge count for layout/sidebar.
 */
export async function getUnreadNotificationCount(userId: string): Promise<number> {
  try {
    return await prisma.notification.count({ where: { userId, read: false } })
  } catch {
    return 0
  }
}
