/**
 * Post write use cases — create / edit / soft-delete for cas.cool.
 *
 * Application composition layer: every operation runs ONE database
 * transaction that combines the generic post lifecycle steps
 * (`post-core-write.service.ts`: row + replyCount + user postCount) with
 * the chemical product rules (`@/lib/chemistry/post-chemicals`: relation
 * swap + Chemical.postCount). `deletePost` (author/admin) and
 * `deleteReportedPost` (moderation via reports) share the exact same
 * delete transaction — there is no second counting implementation.
 *
 * Route handlers keep HTTP concerns; error codes/messages are part of the
 * public API contract (docs/API-BASELINE.md).
 */

import { prisma } from '@/lib/db'
import { serializePost } from '@/lib/serialize'
import { maxPostLength } from '@/lib/permissions'
import { upsertNotification } from '@/lib/notification'
import { revalidateTrending } from '@/lib/services/user.service'
import { deleteUnreferencedUploads } from '@/lib/upload-cleanup'
import {
  attachInitialPostChemicals,
  filterEditCas,
  postCasNumbers,
  replacePostChemicals,
  resolvePostChemicals,
} from '@/lib/chemistry/post-chemicals'
import { attachPostChemical } from '@/lib/chemistry/post-views'
import {
  createCorePost,
  editCorePost,
  softDeleteCorePost,
} from '@/lib/services/post-core-write.service'
import type { PostActor, ServiceError, ServiceResult } from '@/lib/services/post.service'
import type { SafePost } from '@/lib/types'

const MAX_IMAGES = 4
const EDIT_WINDOW_MS = 60 * 60 * 1000

function err(status: number, code: string, message: string): ServiceError {
  return { status, code, message }
}

// ── Create (post / reply / quote) ─────────────────────────────

export interface CreatePostInput {
  /** Trimmed content from the route's body narrowing. */
  content: string
  parentId: string | null
  quotePostId: string | null
  /** Already-filtered /uploads/ URLs (route narrows raw body values). */
  images: string[]
  /** Raw casNumbers body value: array, comma string, or absent. */
  casNumbers: string[] | string | null
}

export async function createPost(
  actor: PostActor,
  input: CreatePostInput,
): Promise<ServiceResult<SafePost>> {
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  const { parentId, quotePostId } = input
  const images = (input.images || []).slice(0, MAX_IMAGES)

  if (!content && images.length === 0 && !quotePostId) {
    return { ok: false, error: err(400, 'bad_request', 'Content is required.') }
  }
  if (!content && quotePostId) {
    return { ok: false, error: err(400, 'bad_request', 'Quote posts require text.') }
  }

  const limit = maxPostLength(actor)
  if (content.length > limit) {
    return { ok: false, error: err(400, 'bad_request', `Content too long (max ${limit} characters).`) }
  }

  // Parent + conversation resolution
  let conversationId: string | null = null
  let parentAuthorId: string | null = null
  if (parentId) {
    const parent = await prisma.post.findFirst({
      where: { id: parentId, deletedAt: null },
      select: { id: true, conversationId: true, authorId: true },
    })
    if (!parent) return { ok: false, error: err(404, 'not_found', 'Parent post not found.') }
    conversationId = parent.conversationId ?? parent.id
    parentAuthorId = parent.authorId
  }

  // Quote validation
  let quotedAuthorId: string | null = null
  if (quotePostId) {
    const quoted = await prisma.post.findFirst({
      where: { id: quotePostId, deletedAt: null },
      select: { authorId: true },
    })
    if (!quoted) return { ok: false, error: err(404, 'not_found', 'Quoted post not found.') }
    quotedAuthorId = quoted.authorId
  }

  // Chemical associations are the product layer's concern: the chemistry
  // module merges manual + auto-extracted CAS numbers; the transaction
  // below wires the relation and maintains Chemical.postCounts.
  const allCas = resolvePostChemicals({ content, casNumbers: input.casNumbers })

  const post = await prisma.$transaction(async (tx) => {
    const created = await createCorePost(tx, {
      authorId: actor.id,
      parentId,
      conversationId,
      quotePostId,
      content,
      images,
    })
    await attachInitialPostChemicals(tx, created.id, allCas)
    // Assemble the API result before commit. If the product projection fails,
    // the write rolls back instead of returning 500 after a successful post.
    return attachPostChemical(serializePost(created), tx)
  })

  // Post-commit side effects (best-effort, outside the transaction)
  revalidateTrending()
  if (parentAuthorId && parentAuthorId !== actor.id) {
    await upsertNotification({ userId: parentAuthorId, fromId: actor.id, type: 'COMMENT', postId: parentId })
  }
  if (quotedAuthorId && quotedAuthorId !== actor.id) {
    await upsertNotification({ userId: quotedAuthorId, fromId: actor.id, type: 'REPOST', postId: post.id })
  }

  return { ok: true, data: post }
}

