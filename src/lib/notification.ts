import { prisma } from '@/lib/db'
import type { NotificationType } from '@prisma/client'

/**
 * Unified notification upsert — deduplicates before creating.
 *
 * Dedup key by type:
 *   LIKE / COMMENT / REPOST / MENTION / REPORT_RESOLVED → (userId, fromId, type, postId)
 *   FOLLOW / MESSAGE                                      → (userId, fromId, type)
 *
 * PostId-based types use an atomic DB-level upsert (INSERT ... ON CONFLICT DO UPDATE)
 * via the @@unique([userId, fromId, type, postId]) constraint — immune to race conditions.
 * Null-postId types (FOLLOW, MESSAGE, user-only REPORT_RESOLVED) fall back to
 * application-level findFirst+create; these are protected by upstream unique constraints
 * (Follow @@unique, Conversation dedup) so concurrent duplicates are extremely unlikely.
 *
 * On match: bumps `createdAt` to now + sets `read: false` (re-surfaces).
 * On no match: creates a new row.
 *
 * Always fire-and-forget (errors logged, never blocking the caller).
 */
export async function upsertNotification(params: {
  userId: string
  fromId: string
  type: NotificationType
  postId?: string | null
}): Promise<void> {
  const { userId, fromId, type, postId = null } = params

  try {
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
  } catch (e) {
    console.error('Notification upsert error:', e)
  }
}
