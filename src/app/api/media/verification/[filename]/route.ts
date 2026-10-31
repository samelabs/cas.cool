/**
 * GET /api/media/verification/[filename] — identity-gated read access to a
 * private verification attachment.
 *
 * Storage: the file lives in the configured private root (PRIVATE_UPLOAD_DIR,
 * outside the public tree), so no static path — Next's public tree or an
 * Nginx /uploads/ rule — can serve it. This route is the ONLY read path,
 * and it re-checks authorization on every request.
 *
 * TRUST CHAIN (R1): the `PrivateMedia` row written at upload time is the
 * single ownership anchor. A VerificationSubmission is user-authored data —
 * it can narrow WHO reviews an attachment (admins of a referenced
 * submission) but it can never CREATE ownership or override the anchor.
 *   - anonymous               → 401 (standard challenge)
 *   - no PrivateMedia record  → 404 (unowned/unknown: no trust anchor)
 *   - non-owner member        → 404 (no existence leak)
 *   - owner (uploader)        → 200
 *   - admin, attachment in a submission under review → 200
 *
 * Cache policy: `private, no-store` — identity responses must never land
 * in shared caches or bfcache. Auth: session or API key (read tier).
 */

import { NextRequest } from 'next/server'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { requireAuth } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { resolveUploadDirs } from '@/lib/media-storage'
import { prisma } from '@/lib/db'

/** Exactly what processAndStoreImage writes for verification attachments:
 *  a random UUID + webp/gif extension. Anything else (separators, dots,
 *  traversal, odd extensions) is refused before any filesystem or DB access. */
const VERIFICATION_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|gif)$/

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const auth = await requireAuth()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'read')
  if (limited) return limited

  const { filename } = await params
  if (!VERIFICATION_FILENAME.test(filename)) {
    return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 })
  }
  const url = `/api/media/verification/${filename}`

  // Ownership anchor: without the upload-time PrivateMedia row there is no
  // trusted owner and no access. A submission row (user-authored) can only
  // ADD admin review access — never ownership.
  const media = await prisma.privateMedia.findUnique({
    where: { filename },
    select: { userId: true },
  })
  if (!media) {
    return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 })
  }

  const user = auth.identity.user!
  if (media.userId !== user.id) {
    const referencedBySubmission = await prisma.verificationSubmission.findFirst({
      where: { OR: [{ idFrontImage: url }, { idBackImage: url }] },
      select: { id: true },
    })
    if (!(user.role === 'admin' && referencedBySubmission)) {
      // 404, not 403: the caller must not learn that the attachment exists.
      return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 })
    }
  }

  // Defense in depth over the regex: resolve and confirm the path stays
  // inside the private directory even if the filename shape ever changes.
  const privateDir = resolveUploadDirs().private
  const filePath = path.resolve(path.join(privateDir, filename))
  if (!filePath.startsWith(path.resolve(privateDir) + path.sep)) {
    return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 })
  }

  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch {
    // DB references a file that is gone — never leak the DB row's existence.
    return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 })
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': filename.endsWith('.gif') ? 'image/gif' : 'image/webp',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
