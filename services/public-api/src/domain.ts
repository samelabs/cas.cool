import { randomInt } from 'node:crypto'
import type { NotificationType, Prisma } from '@prisma/client'
import { prisma } from './db'

const USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  bio: true,
  avatar: true,
  banner: true,
  location: true,
  website: true,
  role: true,
  verificationStatus: true,
  verifiedAt: true,
  verificationExpiresAt: true,
  status: true,
  createdAt: true,
  postCount: true,
  followerCount: true,
  followingCount: true,
} as const

const CHEMICAL_SELECT = { id: true, casNumber: true, postCount: true } as const

export function postInclude(currentUserId: string) {
  return {
    author: { select: USER_SELECT },
    chemicals: { select: CHEMICAL_SELECT },
    quotedPost: {
      include: {
        author: { select: USER_SELECT },
        chemicals: { select: CHEMICAL_SELECT },
        likes: { where: { userId: currentUserId }, select: { id: true } },
        reposts: { where: { userId: currentUserId }, select: { id: true } },
        bookmarks: { where: { userId: currentUserId }, select: { id: true } },
      },
    },
    likes: { where: { userId: currentUserId }, select: { id: true } },
    reposts: { where: { userId: currentUserId }, select: { id: true } },
    bookmarks: { where: { userId: currentUserId }, select: { id: true } },
  } as const
}

type IncludedPost = Prisma.PostGetPayload<{ include: ReturnType<typeof postInclude> }>

export function serializePost(post: IncludedPost): Record<string, unknown> {
  return {
    id: post.id,
    shortCode: post.shortCode,
    authorId: post.authorId,
    parentId: post.parentId,
    conversationId: post.conversationId,
    replyToUsername: null,
    content: post.content,
    quotePostId: post.quotePostId,
    quotedPost: post.quotedPost ? serializeNestedPost(post.quotedPost) : null,
    chemicals: post.chemicals,
    images: post.images,
    views: post.views,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    editedAt: post.editedAt,
    deletedAt: post.deletedAt,
    author: post.author,
    _count: {
      replies: post.replyCount,
      likes: post.likeCount,
      reposts: post.repostCount,
      bookmarks: post.bookmarkCount,
    },
    liked: post.likes.length > 0,
    reposted: post.reposts.length > 0,
    bookmarked: post.bookmarks.length > 0,
  }
}

type NestedPost = NonNullable<IncludedPost['quotedPost']>

function serializeNestedPost(post: NestedPost): Record<string, unknown> {
  return {
    id: post.id,
    shortCode: post.shortCode,
    authorId: post.authorId,
    parentId: post.parentId,
    conversationId: post.conversationId,
    replyToUsername: null,
    content: post.content,
    quotePostId: post.quotePostId,
    quotedPost: null,
    chemicals: post.chemicals,
    images: post.images,
    views: post.views,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    editedAt: post.editedAt,
    deletedAt: post.deletedAt,
    author: post.author,
    _count: {
      replies: post.replyCount,
      likes: post.likeCount,
      reposts: post.repostCount,
      bookmarks: post.bookmarkCount,
    },
    liked: post.likes.length > 0,
    reposted: post.reposts.length > 0,
    bookmarked: post.bookmarks.length > 0,
  }
}

export function userSelect() {
  return USER_SELECT
}

export function parseTake(raw: string | null): number {
  const parsed = Number.parseInt(raw || '20', 10)
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 20, 1), 50)
}

export function applyCursor(where: Prisma.PostWhereInput, cursor: string | null): void {
  if (!cursor) return
  const separator = cursor.lastIndexOf('|')
  if (separator < 1) return
  const date = new Date(cursor.slice(0, separator))
  const id = cursor.slice(separator + 1)
  if (Number.isNaN(date.getTime()) || !id) return
  where.AND = [
    {
      OR: [
        { createdAt: { lt: date } },
        { createdAt: date, id: { lt: id } },
      ],
    },
  ]
}

export function nextCursor(posts: Array<{ id: string; createdAt: Date }>, take: number): string | null {
  if (posts.length < take || posts.length === 0) return null
  const last = posts[posts.length - 1]
  return `${last.createdAt.toISOString()}|${last.id}`
}

const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ'
export function generateShortCode(): string {
  let code = ''
  for (let index = 0; index < 8; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

const CAS_REGEX = /\b\d{2,7}-\d{2}-\d\b/g
const MENTION_REGEX = /(?:^|[\s/(\[{:;,])@([a-zA-Z0-9_]{1,20})/g
export function extractCasNumbers(content: string): string[] {
  return content.match(CAS_REGEX) || []
}

export function extractMentions(content: string): string[] {
  const usernames = new Set<string>()
  for (const match of content.matchAll(MENTION_REGEX)) {
    usernames.add(match[1].toLowerCase())
    if (usernames.size >= 20) break
  }
  return [...usernames]
}

export async function upsertNotification(params: {
  userId: string
  fromId: string
  type: NotificationType
  postId?: string | null
}): Promise<void> {
  const postId = params.postId ?? null
  try {
    if (postId) {
      await prisma.notification.upsert({
        where: {
          userId_fromId_type_postId: {
            userId: params.userId,
            fromId: params.fromId,
            type: params.type,
            postId,
          },
        },
        update: { read: false, createdAt: new Date() },
        create: { ...params, postId },
      })
      return
    }

    const existing = await prisma.notification.findFirst({
      where: { userId: params.userId, fromId: params.fromId, type: params.type },
      select: { id: true },
    })
    if (existing) {
      await prisma.notification.update({
        where: { id: existing.id },
        data: { read: false, createdAt: new Date() },
      })
    } else {
      await prisma.notification.create({ data: { ...params, postId: null } })
    }
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'notification_upsert_failed', error: String(error) }))
  }
}
