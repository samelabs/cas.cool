/**
 * POST /api/notifications/read — mark all of the caller's notifications as read.
 *
 * Auth: API Key or Session (write).
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!

  await prisma.notification.updateMany({
    where: { userId: user.id, read: false },
    data: { read: true },
  })

  return Response.json({ ok: true })
}
