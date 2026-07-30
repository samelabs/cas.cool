'use server'

import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'

import { processAndStoreImage, MAX_RAW_BYTES, type UploadPurpose } from '@/lib/image'
import { canUploadMedia } from '@/lib/permissions'
import { revalidatePath } from 'next/cache'
import { ActionResult, ActionError } from './_shared'
import { withResult, requireUser } from './_guards'
import { userSelect, serializeUser } from '@/lib/serialize'
import type { SafeUser } from '@/lib/types'

/**
 * Update the current user's profile fields.
 * Only provided fields are updated; undefined means "leave unchanged".
 */
export async function updateProfile(input: {
  displayName?: string | null
  bio?: string | null
  avatar?: string | null
  banner?: string | null
  location?: string | null
  website?: string | null
}): Promise<ActionResult<{ user: SafeUser }>> {
  return withResult(async () => {
    const user = await requireUser()

    const clean: Record<string, string | null> = {}
    if ('displayName' in input)
      clean.displayName = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 50) || null : null
    if ('bio' in input)
      clean.bio = typeof input.bio === 'string' ? input.bio.trim().slice(0, 280) || null : null
    if ('avatar' in input)
      // Only allow local uploaded paths — prevents XSS via javascript: URIs
      // and external tracking URLs.
      clean.avatar = (typeof input.avatar === 'string' && input.avatar.startsWith('/uploads/'))
        ? input.avatar.trim().slice(0, 2000) : null
    if ('banner' in input)
      clean.banner = (typeof input.banner === 'string' && input.banner.startsWith('/uploads/'))
        ? input.banner.trim().slice(0, 2000) : null
    if ('location' in input)
      clean.location = typeof input.location === 'string' ? input.location.trim().slice(0, 100) || null : null
    if ('website' in input) {
      const url = typeof input.website === 'string' ? input.website.trim().slice(0, 2000) : ''
      // Only allow http/https schemes — prevents javascript: XSS
      clean.website = (url.startsWith('https://') || url.startsWith('http://')) ? url : null
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: clean,
      select: { ...userSelect, email: true },
    })

    revalidatePath(`/${user.username}`)
    revalidatePath('/settings/profile')
    return { user: serializeUser(updated) }
  })
}

/**
 * Change password — requires current password, invalidates all sessions.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()

    if (!currentPassword || !newPassword) throw new ActionError('BAD_REQUEST', 'Both password fields are required.')
    if (newPassword.length < 8) throw new ActionError('BAD_REQUEST', 'Password must be at least 8 characters.')
    if (newPassword.length > 128) throw new ActionError('BAD_REQUEST', 'Password is too long.')

    const record = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } })
    if (!record) throw new ActionError('NOT_FOUND', 'User not found.')

    const matched = await bcrypt.compare(currentPassword, record.passwordHash)
    if (!matched) throw new ActionError('FORBIDDEN', 'Current password is incorrect.')

    const newHash = await bcrypt.hash(newPassword, 10)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } })

    // Invalidate all sessions (force re-login)
    await prisma.session.deleteMany({ where: { userId: user.id } }).catch(() => {})

    return { ok: true }
  })
}

/**
 * Image upload — multipart File is passed directly to the Server Action.
 * Next.js 16 Server Actions natively support FormData/File inputs.
 */
export async function uploadImage(file: File, purpose: UploadPurpose = 'post'): Promise<ActionResult<{ url: string; filename: string; bytes: number }>> {
  return withResult(async () => {
    const user = await requireUser()
    if (!canUploadMedia(user)) throw new ActionError('FORBIDDEN', 'Image uploads require verification.')

    if (file.size === 0) throw new ActionError('BAD_REQUEST', 'File is empty.')
    if (file.size > MAX_RAW_BYTES) throw new ActionError('BAD_REQUEST', 'File is too large (max 10MB).')

    const buffer = Buffer.from(await file.arrayBuffer())
    const processed = await processAndStoreImage(buffer, file.type, { purpose })
    if (!processed) throw new ActionError('BAD_REQUEST', 'Invalid image file.')

    return { url: processed.url, filename: processed.filename, bytes: processed.bytes }
  })
}
