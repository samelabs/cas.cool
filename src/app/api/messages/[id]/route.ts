/**
 * GET    /api/messages/[id] — poll a conversation for new messages.
 * DELETE /api/messages/[id] — soft-delete a conversation for the caller.
 *
 * Auth: API Key or Session.
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth, requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

// ── GET — poll for new messages since a timestamp ─────────────
// Used by MessageThread to receive the other side's messages live
// (no websocket infra on this stack). Returns only messages with
// createdAt > since; marks them read as a side effect (same
// semantics as opening the page).
//
// READ semantics: requireAuth + 'read' tier, NOT requireWrite —
// polling is how a conversation is *received*. 'restricted' accounts
// keep read access (write gate is requireWrite on the send route);
// gating the poll on active-only would cut a restricted user off
// from reading their inbox entirely.
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

  // "since" — ISO timestamp of the newest message the client already has.
  // Missing/invalid → empty response (client re-syncs via full page).
  const sinceRaw = request.nextUrl.searchParams.get('since')
  const since = sinceRaw ? new Date(sinceRaw) : null
  if (since === null || isNaN(since.getTime())) {
    return Response.json({ messages: [] })
  }

  const messages = await prisma.directMessage.findMany({
    where: { conversationId, createdAt: { gt: since } },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { id: true, senderId: true, receiverId: true, content: true, readAt: true, createdAt: true },
  })

  // Mark received messages as read (mirror of page semantics).
  const receivedIds = messages.filter((m) => m.receiverId === user.id && m.readAt === null).map((m) => m.id)
  if (receivedIds.length > 0) {
    await prisma.directMessage.updateMany({
      where: { id: { in: receivedIds } },
      data: { readAt: new Date() },
    }).catch(() => {})
  }

  return Response.json({
    messages: messages.map(({ id, senderId, content, createdAt }) => ({ id, senderId, content, createdAt })),
  })
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