// ── Edit (author, 60-minute window) ───────────────────────────

export interface EditPostInput {
  content: string
  /**
   * undefined = preserve existing post images.
   * [] = remove all images.
   * [url, ...] = replace with new array (max 4).
   */
  images?: string[]
  /** null = leave chemical associations untouched. */
  casNumbers: string[] | null
}

export async function editPost(
  actor: PostActor,
  shortCode: string,
  input: EditPostInput,
): Promise<ServiceResult<SafePost>> {
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  const casNumbers = input.casNumbers

  const limit = maxPostLength(actor)

  const updated = await prisma.$transaction(async (tx) => {
    // Serialize edit validation and image/CAS snapshots with every writer
    // of this post. A waiting edit must see a delete's tombstone, the most
    // recent images and the edit-window clock AFTER it acquires the lock.
    await tx.$queryRaw`SELECT id FROM "Post" WHERE "shortCode" = ${shortCode} FOR UPDATE`
    const post = await tx.post.findFirst({
      where: { shortCode, deletedAt: null },
      select: { id: true, authorId: true, createdAt: true, images: true },
    })
    if (!post) return { ok: false as const, error: err(404, 'not_found', 'Post not found.') }
    if (post.authorId !== actor.id) {
      return { ok: false as const, error: err(403, 'forbidden', 'You can only edit your own posts.') }
    }
    if (Date.now() - post.createdAt.getTime() > EDIT_WINDOW_MS) {
      return { ok: false as const, error: err(403, 'forbidden', 'Edit window has expired.') }
    }
    const linkedRepost = await tx.repost.findUnique({
      where: { repostPostId: post.id },
      select: { id: true },
    })
    if (linkedRepost) {
      return { ok: false as const, error: err(400, 'bad_request', 'Pure reposts cannot be edited.') }
    }

    // Determine keepImages:
    // - If input.images is undefined: preserve post.images!
    // - If input.images is provided: slice up to MAX_IMAGES.
    const keepImages = input.images !== undefined
      ? input.images.slice(0, MAX_IMAGES)
      : post.images

    if (!content && keepImages.length === 0) {
      return { ok: false as const, error: err(400, 'bad_request', 'Content is required.') }
    }
    if (content.length > limit) {
      return { ok: false as const, error: err(400, 'bad_request', `Content too long (max ${limit} characters).`) }
    }

    const removedImages = post.images.filter((url) => !keepImages.includes(url))
    const result = await editCorePost(tx, { id: post.id, actorId: actor.id, content, images: keepImages })

    if (casNumbers) {
      // Edit keeps the historical no-trim filter; replacePostChemicals
      // swaps the relation and moves Chemical.postCounts in one place.
      const validCas = filterEditCas(casNumbers)
      await replacePostChemicals(tx, {
        postId: post.id,
        current: await postCasNumbers(tx, post.id),
        next: validCas,
      })
    }

    // Read the final tag set inside the transaction for the same reason as
    // create: the client must not see a failed response for a committed edit.
    return { ok: true as const, data: await attachPostChemical(serializePost(result), tx), removedImages }
  })
  if (!updated.ok) return updated

  // Best-effort cleanup of images this edit removed (only files that no
  // other row still references).
  await deleteUnreferencedUploads(updated.removedImages)
  revalidateTrending()

  return { ok: true, data: updated.data }
}

// ── Soft delete (author / admin / moderation — one implementation) ──

