/**
 * GET /api/notifications?cursor=...
 *
 * Paginated notification list for the current user.
 * Returns { notifications, nextCursor, unreadCount }.
 *
 * Auth: required (session or API key).
 */

import { NextRequest } from 'next/server'
import { requireAuth } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import {
  getNotificationsPage,
  getUnreadNotificationCount,
  InvalidNotificationCursorError,
} from '@/lib/services/notify.service'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'read')
  if (limited) return limited

  const cursor = request.nextUrl.searchParams.get('cursor') ?? undefined

  try {
    const [page, unreadCount] = await Promise.all([
      getNotificationsPage(auth.identity.user!.id, cursor),
      getUnreadNotificationCount(auth.identity.user!.id),
    ])

    return Response.json({
      notifications: page.notifications,
      nextCursor: page.nextCursor,
      unreadCount,
    })
  } catch (e: unknown) {
    if (e instanceof InvalidNotificationCursorError) {
      return jsonError(400, 'bad_request', e.message)
    }
    throw e
  }
}
