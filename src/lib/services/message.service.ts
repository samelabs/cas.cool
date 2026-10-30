/**
 * Message service — conversation list and thread prefetch.
 * Shared by Server Components (SSR) and Server Actions.
 */

import { prisma } from '@/lib/db'
import { userSelect, serializeUser } from '@/lib/serialize'
import type { SafeUser, SafeConversation } from '@/lib/types'

export interface ConversationSummary {
  id: string
  otherUser: SafeUser
  lastMessage?: {
    content: string
    createdAt: Date
    senderId: string
  }
  unreadCount: number
}

export interface MessageThread {
  id: string
  content: string
  senderId: string
  receiverId: string
  createdAt: Date
}

// ─── Conversation List ────────────────────────────────────────

export async function getConversationList(
  userId: string,
  limit: number = 50,
): Promise<ConversationSummary[]> {
  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [{ user1Id: userId }, { user2Id: userId }],
      AND: [
        {
          OR: [
            { user1Id: userId, deletedBy1: false },
            { user2Id: userId, deletedBy2: false },
          ],
        },
      ],
    },
    include: {
      user1: { select: userSelect },
      user2: { select: userSelect },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { content: true, createdAt: true, senderId: true },
      },
    },
    orderBy: { lastAt: 'desc' },
    take: limit,
  })

  // Batched unread count
  const convIds = conversations.map((c) => c.id)
  const unreadAgg = convIds.length > 0
    ? await prisma.directMessage.groupBy({
        by: ['conversationId'],
        where: { receiverId: userId, readAt: null, conversationId: { in: convIds } },
        _count: { _all: true },
      })
    : []
  const unreadMap = new Map<string, number>()
  for (const row of unreadAgg) {
    unreadMap.set(row.conversationId, row._count._all)
  }

  return conversations.map((c) => {
    const otherUser = serializeUser(c.user1Id === userId ? c.user2 : c.user1)
    const last = c.messages[0]
    return {
      id: c.id,
      otherUser,
      lastMessage: last
        ? { content: last.content, createdAt: last.createdAt, senderId: last.senderId }
        : undefined,
      unreadCount: unreadMap.get(c.id) ?? 0,
    }
  })
}

/**
 * For Server Action return type compatibility.
 */
export async function getConversationListSerialized(
  userId: string,
  limit: number = 50,
): Promise<{ conversations: SafeConversation[] }> {
  const items = await getConversationList(userId, limit)
  return {
    conversations: items.map((c) => ({
      id: c.id,
      otherUser: c.otherUser,
      lastMessage: c.lastMessage,
      unreadCount: c.unreadCount,
    })),
  }
}

// ─── Conversation Thread ──────────────────────────────────────

export async function getConversationThread(
  conversationId: string,
  currentUserId: string,
  limit: number = 200,
): Promise<{ otherUser: SafeUser | null; messages: MessageThread[]; unreadInConv: number }> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } })
  if (!conversation || (conversation.user1Id !== currentUserId && conversation.user2Id !== currentUserId)) {
    return { otherUser: null, messages: [], unreadInConv: 0 }
  }

  const otherId = conversation.user1Id === currentUserId ? conversation.user2Id : conversation.user1Id

  const [otherUser, messages] = await Promise.all([
    prisma.user.findUnique({ where: { id: otherId }, select: userSelect }),
    // First screen = the MOST RECENT window (newest `limit` messages),
    // rendered chronologically. Older history is reachable through
    // GET /api/messages/:id?beforeTs=&beforeId= (composite boundary, same
    // ordering as here), which the thread UI loads on scroll-to-top; the
    // opening view must never hide the newest messages behind an
    // oldest-first window.
    prisma.directMessage.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true, senderId: true, content: true, createdAt: true },
    }),
  ])

  // Read-confirmation scope (F06 contract): ONLY the received messages this
  // call actually returned. A backlog older than the window is not
  // silently confirmed — it stays unread (badge intact) until it is really
  // shown/confirmed via the incremental polling contract.
  const returnedReceivedIds = messages
    .filter((m) => m.senderId !== currentUserId)
    .map((m) => m.id)
  let unreadInConv = 0
  if (returnedReceivedIds.length > 0) {
    unreadInConv = await prisma.directMessage.updateMany({
      where: { id: { in: returnedReceivedIds }, receiverId: currentUserId, readAt: null },
      data: { readAt: new Date() },
    }).then((r) => r.count).catch(() => 0)
  }

  return {
    otherUser: otherUser ? serializeUser(otherUser) : null,
    messages: messages.reverse().map((m) => ({
      id: m.id,
      content: m.content,
      senderId: m.senderId,
      receiverId: m.senderId === currentUserId ? otherId : currentUserId,
      createdAt: m.createdAt,
    })),
    unreadInConv,
  }
}

// ─── Badge Count ──────────────────────────────────────────────

export async function getUnreadMessageCount(userId: string): Promise<number> {
  try {
    return await prisma.directMessage.count({ where: { receiverId: userId, readAt: null } })
  } catch {
    return 0
  }
}
