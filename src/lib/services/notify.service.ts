/**
 * Notification service — first-page prefetch, badge counts.
 * Shared by Server Components (SSR) and Server Actions.
 */

import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { isCanonicalTimestamp } from '@/lib/pagination'
import { userSelect, serializeUser } from '@/lib/serialize'
import type { SafeNotification } from '@/lib/types'

const PAGE_SIZE = 30

/** Raised by `getNotificationsPage` for a cursor this service could never
 *  have emitted. Callers map it to a standard 400 — it must never reach
 *  Prisma (where an unvalidated cursor becomes `new Date("Invalid Date")`
 *  → 500). */
export class InvalidNotificationCursorError extends Error {
  constructor() {
    super('Invalid cursor.')
    this.name = 'InvalidNotificationCursorError'
  }
}

/** Cursor shape this service emits: `<canonical ISO ms>|<id>` (see
 *  getNotificationsFirstPage). Anything else is client garbage. */
export function validateNotificationCursor(cursor: string): { createdAt: Date; id: string } {
  const parts = cursor.split('|')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidNotificationCursorError()
  }
  if (!isCanonicalTimestamp(parts[0])) {
    throw new InvalidNotificationCursorError()
  }
  return { createdAt: new Date(parts[0]), id: parts[1] }
}

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
    // Validate BEFORE the query: same canonical keyset contract as the
    // timeline cursors. An unparseable cursor must surface as a 400 from
    // the caller, never as a Prisma Invalid-Date 500.
    const parsed = validateNotificationCursor(cursor)
    cursorWhere = {
      OR: [
        { createdAt: { lt: parsed.createdAt } },
        { createdAt: parsed.createdAt, id: { lt: parsed.id } },
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
