import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { NotificationType } from '@prisma/client'
import { cooldownSecondsFor } from '@/lib/notification-policy'

/**
 * Throwing delivery primitive used by the side-effect outbox: errors
 * propagate so the executor can record the failure as a retryable pending
 * task.
 *
 * Visible-notification invariant: at most ONE row per
 *   (userId, fromId, type, postId)         — compound unique constraint
 *   (userId, fromId, type) postId IS NULL  — partial unique index
 *                                            Notification_null_post_dedup_key
 *                                            (PostgreSQL treats NULL as
 *                                            distinct in a plain compound
 *                                            unique, so it cannot arbitrate
 *                                            these rows)
 * Every write is an atomic INSERT ... ON CONFLICT DO UPDATE; there is no
 * application-level findFirst+create anywhere (the old read-then-insert
 * window duplicated rows under concurrency).
 *
 * On a genuine new event: re-surface (read=false, createdAt=now(),
 * revision+1) — guarded by the recipient-side cooldown policy for toggle
 * types (notification-policy.ts). The guard lives in the same UPSERT
 * statement, so check and write are atomic and database-backed.
 *
 * Event idempotency: with an eventKey, the immutable NotificationDelivery
 * record is the authority. A retry of an OLD event after a NEWER one is a
 * pure no-op — it cannot touch the visible row's read/createdAt/revision.
 * When a cooldown suppresses the re-surface, the event is still recorded as
 * delivered (the recipient chose silence; a later retry must not re-ping).
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
  const cooldownSeconds = cooldownSecondsFor(type)
  const replyPostId = type === 'COMMENT' && eventKey?.startsWith('reply:')
    ? eventKey.slice('reply:'.length)
    : null

  // Re-surface guard, evaluated against the EXISTING row on conflict:
  // cooldown types stay silent while the tuple was surfaced within the
  // window; content types (cooldownSeconds = 0) always re-surface.
  // cooldownSeconds is a server-side policy constant — parameter-bound.
  const guard = Prisma.sql`
    WHERE ${cooldownSeconds}::double precision = 0
       OR "Notification"."createdAt" < now() - make_interval(secs => ${cooldownSeconds})`
  // Fixed arbiter literals chosen server-side from known postId state.
  const arbiter = postId
    ? Prisma.raw(`("userId", "fromId", "type", "postId")`)
    : Prisma.raw(`("userId", "fromId", "type") WHERE "postId" IS NULL`)
  const statement = Prisma.sql`
    INSERT INTO "Notification" ("id", "userId", "fromId", "type", "postId", "eventKey", "replyPostId")
    VALUES (${randomUUID()}, ${userId}, ${fromId}, ${type}::"NotificationType", ${postId}, ${eventKey}, ${replyPostId})
    ON CONFLICT ${arbiter} DO UPDATE
      SET "read" = false, "createdAt" = now(), "revision" = "Notification"."revision" + 1,
          "replyPostId" = EXCLUDED."replyPostId"
    ${guard}
    RETURNING "id"`

  if (eventKey) {
    // Event semantics (documented contract):
    //  - The DELIVERY RECORD (NotificationDelivery, keyed by eventKey) is
    //    the idempotency authority. It is inserted once and never updated
    //    or overwritten by later events, so a retry of an OLD event after
    //    a NEWER one delivered is a pure no-op — it cannot change the
    //    visible row's eventKey, read, or createdAt.
    //  - A GENUINE new event re-surfaces the visible notification via the
    //    matching unique arbiter WITHOUT touching the row's original
    //    eventKey stamp.
    //  - Both writes commit in the SAME transaction: the record exists if
    //    and only if the visible change is durably accounted for.
    await prisma.$transaction(async (tx) => {
      const delivered = await tx.$queryRaw<{ eventKey: string }[]>`
        INSERT INTO "NotificationDelivery" ("eventKey")
        VALUES (${eventKey})
        ON CONFLICT ("eventKey") DO NOTHING
        RETURNING "eventKey"`
      if (delivered.length === 0) return // already delivered: pure no-op

      const [row] = await tx.$queryRaw<{ id: string }[]>(statement)
      if (!row) {
        // Cooldown suppressed the re-surface: the event is durably recorded
        // as delivered above; the visible row keeps its state untouched.
        return
      }

      await tx.$queryRaw`
        UPDATE "NotificationDelivery" SET "notificationId" = ${row.id}
        WHERE "eventKey" = ${eventKey}`
    })
    return
  }

  // Direct path (tests and outbox executors without a pre-existing event):
  // identical upsert, identical guard, no delivery record.
  await prisma.$queryRaw(statement)
}
