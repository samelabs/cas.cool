/**
 * Recipient-side notification policy — the single definition point for
 * visible-notification surfacing rules. No route or service may hand-roll
 * its own cooldown; deliverNotification is the only enforcement site.
 *
 * Three distinct constraints (do not conflate):
 *   1. Event idempotency      → NotificationDelivery eventKey (schema layer).
 *   2. Visible-notification
 *      dedup                  → partial unique index on (userId, fromId,
 *                              type) WHERE postId IS NULL + compound unique
 *                              for postId tuples (schema layer).
 *   3. Anti-harassment        → THIS module: a genuine new event for a
 *                              tuple that was surfaced recently does not
 *                              re-disturb the recipient.
 *
 * Anti-harassment rule (NEW PRODUCT RULE — declared in the 1.2.0 closure
 * report, not pre-existing behavior):
 *   Toggle-type events (LIKE, REPOST, FOLLOW) re-surface an existing visible
 *   notification only if its last surfacing is older than
 *   NOTIFICATION_COOLDOWN_MS. Repeated like/unlike or follow/unfollow
 *   cycling is a harassment vector; within the window the event is still
 *   durably recorded (delivery row) but the recipient is not re-pinged.
 *   Content events (COMMENT, MESSAGE, REPORT_RESOLVED) are genuine new
 *   content and always re-surface — chat and replies must stay live.
 *
 * Scope: per (recipient, actor, type) tuple, plus postId for post-scoped
 * types (the visible-notification row is the aggregation unit). The check
 * reads the row's own createdAt in the same UPSERT statement — database
 * state, not process memory, so it holds across REST/MCP credentials,
 * processes and restarts.
 */

import type { NotificationType } from '@prisma/client'

/** How long after a surfacing the same tuple stays silent for toggle types.
 *  60 min: short enough that a genuine re-engagement later the same day
 *  notifies again, long enough to make toggle-cycling useless as a ping. */
export const NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000

const COOLDOWN_TYPES: ReadonlySet<NotificationType> = new Set(['LIKE', 'REPOST', 'FOLLOW'])

/** Cooldown in whole seconds for the UPSERT guard; 0 = always re-surface. */
export function cooldownSecondsFor(type: NotificationType): number {
  return COOLDOWN_TYPES.has(type) ? Math.round(NOTIFICATION_COOLDOWN_MS / 1000) : 0
}
