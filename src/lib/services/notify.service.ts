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


/** COMMENT notifications carry the current triggering reply in replyPostId.
 *  Batch-resolve their shortCodes so recipients (web +
 *  agents) can open the actual new reply, not just the parent post. */
async function replyShortCodeMap(rows: { type: string; replyPostId: string | null }[]): Promise<Map<string, string>> {
  const replyIds = rows
    .filter((n) => n.type === 'COMMENT' && n.replyPostId)
    .map((n) => n.replyPostId!)
  const map = new Map<string, string>()
  if (replyIds.length === 0) return map
  const replies = await prisma.post.findMany({
    where: { id: { in: replyIds } },
    select: { id: true, shortCode: true },
  })
  for (const r of replies) if (r.shortCode) map.set(r.id, r.shortCode)
  return map
}

export interface NotificationPage {
  notifications: SafeNotification[]
  nextCursor: string | null
  /** Server-confirmed unread count AFTER this page's scoped read-marking.
   *  The badge converges to this value — never to "everything read". */
  unreadRemaining: number
}

/**
 * Fetch first page of notifications for SSR.
 * Captures original read/unread state BEFORE marking as read.
 * Also performs cleanup: deletes read notifications older than 30 days.
 *
 * Read-confirmation scope (F05 contract): only the rows this page actually
 * RETURNED, and only at the revision they were read at. A row re-activated
 * by a genuine new event between the SELECT and the UPDATE bumps its
 * revision, so the stale confirmation misses it and it stays unread. Rows
 * arriving after the SELECT were never returned and are never touched.
 */
export async function getNotificationsFirstPage(
  userId: string,
): Promise<NotificationPage> {
  // 1. Fetch first page (captures original read/unread state + revision)
  const rows = await prisma.notification.findMany({
    where: { userId },
    include: { from: { select: userSelect } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE,
  })

  // 2. Mark as read (silent) — ONLY the returned rows, guarded by the
  //    revision each row had when we read it.
  const unreadRows = rows.filter((n) => !n.read)
  if (unreadRows.length > 0) {
    await prisma.notification
      .updateMany({
        where: {
          OR: unreadRows.map((n) => ({ id: n.id, read: false, revision: n.revision })),
        },
        data: { read: true },
      })
      .catch(() => {})
  }

  // 3. Cleanup: delete read notifications older than 30 days
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  await prisma.notification
    .deleteMany({ where: { userId, read: true, createdAt: { lt: cutoff } } })
    .catch(() => {})

  // 4. Server-confirmed unread state after the scoped marking.
  const unreadRemaining = await prisma.notification
    .count({ where: { userId, read: false } })
    .catch(() => 0)

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

  const replyMap = await replyShortCodeMap(rows)
  const notifications = rows.map((n) => ({
    id: n.id,
    type: n.type,
    from: serializeUser(n.from),
    postId: n.postId,
    postShortCode: n.postId ? shortCodeMap.get(n.postId) ?? null : null,
    read: n.read,
    createdAt: n.createdAt,
    revision: n.revision,
    replyShortCode: n.type === 'COMMENT' && n.replyPostId
      ? replyMap.get(n.replyPostId) ?? null
      : null,
  })) satisfies SafeNotification[]

  const nextCursor =
    rows.length >= PAGE_SIZE && rows.length > 0
      ? `${rows[rows.length - 1].createdAt.toISOString()}|${rows[rows.length - 1].id}`
      : null

  return { notifications, nextCursor, unreadRemaining }
}

/**
 * Paginated notification fetch (for client-side infinite scroll via Server Actions).
 * Read-only: paging through the backlog never confirms anything as read —
 * read state changes only through the SSR first page's scoped marking or the
 * explicit mark-all endpoint.
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

  const replyMap = await replyShortCodeMap(rows)
  const notifications = rows.map((n) => ({
    id: n.id,
    type: n.type,
    from: serializeUser(n.from),
    postId: n.postId,
    postShortCode: n.postId ? shortCodeMap.get(n.postId) ?? null : null,
    read: n.read,
    createdAt: n.createdAt,
    revision: n.revision,
    replyShortCode: n.type === 'COMMENT' && n.replyPostId
      ? replyMap.get(n.replyPostId) ?? null
      : null,
  })) satisfies SafeNotification[]

  const nextCursor =
    rows.length >= PAGE_SIZE && rows.length > 0
      ? `${rows[rows.length - 1].createdAt.toISOString()}|${rows[rows.length - 1].id}`
      : null

  const unreadRemaining = await prisma.notification
    .count({ where: { userId, read: false } })
    .catch(() => 0)

  return { notifications, nextCursor, unreadRemaining }
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
