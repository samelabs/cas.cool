/**
 * /api/me/profile   PATCH — update profile fields
 * /api/me/password  POST  — change password (invalidates all sessions)
 *
 * Auth: cookie session or API Key.
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { deleteUnreferencedUploads } from '@/lib/upload-cleanup'
import { assertUploadAssetsAvailable } from '@/lib/upload-lifecycle'
import { PostServiceError } from '@/lib/services/post-core.service'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { userSelect, serializeUser } from '@/lib/serialize'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

// ── PATCH /api/me/profile ─────────────────────────────────────

export async function PATCH(request: NextRequest) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError(400, 'bad_request', 'Invalid JSON.')

  const clean: Record<string, string | null> = {}
  if ('displayName' in body)
    clean.displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 50) || null : null
  if ('bio' in body)
    clean.bio = typeof body.bio === 'string' ? body.bio.trim().slice(0, 280) || null : null
  if ('avatar' in body)
    clean.avatar = (typeof body.avatar === 'string' && body.avatar.startsWith('/uploads/'))
      ? body.avatar.trim().slice(0, 2000) : null
  if ('banner' in body)
    clean.banner = (typeof body.banner === 'string' && body.banner.startsWith('/uploads/'))
      ? body.banner.trim().slice(0, 2000) : null
  if ('location' in body)
    clean.location = typeof body.location === 'string' ? body.location.trim().slice(0, 100) || null : null
  if ('website' in body) {
    const url = typeof body.website === 'string' ? body.website.trim().slice(0, 2000) : ''
    clean.website = (url.startsWith('https://') || url.startsWith('http://')) ? url : null
  }

  // New public references assert asset availability under the per-asset
  // lifecycle lock (R5) inside the update transaction; non-canonical upload
  // URLs are rejected (400) before the reference is written.
  const publicRefs = [clean.avatar, clean.banner].filter(
    (u): u is string => typeof u === 'string' && u.startsWith('/uploads/'),
  )

  let updated
  try {
  updated = await prisma.$transaction(async (tx) => {
    // Old avatar/banner (fetched before the update overwrites them) for
    // orphan cleanup below.
    const prev = await tx.user.findUnique({
      where: { id: user.id },
      select: { avatar: true, banner: true },
    })
    if (publicRefs.length > 0) {
      await assertUploadAssetsAvailable(tx, publicRefs, 'public')
    }
    const updated = await tx.user.update({
      where: { id: user.id },
      data: clean,
      select: { ...userSelect, email: true },
    })
    return { updated, prev }
  })
  } catch (e: unknown) {
    if (e instanceof PostServiceError) return jsonError(e.status, e.code, e.message)
    throw e
  }
  const updatedUser = updated.updated
  const prev = updated.prev

  // Best-effort cleanup: the replaced avatar/banner file may now be
  // orphaned (only deleted if no row still references it).
  const replaced: string[] = []
  if (prev) {
    if (clean.avatar !== undefined && prev.avatar && prev.avatar !== clean.avatar) replaced.push(prev.avatar)
    if (clean.banner !== undefined && prev.banner && prev.banner !== clean.banner) replaced.push(prev.banner)
  }
  if (replaced.length > 0) await deleteUnreferencedUploads(replaced)

  return Response.json({ user: serializeUser(updatedUser) })
}
