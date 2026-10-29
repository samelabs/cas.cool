/**
 * Interaction service — like / bookmark / repost.
 *
 * Generic timeline behavior only: this module deliberately has NO chemical
 * product imports (pinned by tests/module-boundary.test.ts). Route handlers
 * keep HTTP concerns (parse, auth, rate limit, respond); everything here is
 * reusable domain behavior with the public API's error codes/messages.
 */

import { prisma } from '@/lib/db'
import { generateShortCode } from '@/lib/shortCode'
import { upsertNotification } from '@/lib/notification'
import { softDeleteCorePost } from '@/lib/services/post-core-write.service'
import type { PostActor, ServiceError, ServiceResult } from '@/lib/services/post-core.service'

export type InteractionAction = 'like' | 'bookmark' | 'repost'
export type InteractionState = { liked: boolean } | { bookmarked: boolean } | { reposted: boolean }

function err(status: number, code: string, message: string): ServiceError {
  return { status, code, message }
}

export async function setPostInteraction(
  actor: PostActor,
  shortCode: string,
  action: InteractionAction,
  active: boolean,
): Promise<ServiceResult<InteractionState>> {
  const post = await prisma.post.findFirst({
    where: { shortCode, deletedAt: null },
    select: { id: true, authorId: true },
  })
  if (!post) return { ok: false, error: err(404, 'not_found', 'Post not found.') }
  const postId = post.id
  const userId = actor.id

  if (active) {
    switch (action) {
      case 'like': {
        const existing = await prisma.like.findUnique({ where: { postId_userId: { postId, userId } } })
        if (!existing) {
          try {
            await prisma.$transaction([
              prisma.like.create({ data: { postId, userId } }),
              prisma.post.update({ where: { id: postId }, data: { likeCount: { increment: 1 } } }),
            ])
          } catch (e: unknown) {
            if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) throw e
          }
          if (post.authorId !== userId) {
            await upsertNotification({ userId: post.authorId, fromId: userId, type: 'LIKE', postId })
          }
        }
        return { ok: true, data: { liked: true } }
      }
      case 'bookmark': {
        const existing = await prisma.bookmark.findUnique({ where: { postId_userId: { postId, userId } } })
        if (!existing) {
          try {
            await prisma.$transaction([
              prisma.bookmark.create({ data: { postId, userId } }),
              prisma.post.update({ where: { id: postId }, data: { bookmarkCount: { increment: 1 } } }),
            ])
          } catch (e: unknown) {
            if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) throw e
          }
        }
        return { ok: true, data: { bookmarked: true } }
      }
      case 'repost': {
        // Dual record: Repost row AND an empty quote Post (X-style repost)
        const existing = await prisma.repost.findUnique({ where: { postId_userId: { postId, userId } } })
        if (!existing) {
          const shortCode = generateShortCode()
          try {
            await prisma.$transaction(async (tx) => {
              const repostPost = await tx.post.create({
                data: {
                  authorId: userId,
                  content: '',
                  quotePostId: postId,
                  images: [],
                  shortCode,
                },
              })
              await tx.repost.create({
                data: {
                  postId,
                  userId,
                  repostPostId: repostPost.id,
                },
              })
              await tx.post.update({ where: { id: postId }, data: { repostCount: { increment: 1 } } })
              await tx.user.update({ where: { id: userId }, data: { postCount: { increment: 1 } } })
            })
          } catch (e: unknown) {
            if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) throw e
          }
          if (post.authorId !== userId) {
            await upsertNotification({ userId: post.authorId, fromId: userId, type: 'REPOST', postId })
          }
        }
        return { ok: true, data: { reposted: true } }
      }
    }
  }

  switch (action) {
    case 'like': {
      await prisma.$transaction(async (tx) => {
        const deleted = await tx.like.deleteMany({ where: { postId, userId } })
        if (deleted.count > 0) {
          await tx.post.update({ where: { id: postId }, data: { likeCount: { decrement: deleted.count } } })
        }
      })
      return { ok: true, data: { liked: false } }
    }
    case 'bookmark': {
      await prisma.$transaction(async (tx) => {
        const deleted = await tx.bookmark.deleteMany({ where: { postId, userId } })
        if (deleted.count > 0) {
          await tx.post.update({ where: { id: postId }, data: { bookmarkCount: { decrement: deleted.count } } })
        }
      })
      return { ok: true, data: { bookmarked: false } }
    }
    case 'repost': {
      const existing = await prisma.repost.findUnique({
        where: { postId_userId: { postId, userId } },
        select: {
          id: true,
          repostPost: {
            select: { id: true, parentId: true, deletedAt: true },
          },
        },
      })
      if (existing) {
        await prisma.$transaction(async (tx) => {
          // Canonical lock order shared with post deletion
          // (post-write.service.ts softDeleteProductPost):
          // Repost row → generated post row → user row → original post row.
          // The claim is guarded by the row id read above: if a concurrent
          // cancel already removed this row (and a re-repost created a new
          // one), the claim misses and this transaction is a no-op — no
          // P2025, no double decrement, no lock-order deadlock.
          const claimed = await tx.repost.deleteMany({ where: { id: existing.id } })
          if (claimed.count === 0) return
          const repostPost = existing.repostPost
          if (repostPost && !repostPost.deletedAt) {
            // Unified soft-delete: preserves the post relationship tree (quotes, replies)
            // as an HTTP 200 tombstone. Never physically hard-deletes generated posts.
            // authorId: the generated post always belongs to the reposter (userId).
            await softDeleteCorePost(tx, { ...repostPost, authorId: userId })
          }
          await tx.post.update({ where: { id: postId }, data: { repostCount: { decrement: 1 } } })
        })
      }
      return { ok: true, data: { reposted: false } }
    }
  }
}
