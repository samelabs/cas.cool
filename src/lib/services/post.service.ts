/**
 * Post service — shared query logic for Server Components and Server Actions.
 *
 * No 'use server' — these are plain async functions callable from both
 * RSC pages (SSR prefetch) and Server Actions (client-triggered reads).
 *
 * All functions return serialized SafePost[] — never raw Prisma objects.
 */

import { cache } from 'react'
import { prisma } from '@/lib/db'
import { postInclude, serializePost } from '@/lib/serialize'
import { getFeed, FEED_PAGE_SIZE, type FeedFilter, type FeedResult } from '@/lib/feed'
import type { SafePost } from '@/lib/types'
import type { Prisma } from '@prisma/client'

export interface FeedPage {
  posts: SafePost[]
  nextCursor: string | null
}

export interface TimelineQuery {
  tab: 'latest' | 'following' | 'foryou'
  cursor?: string
  take?: number
  userId?: string | null
  cas?: string
  author?: string
  scope?: 'replies' | 'media'
  likedBy?: string
  bookmarkedBy?: string
  repliesOf?: string
  conversationOf?: string
  exclude?: string[]
  since?: string
}

// ─── Timeline / Feed ──────────────────────────────────────────

export async function getTimelinePage(params: TimelineQuery): Promise<FeedPage> {
  const user = params.userId ?? null
  const tab = params.tab
  const take = Math.min(Math.max(params.take ?? FEED_PAGE_SIZE, 1), 50)
  const cursor = params.cursor

  // ── Since (new-posts banner) ──
  if (params.since) {
    const sinceDate = new Date(params.since)
    if (!isNaN(sinceDate.getTime())) {
      const filter: FeedFilter = { parentId: 'root' }
      if (tab === 'following' && user) filter.followingOf = user
      const { getNewPosts } = await import('@/lib/feed')
      const newPosts = await getNewPosts({
        userId: user ?? undefined,
        since: sinceDate,
        filter,
        take: Math.min(take, 50),
      })
      return { posts: newPosts.map(serializePost), nextCursor: null }
    }
  }

  // ── Likes tab ──
  if (params.likedBy) {
    const likeWhere: Prisma.LikeWhereInput = { userId: params.likedBy }
    if (cursor) {
      const [cursorDate, cursorId] = cursor.split('|')
      const d = new Date(cursorDate)
      likeWhere.OR = [
        { createdAt: { lt: d } },
        { createdAt: d, id: { lt: cursorId } },
      ]
    }
    const liked = await prisma.like.findMany({
      where: likeWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, createdAt: true, post: { include: postInclude(user ?? undefined) } },
    })
    const posts = liked.map((l) => serializePost(l.post))
    const nextCursor =
      liked.length > 0 && liked.length >= take
        ? `${liked[liked.length - 1].createdAt.toISOString()}|${liked[liked.length - 1].id}`
        : null
    return { posts, nextCursor }
  }

  // ── Bookmarks tab (owner-only) ──
  if (params.bookmarkedBy) {
    if (!user) return { posts: [], nextCursor: null }
    const result = await getFeed({
      sort: 'latest',
      filter: { bookmarkedBy: params.bookmarkedBy },
      cursor, take, userId: user,
    })
    return { posts: result.posts.map(serializePost), nextCursor: result.nextCursor }
  }

  // ── Standard feed tabs ──
  let result: FeedResult

  if (tab === 'following') {
    result = await getFeed({
      sort: 'latest',
      filter: { followingOf: user!, parentId: 'root' },
      cursor, take, userId: user ?? undefined,
    })
  } else if (tab === 'latest') {
    const filter: FeedFilter = { parentId: 'root' }
    if (params.cas) filter.casNumber = params.cas
    if (params.repliesOf) {
      delete filter.parentId
      filter.childOf = params.repliesOf
    }
    if (params.conversationOf) {
      delete filter.parentId
      filter.conversationOf = params.conversationOf
    }
    if (params.exclude && params.exclude.length > 0) filter.excludeIds = params.exclude
    if (params.author) {
      filter.authorId = params.author
      if (params.scope === 'replies') filter.parentId = 'reply'
      else if (params.scope === 'media') filter.hasImages = true
    }
    // Anti-spam: deduplicate by author on the generic latest feed
    // (root posts, no author/CAS/conversation filter). Each author
    // appears at most once per page.
    const isGenericFeed =
      !params.author && !params.cas && !params.repliesOf && !params.conversationOf
    result = await getFeed({
      sort: 'latest',
      filter,
      cursor, take, userId: user ?? undefined,
      order: (params.repliesOf || params.conversationOf) ? 'asc' : undefined,
      dedupeByAuthor: isGenericFeed,
    })
  } else {
    result = await getFeed({
      sort: 'recommended',
      cursor, take, userId: user ?? undefined,
    })
  }

  return { posts: result.posts.map(serializePost), nextCursor: result.nextCursor }
}

// ─── Post Detail + Reply Chain ────────────────────────────────

export async function getPostByShortCode(
  shortCode: string,
  currentUserId?: string | null,
): Promise<SafePost | null> {
  const post = await prisma.post.findUnique({
    where: { shortCode },
    include: postInclude(currentUserId ?? undefined),
  })
  return post ? serializePost(post) : null
}

export async function getPostById(
  postId: string,
  currentUserId?: string | null,
): Promise<SafePost | null> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: postInclude(currentUserId ?? undefined),
  })
  return post ? serializePost(post) : null
}

/**
 * Build the ancestor chain for a reply (root → ... → parent).
 * Two-phase: lightweight id+parentId walk, then hydrate only ancestors.
 */
export async function getPostChain(
  postId: string,
  conversationId: string | null,
  currentUserId?: string | null,
): Promise<SafePost[]> {
  const parentId = conversationId
  if (!parentId) return []

  const convMembers = await prisma.post.findMany({
    where: { OR: [{ conversationId: parentId }, { id: parentId }] },
    select: { id: true, parentId: true },
    orderBy: { createdAt: 'asc' },
  })

  const byId = new Map(convMembers.map((p) => [p.id, p]))
  const ancestorIds: string[] = []
  let cursor = byId.get(postId)
  while (cursor?.parentId) {
    const ancestor = byId.get(cursor.parentId)
    if (!ancestor) break
    ancestorIds.push(ancestor.id)
    cursor = ancestor
  }

  if (ancestorIds.length === 0) return []

  const ancestors = await prisma.post.findMany({
    where: { id: { in: ancestorIds } },
    include: postInclude(currentUserId ?? undefined),
  })

  const ancestorMap = new Map(ancestors.map((p) => [p.id, p]))
  return ancestorIds
    .map((id) => ancestorMap.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map(serializePost)
}

/**
 * Get replies for a post (first page for SSR).
 */
export async function getPostReplies(
  postId: string,
  currentUserId?: string | null,
  limit?: number,
): Promise<FeedPage> {
  const result = await getFeed({
    sort: 'latest',
    filter: { childOf: postId },
    order: 'asc',
    take: limit ?? FEED_PAGE_SIZE,
    userId: currentUserId ?? undefined,
  })
  return { posts: result.posts.map(serializePost), nextCursor: result.nextCursor }
}

/**
 * Check if current user follows a given user.
 */
export const checkFollow = cache(async (
  followerId: string,
  followingId: string,
): Promise<boolean> => {
  const f = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId, followingId } },
    select: { id: true },
  })
  return !!f
})
