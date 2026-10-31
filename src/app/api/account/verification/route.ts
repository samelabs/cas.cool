/**
 * POST /api/account/verification — submit verification request
 *
 * Body: { idName, idNumber, idFrontImage, idBackImage }
 *
 * Image URLs come from prior /api/upload calls (purpose=verification) and
 * must be the canonical private identity of an attachment the CALLER owns:
 * a `PrivateMedia` row created at upload time is the single trust anchor.
 * Filling someone else's URL into this form grants nothing — ownership is
 * never derived from a user-writable reference (R1).
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { VERIFICATION_MEDIA_PREFIX } from '@/lib/media-storage'
import { assertLockedUploadAssetsExist, lockUploadAssets, parseUploadUrl } from '@/lib/upload-lifecycle'
import { PostServiceError } from '@/lib/services/post-core.service'
import { enqueueSideEffects, drainEnqueuedSideEffects } from '@/lib/services/side-effect.service'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

/** Canonical private attachment URL shape — exactly what the upload API
 *  returns. Anything else (wrong prefix, non-canonical filename, traversal)
 *  is rejected before any database access. */
const PRIVATE_ATTACHMENT_URL =
  new RegExp(`^${VERIFICATION_MEDIA_PREFIX}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:webp|gif))$`)

/**
 * Resolve a submitted URL to a trusted attachment owned by the caller:
 * canonical URL shape → PrivateMedia record (upload-time ownership anchor).
 * Any failure is a flat rejection; the reason is logged server-side only.
 * The live-file assertion runs inside the submit transaction under the
 * per-URL lifecycle lock (see resolveCallerAttachmentInTx).
 */
function privateFilename(url: string): string | null {
  const match = PRIVATE_ATTACHMENT_URL.exec(url)
  return match ? match[1] : null
}

async function resolveCallerAttachmentInTx(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  url: string,
  callerId: string,
): Promise<boolean> {
  const filename = privateFilename(url)
  if (!filename) return false

  const media = await tx.privateMedia.findUnique({
    where: { filename },
    select: { userId: true },
  })
  if (!media || media.userId !== callerId) return false
  return true
}

export async function POST(request: NextRequest) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!

  if (user.verificationStatus === 'pending') {
    return jsonError(400, 'bad_request', 'Already under review.')
  }
  if (user.verificationStatus === 'verified') {
    const existing = await prisma.verificationSubmission.findUnique({
      where: { userId: user.id },
      select: { status: true },
    })
    if (existing?.status === 'approved') {
      return jsonError(400, 'bad_request', 'Already verified.')
    }
  }

  const body = await request.json().catch(() => null)
  if (!body) return jsonError(400, 'bad_request', 'Invalid JSON.')

  const idName = typeof body.idName === 'string' ? body.idName.trim() : ''
  const idNumber = typeof body.idNumber === 'string' ? body.idNumber.trim() : ''
  const idFrontImage = typeof body.idFrontImage === 'string' ? body.idFrontImage.trim() : ''
  const idBackImage = typeof body.idBackImage === 'string' ? body.idBackImage.trim() : ''

  if (!idName || !idNumber || !idFrontImage || !idBackImage) {
    return jsonError(400, 'bad_request', 'All fields are required.')
  }

  const wasVerified = user.verificationStatus === 'verified'

  let taskIds: string[]
  try {
  const result = await prisma.$transaction(async (tx) => {
    // Trusted-attachment validation INSIDE the transaction: both fields must
    // resolve to live private files the caller owns (upload-time anchor),
    // asserted under the per-URL lifecycle lock. A submission can never
    // claim (or re-anchor) someone else's attachment, whatever URL it names.
    const urls = [...new Set([idFrontImage, idBackImage])]
    const assets = urls.map((url) => privateFilename(url) ? parseUploadUrl(url, 'private') : null)
    if (assets.some((asset) => asset === null)) throw new Error('attachment_validation_failed')
    const validAssets = assets.filter((asset) => asset !== null)
    // Lock before reading ownership: the orphan sweep uses this same lock
    // across its final reference check and ownership-row deletion.
    await lockUploadAssets(tx, validAssets)
    if (!(await resolveCallerAttachmentInTx(tx, idFrontImage, user.id))) {
      throw new Error('attachment_validation_failed')
    }
    if (idBackImage !== idFrontImage && !(await resolveCallerAttachmentInTx(tx, idBackImage, user.id))) {
      throw new Error('attachment_validation_failed')
    }
    await assertLockedUploadAssetsExist(validAssets)
    const previous = await tx.verificationSubmission.findUnique({
      where: { userId: user.id },
      select: { idFrontImage: true, idBackImage: true },
    })
    await tx.verificationSubmission.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id, idName, idNumber, idFrontImage, idBackImage,
        status: 'pending',
      },
      update: {
        idName, idNumber, idFrontImage, idBackImage,
        status: 'pending', reviewedAt: null, reviewNote: null, reviewedBy: null,
      },
    })
    await tx.user.update({
      where: { id: user.id },
      data: wasVerified ? {} : { verificationStatus: 'pending' },
    })
    // Images this resubmit replaced become cleanup candidates (reference
    // counting still protects any file another row still uses).
    const replacedImages = previous
      ? [previous.idFrontImage, previous.idBackImage].filter(
          (url) => url && url !== idFrontImage && url !== idBackImage,
        )
      : []
    const taskIds = replacedImages.length
      ? await enqueueSideEffects(tx, replacedImages.map((url) => ({ kind: 'upload_cleanup' as const, payload: { url } })))
      : []
    return { taskIds }
  })
  taskIds = result.taskIds
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'attachment_validation_failed') {
      return jsonError(400, 'bad_request', 'Invalid image file.')
    }
    // Asset identity / asset_gone from the shared lifecycle primitive.
    if (e instanceof PostServiceError) return jsonError(e.status, e.code, e.message)
    throw e
  }

  // Post-commit cleanup of replaced attachments (best-effort, ref-counted).
  await drainEnqueuedSideEffects(taskIds)

  return Response.json({ ok: true })
}
