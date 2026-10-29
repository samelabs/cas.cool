/**
 * Core post write steps — the product-independent half of every post
 * mutation. Each helper is a transaction step: it receives the caller's
 * transaction client and moves the generic counters (replyCount, user
 * postCount) that belong to the post lifecycle itself. Product metadata
 * (e.g. chemical tags) is composed around these steps by the application
 * use cases in `post-write.service.ts` — in the SAME transaction.
 *
 * This module must stay free of chemical-product imports (pinned by
 * tests/module-boundary.test.ts).
 */

import type { Prisma } from '@prisma/client'
import { postInclude } from '@/lib/serialize'
import { generateShortCode } from '@/lib/shortCode'

type PostTx = Prisma.TransactionClient

export async function createCorePost(
  tx: PostTx,
  input: {
    authorId: string
    parentId: string | null
    conversationId: string | null
    quotePostId: string | null
    content: string
    images: string[]
  },
) {
  const post = await tx.post.create({
    data: { ...input, shortCode: generateShortCode() },
    include: postInclude(input.authorId),
  })
  if (input.parentId) {
    await tx.post.update({ where: { id: input.parentId }, data: { replyCount: { increment: 1 } } })
  }
  await tx.user.update({ where: { id: input.authorId }, data: { postCount: { increment: 1 } } })
  return post
}

export async function editCorePost(
  tx: PostTx,
  input: { id: string; actorId: string; content: string; images: string[] },
) {
  return tx.post.update({
    where: { id: input.id, authorId: input.actorId, deletedAt: null },
    data: { content: input.content, images: input.images, editedAt: new Date() },
    include: postInclude(input.actorId),
  })
}

/**
 * Soft-delete a live post (tombstone + wiped content) and move the generic
 * counters. Guarded by `deletedAt: null`, so a second delete inside the
 * same window is a no-op that reports false — the idempotency base for
 * author delete AND moderation delete. Product associations (chemical
 * tags) are cleared by the caller's composition on the same true result.
 */
export async function softDeleteCorePost(
  tx: PostTx,
  post: { id: string; authorId: string; parentId: string | null },
): Promise<{ deleted: boolean; images: string[] }> {
  // Lock the post row in canonical order (after repost claim) and capture
  // the live images array before applying the tombstone.
  const rows = await tx.$queryRaw<{ id: string; images: string[] }[]>`
    SELECT id, images FROM "Post"
    WHERE id = ${post.id} AND "deletedAt" IS NULL
    FOR UPDATE`
  if (!rows || rows.length === 0) {
    return { deleted: false, images: [] }
  }
  const images = rows[0].images || []

  await tx.post.update({
    where: { id: post.id },
    data: { deletedAt: new Date(), content: '', images: [] },
  })
  if (post.parentId) {
    await tx.post.update({ where: { id: post.parentId }, data: { replyCount: { decrement: 1 } } })
  }
  await tx.user.update({ where: { id: post.authorId }, data: { postCount: { decrement: 1 } } })
  return { deleted: true, images }
}
