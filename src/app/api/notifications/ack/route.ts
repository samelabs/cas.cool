/**
 * POST /api/notifications/ack — confirm specific notifications as read.
 *
 * Body: { items: [{ id, revision }, ...] } — the per-object, versioned
 * confirmation path for pages the user has actually SEEN (the SSR first
 * page is confirmed server-side with the same revision guard; explicit
 * mark-ALL stays on POST /api/notifications/read).
 *
 * Contract:
 *   - Each item updates ONLY its own row and ONLY when it is still unread
 *     AND still at the revision the client observed — a genuine new event
 *     bumps the revision, so a stale confirmation can never clear a
 *     re-activated notification.
 *   - Rows the caller does not own are silently ignored (no existence leak).
 *   - Response carries the server-confirmed remaining unread count so the
 *     badge converges to post-confirmation truth.
 *
 * Auth: write tier (browser session or verified key) — read-only keys can
 * list notifications but must not change read state.
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

interface AckItem {
  id: string
  revision: number
}

export async function POST(request: NextRequest) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!

  const body = await request.json().catch(() => null)
  const rawItems = body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)
    ? (body as { items: unknown[] }).items
    : null
  if (!rawItems) {
    return Response.json({ error: { code: 'bad_request', message: 'items is required.' } }, { status: 400 })
  }
  if (rawItems.length > 100) {
    return Response.json({ error: { code: 'bad_request', message: 'At most 100 items per ack.' } }, { status: 400 })
  }

  const items: AckItem[] = []
  for (const raw of rawItems) {
    if (
      raw && typeof raw === 'object' &&
      typeof (raw as AckItem).id === 'string' && (raw as AckItem).id.length > 0 &&
      typeof (raw as AckItem).revision === 'number' && Number.isInteger((raw as AckItem).revision) &&
      (raw as AckItem).revision >= 0 && (raw as AckItem).revision <= 2_147_483_647
    ) {
      items.push({ id: (raw as AckItem).id, revision: (raw as AckItem).revision })
    } else {
      return Response.json({ error: { code: 'bad_request', message: 'Each item must contain an id and a revision between 0 and 2147483647.' } }, { status: 400 })
    }
  }

  let confirmed = 0
  if (items.length > 0) {
    // One guarded statement per item set: revision-guarded conditions make
    // each update idempotent and stale-safe; ownership is enforced by the
    // per-item userId predicate.
    for (const item of items) {
      const result = await prisma.notification.updateMany({
        where: {
          id: item.id,
          userId: user.id,
          read: false,
          revision: item.revision,
        },
        data: { read: true },
      })
      confirmed += result.count
    }
  }

  const unreadRemaining = await prisma.notification.count({
    where: { userId: user.id, read: false },
  }).catch(() => 0)

  return Response.json(
    { confirmed, unreadRemaining },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