export async function deletePost(actor: PostActor, shortCode: string): Promise<ServiceResult<true>> {
  const post = await prisma.post.findFirst({
    where: { shortCode, deletedAt: null },
    select: { id: true, authorId: true, parentId: true },
  })
  if (!post) return { ok: false, error: err(404, 'not_found', 'Post not found.') }
  if (post.authorId !== actor.id && actor.role !== 'admin') {
    return { ok: false, error: err(403, 'forbidden', 'You can only delete your own posts.') }
  }

  const result = await softDeleteProductPost(post)
  if (!result.deleted) return { ok: false, error: err(404, 'not_found', 'Post not found.') }
  return { ok: true, data: true }
}

import { Prisma } from '@prisma/client'

export interface DeleteReportedResult {
  deleted: boolean
  images: string[]
}

/** Moderation (admin resolving a report with action 'delete') uses the same
 *  transaction and chemical counters as the author-facing delete.
 *  When `tx` is provided, the soft-delete executes inside the caller's transaction
 *  and post-commit side effects are deferred until `runPostDeleteSideEffects` is called. */
export async function deleteReportedPost(
  postId: string,
  tx?: Prisma.TransactionClient,
): Promise<DeleteReportedResult> {
  const client = tx ?? prisma
  const post = await client.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true, authorId: true, parentId: true },
  })
  if (!post) return { deleted: false, images: [] }
  return await softDeleteProductPost(post, tx)
}

export async function runPostDeleteSideEffects(images: string[]): Promise<void> {
  revalidateTrending()
  await deleteUnreferencedUploads(images)
}

type DeletablePost = { id: string; authorId: string; parentId: string | null }

/**
 * The one soft-delete transaction: generic lifecycle (tombstone, reply and
 * post counters) + product cleanup (chemical tags, Chemical.postCount) —
 * each step exactly once, guarded so a concurrent second delete is a no-op.
 * Captures the actual image snapshot deleted inside the row lock.
 */
async function softDeleteProductPost(
  post: DeletablePost,
  clientTx?: Prisma.TransactionClient,
): Promise<{ deleted: boolean; images: string[] }> {
  let deletedImages: string[] = []
  const run = async (tx: Prisma.TransactionClient) => {
    // Canonical lock order shared with repost cancel
    // (interaction.service.ts): Repost row → generated post row → user row
    // → original post row. The repost claim runs BEFORE the tombstone so
    // both paths contend on the Repost row in the same order (no AB-BA
    // deadlock between cancel and delete), and the claim is guarded by the
    // row id read above — a concurrent cancel that wins the row makes this
    // claim miss cleanly instead of throwing P2025.
    const linkedRepost = await tx.repost.findUnique({
      where: { repostPostId: post.id },
      select: { id: true, postId: true },
    })
    const claimed = linkedRepost
      ? await tx.repost.deleteMany({ where: { id: linkedRepost.id } })
      : { count: 0 }
    const result = await softDeleteCorePost(tx, post)
    if (result.deleted) {
      deletedImages = result.images
      // Decrement the original post's repostCount only when THIS delete both
      // won the tombstone and claimed the still-live Repost row — the loser
      // of either race has already accounted for it.
      if (linkedRepost && claimed.count > 0) {
        await tx.post.update({
          where: { id: linkedRepost.postId },
          data: { repostCount: { decrement: 1 } },
        })
      }

      // Read the association AFTER the guarded tombstone: the delete won the
      // race, so these tags are ours to clear and count down.
      const currentCas = await postCasNumbers(tx, post.id)
      await replacePostChemicals(tx, { postId: post.id, current: currentCas, next: [] })
    }
    return result.deleted
  }
  const deleted = clientTx ? await run(clientTx) : await prisma.$transaction(run)
  if (!deleted) return { deleted: false, images: [] }

  if (!clientTx) {
    // Post-delete side effects (outside the transaction, best-effort):
    //  - trending counts changed — drop the cached sidebar list
    //  - the deleted post's images may now be orphaned files (using actual snapshot)
    await runPostDeleteSideEffects(deletedImages)
  }
  return { deleted: true, images: deletedImages }
}
