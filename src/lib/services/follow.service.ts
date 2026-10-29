/**
 * Shared follow service. Single source of truth for follow transactions,
 * counter maintenance, and follow notifications across REST and MCP.
 */

import { prisma } from '@/lib/db'
import { upsertNotification } from '@/lib/notification'
import type { Prisma } from '@prisma/client'
import type { ServiceResult } from '@/lib/services/post-core.service'

function err(status: number, code: string, message: string) {
  return { status, code, message }
}

/**
 * Lock BOTH user rows in one canonical order (ascending id) before any
 * relation or counter write. Opposite-direction operations (A→B while
 * B→A, follow while unfollow) previously updated the actor row first,
 * forming an AB-BA cycle on the User rows (P2034 deadlocks).
 *
 * Lock strength: FOR NO KEY UPDATE — exactly what the counter UPDATEs
 * take. It serializes concurrent counter writes on the same pair without
 * blocking the FOR KEY SHARE locks that unrelated inserts (posts,
 * messages, …) take on these users via their foreign keys. Because every
 * transaction locks the same pair in the same ascending order, no cycle
 * can form between any combination of follow/unfollow operations.
 */
async function lockUserPair(tx: Prisma.TransactionClient, a: string, b: string): Promise<void> {
  const [first, second] = [a, b].sort()
  await tx.$queryRaw`SELECT id FROM "User" WHERE id IN (${first}, ${second}) ORDER BY id FOR NO KEY UPDATE`
}

export async function setUserFollow(
  actor: { id: string },
  targetUsername: string,
  follow: boolean,
): Promise<ServiceResult<{ following: boolean }>> {
  const target = await prisma.user.findUnique({
    where: { username: targetUsername.toLowerCase() },
    select: { id: true, username: true },
  })
  if (!target) return { ok: false, error: err(404, 'not_found', 'User not found.') }
  if (target.id === actor.id) {
    return { ok: false, error: err(400, 'bad_request', follow ? 'Cannot follow yourself.' : 'Cannot unfollow yourself.') }
  }

  if (follow) {
    // Idempotent follow: if already following, treat as success without double increment.
    try {
      await prisma.$transaction(async (tx) => {
        await lockUserPair(tx, actor.id, target.id)
        await tx.follow.create({ data: { followerId: actor.id, followingId: target.id } })
        await tx.user.update({ where: { id: actor.id }, data: { followingCount: { increment: 1 } } })
        await tx.user.update({ where: { id: target.id }, data: { followerCount: { increment: 1 } } })
      })
    } catch (e: unknown) {
      if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) {
        throw e
      }
    }
    // Notification stays OUTSIDE the transaction (and outside the
    // idempotency catch): it must neither block on nor roll back the pair.
    await upsertNotification({ userId: target.id, fromId: actor.id, type: 'FOLLOW' })
    return { ok: true, data: { following: true } }
  } else {
    // Idempotent unfollow: deleteMany with count guard prevents counter underflow.
    const existing = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: actor.id, followingId: target.id } },
    })
    if (!existing) {
      return { ok: true, data: { following: false } }
    }

    await prisma.$transaction(async (tx) => {
      await lockUserPair(tx, actor.id, target.id)
      const deleted = await tx.follow.deleteMany({
        where: { followerId: actor.id, followingId: target.id },
      })
      if (deleted.count > 0) {
        await tx.user.update({ where: { id: actor.id }, data: { followingCount: { decrement: 1 } } })
        await tx.user.update({ where: { id: target.id }, data: { followerCount: { decrement: 1 } } })
      }
    })
    return { ok: true, data: { following: false } }
  }
}
