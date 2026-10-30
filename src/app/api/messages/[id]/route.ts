/**
 * GET    /api/messages/[id] — poll a conversation for new messages.
 * DELETE /api/messages/[id] — soft-delete a conversation for the caller.
 *
 * Auth: API Key or Session.
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth, requireWrite, writeAccessError } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { isCanonicalTimestamp } from '@/lib/pagination'

/** Incremental poll batch size — the client drains via hasMore until the
 *  boundary catches up, so bursts larger than one batch are not lost. */
const MESSAGE_POLL_BATCH = 50

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

// ── GET — poll for new messages after a composite (createdAt, id) boundary ──
// Used by MessageThread (and any programmatic caller) to receive messages
// after the last one it already holds. The boundary is the composite cursor
// `afterTs` (canonical ISO ms) + `afterId` (id of the last message at that
// timestamp), matching the (createdAt, id) ordering — a timestamp-only
// boundary silently dropped same-millisecond messages at the 50-per-batch
// cutoff. Responses carry `hasMore`: a caller that keeps advancing
// (last message's createdAt+id) drains any backlog in bounded batches.
//
// READ semantics: requireAuth + 'read' tier, NOT requireWrite —
// polling is how a conversation is *received*. 'restricted' accounts
// keep read access (write gate is requireWrite on the send route);
// gating the poll on active-only would cut a restricted user off
// from reading their inbox entirely. Only the RECEIVED messages actually
// returned are confirmed read, and only for callers with write access —
// a read-only key can inspect without touching read receipts.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'read')
  if (limited) return limited

  const user = auth.identity.user!
  const { id: conversationId } = await params

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { user1Id: true, user2Id: true },
  })
  if (!conv) return jsonError(404, 'not_found', 'Conversation not found.')
  if (conv.user1Id !== user.id && conv.user2Id !== user.id) {
    return jsonError(403, 'forbidden', 'Access denied.')
  }

  // HISTORY paging (beforeTs/beforeId): the page strictly BEFORE the
  // composite boundary, returned in chronological order. Used by the thread
  // UI to read older messages beyond the initial most-recent window —
  // without it, the first screen's oldest messages were unreachable.
  const beforeTsRaw = request.nextUrl.searchParams.get('beforeTs')
  const beforeId = request.nextUrl.searchParams.get('beforeId') ?? ''
  if (beforeTsRaw) {
    if (!isCanonicalTimestamp(beforeTsRaw)) {
      return jsonError(400, 'bad_request', 'beforeTs must be a canonical ISO timestamp (e.g. 2026-01-01T00:00:00.000Z).')
    }
    const beforeBoundary = new Date(beforeTsRaw)
    const history = await prisma.directMessage.findMany({
      where: {
        conversationId,
        OR: [
          { createdAt: { lt: beforeBoundary } },
          { createdAt: beforeBoundary, id: { lt: beforeId } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MESSAGE_POLL_BATCH,
      select: { id: true, senderId: true, receiverId: true, content: true, readAt: true, createdAt: true },
    })
    const page = history.reverse()

    // Read-scope rule identical to the incremental path: received messages
    // this response actually returns are confirmed read (write callers only).
    const historyReceived = page.filter((m) => m.receiverId === user.id && m.readAt === null).map((m) => m.id)
    if (historyReceived.length > 0 && writeAccessError(auth.identity) === null) {
      await prisma.directMessage.updateMany({
        where: { id: { in: historyReceived } },
        data: { readAt: new Date() },
      }).catch(() => {})
    }

    return Response.json({
      messages: page.map(({ id, senderId, content, createdAt }) => ({ id, senderId, content, createdAt })),
      // A full batch means older history may exist beyond this page.
      hasMore: page.length === MESSAGE_POLL_BATCH,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  // Incremental boundary — validated BEFORE the query. `afterId` may be empty
  // only when the client has no message at afterTs yet (fresh start at a
  // timestamp); a malformed afterTs is client garbage → 400.
  const afterTsRaw = request.nextUrl.searchParams.get('afterTs')
  const afterId = request.nextUrl.searchParams.get('afterId') ?? ''
  if (!afterTsRaw || !isCanonicalTimestamp(afterTsRaw)) {
    return jsonError(400, 'bad_request', 'afterTs must be a canonical ISO timestamp (e.g. 2026-01-01T00:00:00.000Z).')
  }
  const boundary = new Date(afterTsRaw)

  const messages = await prisma.directMessage.findMany({
    where: {
      conversationId,
      OR: [
        { createdAt: { gt: boundary } },
        { createdAt: boundary, id: { gt: afterId } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MESSAGE_POLL_BATCH,
    select: { id: true, senderId: true, receiverId: true, content: true, readAt: true, createdAt: true },
  })

  // Mark received messages as read — ONLY the ones this response returns
  // (same scope rule as opening the conversation).
  const receivedIds = messages.filter((m) => m.receiverId === user.id && m.readAt === null).map((m) => m.id)
  // A programmatic caller without write permission may inspect a conversation
  // but must not change its read receipts. Browser sessions and verified keys
  // keep the existing behavior.
  if (receivedIds.length > 0 && writeAccessError(auth.identity) === null) {
    await prisma.directMessage.updateMany({
      where: { id: { in: receivedIds } },
      data: { readAt: new Date() },
    }).catch(() => {})
  }

  return Response.json({
    messages: messages.map(({ id, senderId, content, createdAt }) => ({ id, senderId, content, createdAt })),
    // Exactly one full batch means more may follow; the client advances
    // with the last message's (createdAt, id) and drains until false.
    hasMore: messages.length === MESSAGE_POLL_BATCH,
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!
  const { id: conversationId } = await params

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { user1Id: true, user2Id: true },
  })
  if (!conv) return jsonError(404, 'not_found', 'Conversation not found.')
  if (conv.user1Id !== user.id && conv.user2Id !== user.id) {
    return jsonError(403, 'forbidden', 'Access denied.')
  }

  const data = conv.user1Id === user.id ? { deletedBy1: true } : { deletedBy2: true }
  await prisma.conversation.update({ where: { id: conversationId }, data })

  return Response.json({ ok: true })
}
