/**
 * POST /api/me/password — change password (invalidates all sessions)
 *
 * Auth: cookie session only (API Key callers cannot change password).
 * Body: { currentPassword, newPassword }
 */

import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { createSession, setSessionCookie } from '@/lib/auth'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!

  const body = await request.json().catch(() => null)
  if (!body) return jsonError(400, 'bad_request', 'Invalid JSON.')

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''

  if (!currentPassword || !newPassword) return jsonError(400, 'bad_request', 'Both password fields are required.')
  if (newPassword.length < 8) return jsonError(400, 'bad_request', 'Password must be at least 8 characters.')
  if (newPassword.length > 128) return jsonError(400, 'bad_request', 'Password is too long.')

  const record = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } })
  if (!record) return jsonError(404, 'not_found', 'User not found.')

  const matched = await bcrypt.compare(currentPassword, record.passwordHash)
  if (!matched) return jsonError(403, 'forbidden', 'Current password is incorrect.')

  const newHash = await bcrypt.hash(newPassword, 10)
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } })

  // Invalidate all sessions, then re-issue one for the current device.
  // The caller just proved knowledge of the current password (equivalent
  // to a fresh login), so keeping this device signed in is safe — other
  // devices stay logged out.
  await prisma.session.deleteMany({ where: { userId: user.id } }).catch(() => {})
  const token = await createSession(user.id)
  await setSessionCookie(token)

  return Response.json({ ok: true })
}
