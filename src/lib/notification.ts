import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import type { NotificationType } from '@prisma/client'

/**
 * Throwing delivery primitive used by the side-effect outbox: unlike
 * `upsertNotification` below, errors propagate so the executor can record
 * the failure as a retryable pending task.
 *
 * Dedup key by type:
 *   eventKey (outbox events)                    → eventKey (covers postId = NULL)
 *   LIKE / COMMENT / REPOST / REPORT_RESOLVED   → (userId, fromId, type, postId)
 *   FOLLOW / MESSAGE                            → (userId, fromId, type)
 *
 * PostId-based types use an atomic DB-level upsert (INSERT ... ON CONFLICT DO UPDATE)
 * via the @@unique([userId, fromId, type, postId]) constraint — immune to race conditions.
 * Null-postId types (FOLLOW, MESSAGE, user-only REPORT_RESOLVED) fall back to
 * application-level findFirst+create; these are protected by upstream unique constraints
 * (Follow @@unique, Conversation dedup) so concurrent duplicates are extremely unlikely.
 *
 * On match: bumps `createdAt` to now + sets `read: false` (re-surfaces).
 * On no match: creates a new row. Retries are safe (upsert semantics).
 */
export async function deliverNotification(params: {
  userId: string
  fromId: string
  type: NotificationType
  postId?: string | null
  /** Persistent event idempotency key — at-least-once execution collapses
   *  to one row per event, including postId-NULL events. */
  eventKey?: string | null
}): Promise<void> {
  const { userId, fromId, type, postId = null, eventKey = null } = params

  if (eventKey) {
    // Event semantics (documented contract):
    //  - The DELIVERY RECORD (NotificationDelivery, keyed by eventKey) is
    //    the idempotency authority. It is inserted once and never updated
    //    or overwritten by later events, so a retry of an OLD event after
    //    a NEWER one delivered is a pure no-op — it cannot change the
    //    visible row's eventKey, read, or createdAt.
    //  - A GENUINE new event updates the visible notification: fresh
    //    (userId, fromId, type, postId) tuples insert one row; an existing
    //    tuple is re-surfaced once (read=false, createdAt=now) WITHOUT
    //    touching the row's original eventKey stamp.
    //  - Both writes commit in the SAME transaction: the record exists if
    //    and only if the visible change is durably accounted for.
    await prisma.$transaction(async (tx) => {
      const delivered = await tx.$queryRaw<{ eventKey: string }[]>`
        INSERT INTO "NotificationDelivery" ("eventKey")
        VALUES (${eventKey})
        ON CONFLICT ("eventKey") DO NOTHING
        RETURNING "eventKey"`
      if (delivered.length === 0) return // already delivered: pure no-op

      // Compound unique applies to non-NULL postId only; NULL-postId events
      // always insert their own row (PostgreSQL treats NULLs as distinct).
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "Notification" ("id", "userId", "fromId", "type", "postId", "eventKey")
        VALUES (${randomUUID()}, ${userId}, ${fromId}, ${type}::"NotificationType", ${postId}, ${eventKey})
        ON CONFLICT ("userId", "fromId", "type", "postId") DO UPDATE
          SET read = false, "createdAt" = now()
        RETURNING "id"`

      await tx.$queryRaw`
        UPDATE "NotificationDelivery" SET "notificationId" = ${row.id}
        WHERE "eventKey" = ${eventKey}`
    })
    return
  }

  if (postId) {
    // Atomic upsert via compound unique constraint — race-safe.
    await prisma.notification.upsert({
      where: { userId_fromId_type_postId: { userId, fromId, type, postId } },
      update: { read: false, createdAt: new Date() },
      create: { userId, fromId, type, postId },
    })
  } else {
    // Null-postId types: PostgreSQL treats NULL as distinct in unique constraints,
    // so the compound @@unique can't dedup these. Application-level findFirst+create
    // is sufficient — upstream actions (Follow, Conversation) are already uniquely constrained.
    const existing = await prisma.notification.findFirst({
      where: { userId, fromId, type },
      select: { id: true },
    })

    if (existing) {
      await prisma.notification.update({
        where: { id: existing.id },
        data: { read: false, createdAt: new Date() },
      })
    } else {
      await prisma.notification.create({
        data: { userId, fromId, type, postId: null },
      })
    }
  }
}

/**
 * Fire-and-forget wrapper for direct call sites: identical dedup behavior,
 * errors logged and swallowed so it never blocks the caller.
 */
export async function upsertNotification(params: {
  userId: string
  fromId: string
  type: NotificationType
  postId?: string | null
}): Promise<void> {
  try {
    await deliverNotification(params)
  } catch (e) {
    console.error('Notification upsert error:', e)
  }
}
