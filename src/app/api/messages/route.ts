/**
 * POST /api/messages — start a new conversation (or revive a deleted one).
 *
 * Auth: API Key or Session (write).
 * Body (JSON): { recipientId: string, content: string }
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { upsertNotification } from '@/lib/notification'
import { canDirectMessage } from '@/lib/permissions'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(request: NextRequest) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError(400, 'bad_request', 'Invalid JSON.')

  const recipientId = typeof body.recipientId === 'string' ? body.recipientId : ''
  const content = typeof body.content === 'string' ? body.content.trim() : ''

  if (!recipientId) return jsonError(400, 'bad_request', 'Recipient is required.')
  if (!content) return jsonError(400, 'bad_request', 'Message is required.')
  if (content.length > 4000) return jsonError(400, 'bad_request', 'Message is too long.')
  if (recipientId === user.id) return jsonError(400, 'bad_request', 'Cannot message yourself.')

  const recipient = await prisma.user.findUnique({ where: { id: recipientId }, select: { id: true } })
  if (!recipient) return jsonError(404, 'not_found', 'User not found.')

  if (!canDirectMessage(user)) {
    const followsMe = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: recipientId, followingId: user.id } },
      select: { id: true },
    })
    if (!followsMe)
      return jsonError(403, 'forbidden', 'You can only message users who follow you.')
  }

  const [user1Id, user2Id] = [user.id, recipientId].sort()
  const result = await prisma.$transaction(async (tx) => {
    const conv = await tx.conversation.upsert({
      where: { user1Id_user2Id: { user1Id, user2Id } },
      create: { user1Id, user2Id },
      update: { lastAt: new Date(), deletedBy1: false, deletedBy2: false },
      select: { id: true },
    })
    await tx.directMessage.create({
      data: { conversationId: conv.id, senderId: user.id, receiverId: recipientId, content },
    })
    return conv
  })

  await upsertNotification({ userId: recipientId, fromId: user.id, type: 'MESSAGE' })

  return Response.json({ conversationId: result.id }, { status: 201 })
}
