/**
 * PATCH /api/admin/users/[id] — update user status.
 *
 * Auth: Admin (write).
 * Body: { status: 'active' | 'restricted' | 'suspended' }
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

const VALID_STATUSES = new Set(['active', 'restricted', 'suspended'])

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const admin = auth.identity.user!
  const { id: userId } = await params

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object')
    return jsonError(400, 'bad_request', 'Invalid JSON.')

  const newStatus = typeof body.status === 'string' ? body.status : ''
  if (!VALID_STATUSES.has(newStatus))
    return jsonError(400, 'bad_request', 'Invalid status.')

  if (userId === admin.id)
    return jsonError(400, 'bad_request', 'Cannot change your own status.')

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } })
  if (!user) return jsonError(404, 'not_found', 'User not found.')
  if (user.role === 'admin')
    return jsonError(400, 'bad_request', 'Cannot modify admin accounts.')

  await prisma.user.update({
    where: { id: userId },
    data: { status: newStatus as 'active' | 'restricted' | 'suspended' },
  })

  if (newStatus === 'suspended') {
    await prisma.session.deleteMany({ where: { userId } })
  }

  return Response.json({ ok: true, status: newStatus })
}
