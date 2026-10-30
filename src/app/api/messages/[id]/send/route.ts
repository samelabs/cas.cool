/**
 * POST /api/messages/[id]/send — send a message to an existing conversation.
 *
 * Auth: API Key or Session (write).
 * Body (JSON): { content: string }
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { enqueueSideEffects, drainEnqueuedSideEffects } from '@/lib/services/side-effect.service'
import { canDirectMessage } from '@/lib/permissions'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!
  const { id: conversationId } = await params

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError(400, 'bad_request', 'Invalid JSON.')

  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) return jsonError(400, 'bad_request', 'Message is required.')
  if (content.length > 4000) return jsonError(400, 'bad_request', 'Message is too long.')

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, user1Id: true, user2Id: true },
  })
  if (!conv) return jsonError(404, 'not_found', 'Conversation not found.')
  if (conv.user1Id !== user.id && conv.user2Id !== user.id) {
    return jsonError(403, 'forbidden', 'Access denied.')
  }

  const receiverId = conv.user1Id === user.id ? conv.user2Id : conv.user1Id

  if (!canDirectMessage(user)) {
    const followsMe = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: receiverId, followingId: user.id } },
      select: { id: true },
    })
    if (!followsMe)
      return jsonError(403, 'forbidden', 'You can only message users who follow you.')
  }

  // The message row and the recipient's MESSAGE notification event commit
  // together; the response carries the server message identity so the
  // client can replace its optimistic bubble without clock inference.
  const { message, taskIds } = await prisma.$transaction(async (tx) => {
    const message = await tx.directMessage.create({
      data: { conversationId: conv.id, senderId: user.id, receiverId, content },
    })
    await tx.conversation.update({
      where: { id: conv.id },
      data: { lastAt: new Date(), deletedBy1: false, deletedBy2: false },
    })
    const taskIds = await enqueueSideEffects(tx, [{
      kind: 'notification',
      payload: {
        userId: receiverId,
        fromId: user.id,
        type: 'MESSAGE',
        eventKey: `message:${message.id}`,
      },
    }])
    return { message, taskIds }
  })

  // Post-commit delivery — failures stay pending on the outbox task, never
  // surfaced as a 500 for the committed message.
  await drainEnqueuedSideEffects(taskIds)

  return Response.json({
    ok: true,
    message: { id: message.id, createdAt: message.createdAt },
  })
}
