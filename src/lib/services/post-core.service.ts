/**
 * Post core — read-side query logic for the product-independent feed:
 * timeline pages, post detail, reply chains, follow checks. Selection,
 * ordering, cursors and viewer interaction state live here; product
 * metadata is attached later by the application layer (post.service.ts).
 *
 * Free of chemical-product imports and fields (pinned by
 * tests/module-boundary.test.ts). All functions return serialized
 * CorePost[] — never raw Prisma objects.
 */

import { cache } from 'react'
import { prisma } from '@/lib/db'
import { postInclude, serializePost } from '@/lib/serialize'
import { normalizePageSize, encodeAncestorCursor, decodeAndValidateAncestorCursor } from '@/lib/pagination'
import { getFeed, getNewPosts, FEED_PAGE_SIZE, type FeedFilter, type FeedResult } from '@/lib/feed'
import type { CorePost } from '@/lib/types'
import type { Prisma } from '@prisma/client'

// ─── Shared service types (used by reads, writes, interactions) ──

export interface ServiceError {
  status: number
  code: string
  message: string
}
export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: ServiceError }

export class PostServiceError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PostServiceError'
    this.status = status
    this.code = code
  }
}

export interface PostActor {
  id: string
  verificationStatus: string
  role: string
}

export interface FeedPage {
  posts: CorePost[]
  nextCursor: string | null
}

export interface TimelineQuery {
  tab: 'latest' | 'following' | 'foryou'
  cursor?: string
  take?: number
  userId?: string | null
  /** Extra product predicate, applied in SQL before keyset pagination
   *  (e.g. the chemical layer's CAS condition — opaque to this module). */
  postWhere?: Prisma.PostWhereInput
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
  const take = normalizePageSize(params.take)
  const cursor = params.cursor

  // ── Since (new-posts banner) ──
  if (params.since) {
    const sinceDate = new Date(params.since)
    if (!isNaN(sinceDate.getTime())) {
      const filter: FeedFilter = { parentId: 'root' }
      if (tab === 'following' && user) filter.followingOf = user
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
    if (!user) {
      throw new PostServiceError(401, 'unauthorized', 'Authentication required to view bookmarks.')
    }
    if (params.bookmarkedBy !== user) {
      throw new PostServiceError(403, 'forbidden', 'You can only view your own bookmarks.')
    }
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
    if (!user) {
      throw new PostServiceError(401, 'unauthorized', 'Authentication required for following timeline.')
    }
    result = await getFeed({
      sort: 'latest',
      filter: { followingOf: user, parentId: 'root' },
      cursor, take, userId: user,
    })
  } else if (tab === 'latest') {
    const filter: FeedFilter = { parentId: 'root' }
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
    // (root posts, no author/product/conversation filter). Each author
    // appears at most once per page.
    const isGenericFeed =
      !params.author && !params.postWhere && !params.repliesOf && !params.conversationOf
    result = await getFeed({
      sort: 'latest',
      filter,
      cursor, take, userId: user ?? undefined,
      order: (params.repliesOf || params.conversationOf) ? 'asc' : undefined,
      dedupeByAuthor: isGenericFeed,
      postWhere: params.postWhere,
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
): Promise<CorePost | null> {
  const post = await prisma.post.findUnique({
    where: { shortCode },
    include: postInclude(currentUserId ?? undefined),
  })
  return post ? serializePost(post) : null
}

export async function getPostById(
  postId: string,
  currentUserId?: string | null,
): Promise<CorePost | null> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: postInclude(currentUserId ?? undefined),
  })
  return post ? serializePost(post) : null
}

export interface PostChainResult {
  ancestors: CorePost[]
  hasMoreAncestors: boolean
  oldestAncestorId: string | null
  nextAncestorCursor: string | null
}

export interface GetPostChainOptions {
  limit?: number
  cursor?: string | null
}

/**
 * Build the ancestor chain for a reply (root → ... → parent).
 * Strictly bounds database query and memory to (limit + 1) rows along
 * the direct parent path, without querying unrelated conversation branches.
 * Supports cursor continuation across soft-deleted boundary posts.
 */
export async function getPostChain(
  postId: string,
  _conversationId?: string | null,
  currentUserId?: string | null,
  options?: GetPostChainOptions,
): Promise<PostChainResult> {
  const limit = Math.max(1, Math.min(50, options?.limit ?? 20))
  let startFromId = postId

  // When a continuation cursor is supplied, cryptographically verify its integrity
  // and ensure it binds strictly to this discussion target (`postId`).
  if (options?.cursor) {
    const verified = decodeAndValidateAncestorCursor(options.cursor, postId)
    if (!verified.ok) {
      throw new PostServiceError(400, 'bad_request', verified.error)
    }
    startFromId = verified.boundaryAncestorId
  }

  const rows = await prisma.$queryRaw<Array<{ id: string; parentId: string | null; depth: number }>>`
    WITH RECURSIVE ancestor_walk AS (
      SELECT id, "parentId", 1 as depth
      FROM "Post"
      WHERE id = (SELECT "parentId" FROM "Post" WHERE id = ${startFromId})

      UNION ALL

      SELECT p.id, p."parentId", aw.depth + 1
      FROM "Post" p
      JOIN ancestor_walk aw ON p.id = aw."parentId"
      WHERE aw.depth < ${limit + 1}
    )
    SELECT id, "parentId", depth FROM ancestor_walk ORDER BY depth ASC;
  `

  if (!rows || rows.length === 0) {
    return {
      ancestors: [],
      hasMoreAncestors: false,
      oldestAncestorId: null,
      nextAncestorCursor: null,
    }
  }

  const hasMoreAncestors = rows.length > limit
  const selectedRows = hasMoreAncestors ? rows.slice(0, limit) : rows
  const oldestAncestorId = selectedRows[selectedRows.length - 1]?.id ?? null
  const nextAncestorCursor = hasMoreAncestors && oldestAncestorId
    ? encodeAncestorCursor(postId, oldestAncestorId)
    : null

  const ancestorIds = selectedRows.map((r) => r.id)
  const ancestors = await prisma.post.findMany({
    where: { id: { in: ancestorIds } },
    include: postInclude(currentUserId ?? undefined),
  })

  const ancestorMap = new Map(ancestors.map((p) => [p.id, p]))
  // Reverse from depth-asc (parent -> root) to chronological order (root -> parent)
  const ordered = ancestorIds
    .reverse()
    .map((id) => ancestorMap.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map(serializePost)

  return {
    ancestors: ordered,
    hasMoreAncestors,
    oldestAncestorId,
    nextAncestorCursor,
  }
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
