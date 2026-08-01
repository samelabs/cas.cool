/**
 * DELETE /api/messages/[id] — soft-delete a conversation for the caller.
 *
 * Auth: API Key or Session (write).
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
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
