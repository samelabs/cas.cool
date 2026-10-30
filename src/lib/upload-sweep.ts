/**
 * Orphaned-upload sweep — the attachment lifecycle backstop.
 *
 * Reference-counted cleanup (upload-cleanup.ts) runs when a row lets go of
 * a URL (edit, delete, resubmit). It can never see uploads that were never
 * attached to anything: a user uploads media, then abandons the composer —
 * the file sits in the storage tree forever. THIS sweep is the回收 for
 * those orphans, plus a safety net for anything else left unreferenced.
 *
 * Lifecycle rule (declared in the 1.2.0 closure report):
 *   An upload file is deletable when BOTH hold:
 *     1. Its mtime is older than SWEEP_GRACE_MS (24 h) — a file younger
 *        than the grace period may still be on its way into a post; the
 *        grace bounds the compose session we are willing to protect.
 *     2. No database row references its URL — re-checked immediately
 *        before the unlink (the same reference counting as edit/delete
 *        cleanup), so a reference added between the directory listing and
 *        the deletion protects the file.
 *
 * File deletion and ownership expiry share the reference writers' asset
 * locks. Run through POST /api/admin/uploads/sweep.
 * Never throws per-file: failures are reported, the sweep continues.
 */

import { readdir, stat, unlink } from 'node:fs/promises'
import { prisma } from '@/lib/db'
import { UPLOAD_GRACE_MS, UPLOAD_DIRS } from '@/lib/upload-sweep-config'
import { isReferenced } from '@/lib/upload-cleanup'
import { lockUploadAssets, uploadAssetFromFile, uploadAssetPath } from '@/lib/upload-lifecycle'

export { UPLOAD_GRACE_MS, UPLOAD_DIRS }

export interface SweepFileOutcome {
  file: string
  storage: 'public' | 'private'
  action: 'deleted' | 'kept-referenced' | 'kept-in-grace' | 'missing'
}

export interface SweepOutcome {
  scanned: number
  deleted: number
  /** Ownership rows for never-submitted attachments removed this run. */
  staleOwnershipRowsRemoved: number
  outcomes: SweepFileOutcome[]
  errors: { file: string; error: string }[]
}

/**
 * Decide + execute for ONE file. Exported for focused testing: the
 * grace check and the reference re-check happen here, immediately
 * before the unlink.
 */
export async function sweepUploadFile(
  storage: 'public' | 'private',
  filename: string,
  now = Date.now(),
  dirs: Record<'public' | 'private', string> = UPLOAD_DIRS,
): Promise<SweepFileOutcome> {
  // One asset identity (upload-lifecycle.ts): the canonical URL built from
  // the stored name is the lock identity and the reference identity. A file
  // whose name is not canonical can never be referenced through the write
  // path; it is reported as an error for operator review, never unlinked.
  const asset = uploadAssetFromFile(storage, filename)
  if (!asset) throw new Error(`Unrecognized upload filename: ${filename}`)
  const url = asset.url
  const filePath = uploadAssetPath(asset, dirs)

  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    return { file: url, storage, action: 'missing' }
  }
  if (now - fileStat.mtime.getTime() < UPLOAD_GRACE_MS) {
    return { file: url, storage, action: 'kept-in-grace' }
  }
  // Lifecycle coordination (R5): the final reference check and the unlink
  // run inside ONE transaction holding the per-asset advisory lock, so a
  // reference write either commits first (file kept) or is rejected after
  // the deletion (asset_gone) — it can never dangle.
  let outcome: SweepFileOutcome
  await prisma.$transaction(async (tx) => {
    await lockUploadAssets(tx, [asset])
    if (await isReferenced(url, tx)) {
      outcome = { file: url, storage, action: 'kept-referenced' }
      return
    }
    try {
      await unlink(filePath)
      outcome = { file: url, storage, action: 'deleted' }
    } catch (e: unknown) {
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
        outcome = { file: url, storage, action: 'missing' }
        return
      }
      // Real unlink failure (permissions/IO) — recorded as an error, never
      // reported as a completed recycle.
      throw e
    }
  })
  return outcome!
}

/** Sweep both storage trees. `now` injectable for tests; `dirs` overrides
 *  the storage roots (tests point them at temp directories). */
export async function sweepUploads(
  now = Date.now(),
  dirs: Record<'public' | 'private', string> = UPLOAD_DIRS,
): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { scanned: 0, deleted: 0, staleOwnershipRowsRemoved: 0, outcomes: [], errors: [] }

  for (const storage of ['public', 'private'] as const) {
    let entries: string[]
    try {
      entries = await readdir(dirs[storage])
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        outcome.errors.push({ file: dirs[storage], error: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    for (const filename of entries) {
      if (filename.startsWith('.')) continue
      outcome.scanned += 1
      try {
        const result = await sweepUploadFile(storage, filename, now, dirs)
        outcome.outcomes.push(result)
        if (result.action === 'deleted') outcome.deleted += 1
      } catch (e: unknown) {
        outcome.errors.push({
          file: filename,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  try {
    outcome.staleOwnershipRowsRemoved = await sweepStalePrivateMedia(now)
  } catch (e: unknown) {
    outcome.errors.push({
      file: '<private-media-rows>',
      error: e instanceof Error ? e.message : String(e),
    })
  }

  return outcome
}

/**
 * Stale ownership rows for never-submitted attachments: after the grace
 * window the preview grant expires (its file is swept separately by the
 * unreferenced-file rule). Submission-referenced files keep their rows
 * harmless; only abandoned uploads are cleaned.
 */
export async function sweepStalePrivateMedia(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - UPLOAD_GRACE_MS)
  const stale = await prisma.privateMedia.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { filename: true },
  })
  let removed = 0
  for (const { filename } of stale) {
    const asset = uploadAssetFromFile('private', filename)
    if (!asset) continue
    removed += await prisma.$transaction(async (tx) => {
      await lockUploadAssets(tx, [asset])
      const referenced = await tx.verificationSubmission.findFirst({
        where: { OR: [{ idFrontImage: asset.url }, { idBackImage: asset.url }] },
        select: { id: true },
      })
      if (referenced) return 0
      return (await tx.privateMedia.deleteMany({
        where: { filename, createdAt: { lt: cutoff } },
      })).count
    })
  }
  return removed
}
