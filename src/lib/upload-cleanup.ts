/**
 * Orphaned-upload cleanup with reference counting.
 *
 * Uploads are referenced by URL path from:
 *   - post.images[]          (Post.images String array)
 *   - post.quotedPost.images[] (same, via quote tree)
 *   - user.avatar / user.banner
 *   - verificationSubmission.idFrontImage / idBackImage
 *
 * Two storage boundaries, one reference-counted cleanup:
 *   /uploads/<file>                → public/uploads   (public post media)
 *   /api/media/verification/<file> → private-uploads  (identity documents,
 *                                    read only via the gated media route)
 *
 * Nothing ever deleted the files, so edits/removals/deletes leaked disk
 * forever. deleteUnreferencedUpload() removes a file only after the
 * transaction committed AND no row anywhere still references its URL —
 * an image reused by another post is never touched.
 *
 * All failures are logged and swallowed: cleanup is best-effort and must
 * never break the request path it runs after.
 */

import { prisma } from '@/lib/db'
import type { Prisma, PrismaClient } from '@prisma/client'
import { unlink } from 'node:fs/promises'
import { lockUploadAssets, parseUploadUrl, uploadAssetPath } from '@/lib/upload-lifecycle'

/** Is this URL still referenced by any row in the database? Shared by the
 *  outbox cleaner and the upload sweep (re-checked immediately before any
 *  unlink, so a reference added since the listing protects the file). */
export async function isReferenced(
  url: string,
  client: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<boolean> {
  // post.images is String[] — `has` is exact membership.
  const post = await client.post.findFirst({
    where: { images: { has: url } },
    select: { id: true },
  })
  if (post) return true

  const user = await client.user.findFirst({
    where: { OR: [{ avatar: url }, { banner: url }] },
    select: { id: true },
  })
  if (user) return true

  const sub = await client.verificationSubmission.findFirst({
    where: { OR: [{ idFrontImage: url }, { idBackImage: url }] },
    select: { id: true },
  })
  if (sub) return true

  return false
}

/**
 * Throwing removal primitive used by the side-effect outbox: unlike
 * `deleteUnreferencedUploads` below, real failures propagate so the
 * executor can record them as a retryable pending task.
 *
 * Lifecycle coordination (R5): the final reference check and the unlink
 * run inside ONE transaction holding the per-URL advisory lock — a
 * concurrent reference write serializes against this window instead of
 * racing it. Error contract: ENOENT is success (goal state reached);
 * every other unlink error (EACCES/EPERM/EIO/…) propagates so the task
 * stays pending and observable — a real failure is never reported as
 * "already missing".
 */
export async function removeUnreferencedUpload(url: string): Promise<void> {
  // One asset identity (upload-lifecycle.ts): only a canonical URL names a
  // file; references can only have been written in that same spelling.
  const asset = parseUploadUrl(url)
  if (!asset) return
  await prisma.$transaction(async (tx) => {
    await lockUploadAssets(tx, [asset])
    if (await isReferenced(asset.url, tx)) return
    try {
      await unlink(uploadAssetPath(asset))
    } catch (e: unknown) {
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return
      // Real unlink failure: rollback the (lock-only) transaction and let
      // the error surface as a retryable task failure.
      throw e
    }
  })
}

/**
 * Delete the given upload URLs (public or private prefix) if nothing
 * references them. Safe to call with duplicates and with URLs that were
 * never files.
 */
export async function deleteUnreferencedUploads(urls: string[]): Promise<void> {
  const unique = [...new Set(urls)]
  for (const url of unique) {
    try {
      await removeUnreferencedUpload(url)
    } catch {
      // Missing file or transient error — nothing to do; a later run
      // (or nothing) will revisit. Cleanup must never throw upward.
    }
  }
}
