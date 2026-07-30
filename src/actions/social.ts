'use server'


import { prisma } from '@/lib/db'

import { upsertNotification } from '@/lib/notification'
import { canDirectMessage } from '@/lib/permissions'
import { revalidatePath } from 'next/cache'
import { ActionResult, ActionError, assertCanWrite } from './_shared'
import { withResult, requireUser } from './_guards'
import type { SafeUser, SafeConversation } from '@/lib/types'

// ─── Follow ───────────────────────────────────────────────────

export async function toggleFollow(username: string): Promise<ActionResult<{ following: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    const target = await prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true, username: true },
    })
    if (!target) throw new ActionError('NOT_FOUND', 'User not found.')
    if (target.id === user.id) throw new ActionError('BAD_REQUEST', 'Cannot follow yourself.')

    const existing = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: user.id, followingId: target.id } },
    })

    if (existing) {
      // Unfollow — deleteMany + count guard prevents underflow.
      await prisma.$transaction(async (tx) => {
        const deleted = await tx.follow.deleteMany({ where: { followerId: user.id, followingId: target.id } })
        if (deleted.count > 0) {
          await tx.user.update({ where: { id: user.id }, data: { followingCount: { decrement: 1 } } })
          await tx.user.update({ where: { id: target.id }, data: { followerCount: { decrement: 1 } } })
        }
      })
      revalidatePath(`/${target.username}`)
      return { following: false }
    }

    try {
      await prisma.$transaction([
        prisma.follow.create({ data: { followerId: user.id, followingId: target.id } }),
        prisma.user.update({ where: { id: user.id }, data: { followingCount: { increment: 1 } } }),
        prisma.user.update({ where: { id: target.id }, data: { followerCount: { increment: 1 } } }),
      ])
    } catch (e: unknown) {
      if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) throw e
    }
    await upsertNotification({ userId: target.id, fromId: user.id, type: 'FOLLOW' })

    revalidatePath(`/${target.username}`)
    return { following: true }
  })
}

// ─── Notifications ────────────────────────────────────────────

export async function getNotifications(cursor?: string): Promise<ActionResult<{
  notifications: Array<{ id: string; type: string; from: SafeUser; postId: string | null; postShortCode?: string | null; read: boolean; createdAt: Date }>
  nextCursor: string | null
  unreadCount: number
}>> {
  return withResult(async () => {
    const user = await requireUser()
    const { getNotificationsPage, getUnreadNotificationCount } = await import('@/lib/services/notify.service')
    const [page, unreadCount] = await Promise.all([
      getNotificationsPage(user.id, cursor),
      getUnreadNotificationCount(user.id),
    ])
    return { notifications: page.notifications, nextCursor: page.nextCursor, unreadCount }
  })
}

export async function markNotificationsRead(): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()
    await prisma.notification.updateMany({
      where: { userId: user.id, read: false },
      data: { read: true },
    })
    revalidatePath('/notifications')
    return { ok: true }
  })
}

// ─── Messages ─────────────────────────────────────────────────

export async function getConversations(): Promise<ActionResult<{ conversations: SafeConversation[] }>> {
  return withResult(async () => {
    const user = await requireUser()
    const { getConversationListSerialized } = await import('@/lib/services/message.service')
    return getConversationListSerialized(user.id)
  })
}

export async function getMessages(conversationId: string): Promise<ActionResult<{
  conversationId: string
  messages: Array<{ id: string; content: string; createdAt: Date; senderId: string; receiverId: string; sender: SafeUser; receiver: SafeUser }>
}>> {
  return withResult(async () => {
    const user = await requireUser()
    // For client-side pagination we just return the thread from the service.
    // The service handles access control + mark-as-read.
    const { getConversationThread } = await import('@/lib/services/message.service')
    const { otherUser, messages } = await getConversationThread(conversationId, user.id)
    if (!otherUser) throw new ActionError('NOT_FOUND', 'Conversation not found.')

    // Service returns lightweight message objects; client needs sender/receiver SafeUser
    const { getUserById } = await import('@/lib/services/user.service')
    const currentUserData = await getUserById(user.id)
    const messagesWithUsers = messages.map((m) => ({
      ...m,
      sender: m.senderId === user.id ? currentUserData! : otherUser,
      receiver: m.senderId === user.id ? otherUser : currentUserData!,
    }))

    return { conversationId, messages: messagesWithUsers }
  })
}

