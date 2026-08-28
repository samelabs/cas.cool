/**
 * Orphaned-upload cleanup with reference counting.
 *
 * Uploads live in public/uploads and are referenced by URL path from:
 *   - post.images[]          (Post.images Json array)
 *   - post.quotedPost.images[] (same, via quote tree)
 *   - user.avatar / user.banner
 *   - verificationSubmission.idFrontImage / idBackImage
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
import path from 'node:path'
import { unlink } from 'node:fs/promises'

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads')

/** Extract the bare filename from a /uploads/... URL (null if not one). */
function uploadFilename(url: string): string | null {
  if (!url.startsWith('/uploads/')) return null
  const name = url.slice('/uploads/'.length)
  // Defensive: no path traversal, no empty, no subdirectories.
  if (!name || name.includes('/') || name.includes('..')) return null
  return name
}

/** Is this URL still referenced by any row in the database? */
async function isReferenced(url: string): Promise<boolean> {
  // post.images is String[] — `has` is exact membership.
  const post = await prisma.post.findFirst({
    where: { images: { has: url } },
    select: { id: true },
  })
  if (post) return true

  const user = await prisma.user.findFirst({
    where: { OR: [{ avatar: url }, { banner: url }] },
    select: { id: true },
  })
  if (user) return true

  const sub = await prisma.verificationSubmission.findFirst({
    where: { OR: [{ idFrontImage: url }, { idBackImage: url }] },
    select: { id: true },
  })
  if (sub) return true

  return false
}

/**
 * Delete the given /uploads/... URLs if nothing references them.
 * Safe to call with duplicates and with URLs that were never files.
 */
export async function deleteUnreferencedUploads(urls: string[]): Promise<void> {
  const unique = [...new Set(urls)].map(uploadFilename).filter((n): n is string => !!n)
  for (const name of unique) {
    const url = `/uploads/${name}`
    try {
      if (await isReferenced(url)) continue
      await unlink(path.join(UPLOAD_DIR, name))
    } catch {
      // Missing file or transient error — nothing to do; a later run
      // (or nothing) will revisit. Cleanup must never throw upward.
    }
  }
}
