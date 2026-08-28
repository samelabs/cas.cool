/**
 * POST /api/upload
 *
 * Multipart image upload. Replaces the old Server Action uploadImage.
 * Single code path for all image types (post, avatar, banner, verification).
 *
 * Auth: cookie session (browser) or API Key (agent).
 * Permission: verified users only (canUploadMedia).
 *
 * Body (multipart/form-data):
 *   file:    File (required) — jpeg/png/webp/gif, max 10MB
 *   purpose: string (optional) — 'post' | 'avatar' | 'banner' | 'verification'
 *
 * Returns: { url, filename, bytes }
 */

import { NextRequest } from 'next/server'
import { processAndStoreImage, MAX_RAW_BYTES, type UploadPurpose } from '@/lib/image'
import { resolveIdentity, requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { canUploadMedia } from '@/lib/permissions'

export async function POST(request: NextRequest) {
  // 1. Auth + permission
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  // 2. Rate limit (write tier)
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  // 3. Parse multipart — MUST run before the permission gate below: the
  //    declared purpose determines which permission applies. Verification
  //    uploads (ID photos) are how unverified users apply in the first
  //    place, so they cannot be gated on already being verified.
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return Response.json(
      { error: { code: 'bad_request', message: 'Expected multipart/form-data.' } },
      { status: 400 },
    )
  }

  const file = formData.get('file')
  if (!file || !(file instanceof File)) {
    return Response.json(
      { error: { code: 'bad_request', message: 'File is required.' } },
      { status: 400 },
    )
  }

  const purpose = (formData.get('purpose') as string) || 'post'
  const validPurposes: UploadPurpose[] = ['post', 'avatar', 'banner', 'verification']
  if (!validPurposes.includes(purpose as UploadPurpose)) {
    return Response.json(
      { error: { code: 'bad_request', message: 'Invalid purpose.' } },
      { status: 400 },
    )
  }

  // 4. Permission: verified users only — except purpose=verification,
  //    which is exempt by design (see step 3). Note requireWrite() in
  //    step 1 already rejected non-active accounts.
  if (purpose !== 'verification' && !canUploadMedia(auth.identity.user)) {
    return Response.json(
      { error: { code: 'forbidden', message: 'Verification required to upload images.' } },
      { status: 403 },
    )
  }

  // 5. Size check
  if (file.size > MAX_RAW_BYTES) {
    return Response.json(
      { error: { code: 'payload_too_large', message: `File exceeds ${MAX_RAW_BYTES} bytes.` } },
      { status: 413 },
    )
  }

  // 6. Process + store
  const buffer = Buffer.from(await file.arrayBuffer())
  const result = await processAndStoreImage(buffer, file.type, { purpose: purpose as UploadPurpose })
  if (!result) {
    return Response.json(
      { error: { code: 'invalid_file', message: 'File is not a valid image.' } },
      { status: 422 },
    )
  }

  return Response.json(
    { url: result.url, filename: result.filename, bytes: result.bytes },
    { status: 201 },
  )
}