export async function sendMessage(conversationId: string, content: string): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    const trimmed = content.trim()
    if (!trimmed) throw new ActionError('BAD_REQUEST', 'Message is required.')
    if (trimmed.length > 4000) throw new ActionError('BAD_REQUEST', 'Message is too long.')

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, user1Id: true, user2Id: true },
    })
    if (!conv) throw new ActionError('NOT_FOUND', 'Conversation not found.')
    if (conv.user1Id !== user.id && conv.user2Id !== user.id) {
      throw new ActionError('FORBIDDEN', 'Access denied.')
    }

    const receiverId = conv.user1Id === user.id ? conv.user2Id : conv.user1Id

    if (!canDirectMessage(user)) {
      const followsMe = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: receiverId, followingId: user.id } },
        select: { id: true },
      })
      if (!followsMe) throw new ActionError('FORBIDDEN', 'You can only message users who follow you.')
    }

    await prisma.$transaction(async (tx) => {
      await tx.directMessage.create({
        data: { conversationId: conv.id, senderId: user.id, receiverId, content: trimmed },
      })
      await tx.conversation.update({
        where: { id: conv.id },
        data: { lastAt: new Date(), deletedBy1: false, deletedBy2: false },
      })
    })

    await upsertNotification({ userId: receiverId, fromId: user.id, type: 'MESSAGE' })

    revalidatePath('/messages')
    return { ok: true }
  })
}

export async function startConversation(recipientId: string, content: string): Promise<ActionResult<{ conversationId: string }>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    const trimmed = content.trim()
    if (!recipientId) throw new ActionError('BAD_REQUEST', 'Recipient is required.')
    if (!trimmed) throw new ActionError('BAD_REQUEST', 'Message is required.')
    if (trimmed.length > 4000) throw new ActionError('BAD_REQUEST', 'Message is too long.')
    if (recipientId === user.id) throw new ActionError('BAD_REQUEST', 'Cannot message yourself.')

    const recipient = await prisma.user.findUnique({ where: { id: recipientId }, select: { id: true } })
    if (!recipient) throw new ActionError('NOT_FOUND', 'User not found.')

    if (!canDirectMessage(user)) {
      const followsMe = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: recipientId, followingId: user.id } },
        select: { id: true },
      })
      if (!followsMe) throw new ActionError('FORBIDDEN', 'You can only message users who follow you.')
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
        data: { conversationId: conv.id, senderId: user.id, receiverId: recipientId, content: trimmed },
      })
      return conv
    })

    await upsertNotification({ userId: recipientId, fromId: user.id, type: 'MESSAGE' })

    revalidatePath('/messages')
    return { conversationId: result.id }
  })
}

export async function deleteConversation(conversationId: string): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { user1Id: true, user2Id: true },
    })
    if (!conv) throw new ActionError('NOT_FOUND', 'Conversation not found.')
    if (conv.user1Id !== user.id && conv.user2Id !== user.id) {
      throw new ActionError('FORBIDDEN', 'Access denied.')
    }

    const data = conv.user1Id === user.id ? { deletedBy1: true } : { deletedBy2: true }
    await prisma.conversation.update({ where: { id: conversationId }, data })

    revalidatePath('/messages')
    return { ok: true }
  })
}

// ─── Reports ──────────────────────────────────────────────────

const VALID_REASONS = new Set([
  'spam', 'harassment', 'misinformation', 'illegal_substance',
  'scam_fraud', 'impersonation', 'other',
])

export async function submitReport(input: {
  targetType: 'POST' | 'USER'
  targetId: string
  reason: string
  detail?: string
}): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()

    const { targetType, targetId, reason } = input
    const clampedDetail = input.detail ? input.detail.trim().slice(0, 500) : null

    if (!targetType || !targetId || !reason) throw new ActionError('BAD_REQUEST', 'Missing required fields.')
    if (targetType !== 'POST' && targetType !== 'USER') throw new ActionError('BAD_REQUEST', 'Invalid target type.')
    if (!VALID_REASONS.has(reason)) throw new ActionError('BAD_REQUEST', 'Invalid reason.')

    let reportedUserId: string
    let postId: string | null = null

    if (targetType === 'POST') {
      const post = await prisma.post.findUnique({ where: { id: targetId }, select: { authorId: true } })
      if (!post) throw new ActionError('NOT_FOUND', 'Post not found.')
      reportedUserId = post.authorId
      postId = targetId
    } else {
      const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } })
      if (!target) throw new ActionError('NOT_FOUND', 'User not found.')
      reportedUserId = target.id
    }

    if (reportedUserId === user.id) throw new ActionError('BAD_REQUEST', 'Cannot report yourself.')

    const existing = await prisma.report.findFirst({
      where: {
        reporterId: user.id,
        targetType: targetType as 'POST' | 'USER',
        ...(postId ? { postId } : { postId: null, reportedUserId }),
        status: 'PENDING',
      },
    })

    if (existing) {
      await prisma.report.update({ where: { id: existing.id }, data: { reason, detail: clampedDetail } })
    } else {
      await prisma.report.create({
        data: {
          reporterId: user.id,
          targetType: targetType as 'POST' | 'USER',
          postId,
          reportedUserId,
          reason,
          detail: clampedDetail,
        },
      })
    }

    return { ok: true }
  })
}
