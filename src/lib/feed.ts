import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { postInclude } from '@/lib/serialize'

/**
 * Unified post feed layer. Every post-list query in the app goes through
 * `getFeed()`. No call site writes its own `prisma.post.findMany`.
 *
 * Two sort strategies, each with matching cursor semantics so pagination
 * never produces duplicates or gaps:
 *
 *  `latest` — pure chronological (createdAt DESC). Cursor = last item's
 *  createdAt; next page queries `createdAt < cursor`. Because the sort key
 *  IS the cursor key, overlap is impossible.
 *
 *  `recommended` — engagement-ranked first page (30-day window), then
 *  chronological tail. The first page's `nextCursor` is set to
 *  `MIN(createdAt)` of the returned posts — NOT the last item in ranked
 *  order. This guarantees Phase 2 (`createdAt < MIN`) can never re-fetch
 *  a first-page post, regardless of how engagement reshuffles createdAt.
 */

// ─── Constants ───────────────────────────────────────────────

/** Re-exported so server-side files importing from '@/lib/feed' still resolve.
 *  Client components MUST import directly from '@/lib/feed-constants' to avoid
 *  pulling Prisma (@prisma/client, @/lib/db) into the client bundle. */
export { FEED_PAGE_SIZE } from './feed-constants'

// ─── Types ───────────────────────────────────────────────────

/** Fully-typed Post with the standard `postInclude(userId)` relations. */
export type FeedPost = Prisma.PostGetPayload<{
  include: ReturnType<typeof postInclude>
}>

/** Resolve the set of user IDs that `followerId` is following.
 *  Returns `['__none__']` when the user follows no one, so Prisma's
 *  `authorId: { in: ids }` matches nothing instead of everything. */
async function resolveFollowingIds(followerId: string): Promise<string[]> {
  const following = await prisma.follow.findMany({
    where: { followerId },
    select: { followingId: true },
  })
  const ids = following.map((f) => f.followingId)
  return ids.length ? ids : ['__none__']
}

export type FeedSort = 'latest' | 'recommended'

export interface FeedFilter {
  /** Posts by this author (user profile pages). */
  authorId?: string
  /** Posts by people this user follows (Following timeline). Resolved internally. */
  followingOf?: string
  /** Posts with this CAS number (CAS pages). */
  casNumber?: string
  /** Posts that are direct replies to this parent post ID (post detail page). */
  childOf?: string
  /** All posts in a conversation (flat — includes replies-to-replies).
   *  Value = conversation root post ID. Used by post-detail reply list. */
  conversationOf?: string
  /** Post IDs to exclude from results (e.g. posts already shown in thread chain). */
  excludeIds?: string[]
  /** `'root'` = top-level posts only; `'reply'` = any reply. */
  parentId?: 'root' | 'reply'
  /** Only posts with at least one image (profile Media tab). */
  hasImages?: boolean
  /** Posts bookmarked by this user (Bookmarks page). */
  bookmarkedBy?: string
}

export interface FeedQuery {
  sort: FeedSort
  filter?: FeedFilter
  /** ISO timestamp of the pagination boundary. */
  cursor?: string
  /** Max posts to return (callers should clamp 1–50). */
  take: number
  /** Current user ID — passed to `postInclude` for interaction state. */
  userId?: string
  /** Sort direction. Default `'desc'` (newest first, standard feed).
   *  `'asc'` = oldest first, used for post-detail replies (Twitter-style). */
  order?: 'asc' | 'desc'
  /** Deduplicate by author — each author appears at most once per page.
   *  Used by the "latest" timeline to prevent spam. */
  dedupeByAuthor?: boolean
}

export interface FeedResult {
  posts: FeedPost[]
  nextCursor: string | null
}

// ─── Public API ──────────────────────────────────────────────

export async function getFeed(query: FeedQuery): Promise<FeedResult> {
  const { sort, cursor, take, userId, filter = {}, order, dedupeByAuthor } = query

  // Recommended Phase 1: engagement-ranked first page (no cursor).
  if (sort === 'recommended' && !cursor) {
    return recommendedFirstPage(userId, take)
  }

  // Everything else: chronological with cursor + filter.
  // Recommended Phase 2 (cursor present) always restricts to root posts,
  // matching the Phase 1 SQL's `parentId IS NULL`.
  return chronologicalPage({
    userId,
    take,
    cursor,
    order: order ?? 'desc',
    filter: sort === 'recommended' ? { ...filter, parentId: 'root' } : filter,
    dedupeByAuthor,
  })
}

// ─── Recommended — first page only ───────────────────────────

/**
 * Engagement-ranked first page from a 30-day candidate window.
 *
 * Score = engagement × recency_mult (× follow_mult when logged in).
 * If the window yields fewer posts than requested, the remainder is
 * filled chronologically so the first page is always full.
 *
 * `nextCursor` = MIN(createdAt) of all returned posts, ensuring the
 * chronological Phase 2 starts strictly before the oldest recommended
 * post — zero overlap.
 */
async function recommendedFirstPage(
  userId: string | undefined,
  take: number,
): Promise<FeedResult> {
  try {
    const ranked: { id: string }[] = userId
      ? await prisma.$queryRawUnsafe(RECOMMENDED_SQL_WITH_FOLLOWING, userId, take)
      : await prisma.$queryRawUnsafe(RECOMMENDED_SQL_ANONYMOUS, take)

    const ids = (ranked as { id: string }[]).map((r) => r.id)

    if (ids.length === 0) {
      return chronologicalPage({ userId, take, order: 'desc', filter: { parentId: 'root' } })
    }

    const posts = await prisma.post.findMany({
      where: { id: { in: ids }, deletedAt: null },
      include: postInclude(userId),
    })

    // Re-sort to match the ranked order from SQL.
    const orderMap = new Map(ids.map((id, i) => [id, i]))
    posts.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0))

    // If the 30-day window was smaller than `take`, pad with chronological
    // posts older than the oldest recommended post.
    if (posts.length < take) {
      const oldestPost = posts.reduce((a, b) => (a.createdAt < b.createdAt ? a : b))
      const fill = await chronologicalPage({
        userId,
        take: take - posts.length,
        cursor: `${oldestPost.createdAt.toISOString()}|${oldestPost.id}`,
        order: 'desc',
        filter: { parentId: 'root' },
      })
      return {
        posts: [...posts, ...fill.posts],
        nextCursor: fill.nextCursor,
      }
    }

    return { posts, nextCursor: minCreatedAt(posts).toISOString() }
  } catch (e) {
    console.error('recommendedFirstPage error, falling back to chronological:', e)
    return chronologicalPage({ userId, take, order: 'desc', filter: { parentId: 'root' } })
  }
}

const minCreatedAt = (posts: FeedPost[]): Date =>
  posts.reduce((min, p) => (p.createdAt < min ? p.createdAt : min), posts[0].createdAt)

// ─── Chronological page ──────────────────────────────────────

interface ChronoParams {
  userId?: string
  take: number
  cursor?: string
  order: 'asc' | 'desc'
  filter: FeedFilter
  dedupeByAuthor?: boolean
}

async function chronologicalPage(params: ChronoParams): Promise<FeedResult> {
  const { userId, take, cursor, order, filter, dedupeByAuthor } = params
  const where: Prisma.PostWhereInput = { deletedAt: null }

  if (filter.parentId === 'root') where.parentId = null
  else if (filter.parentId === 'reply') where.parentId = { not: null }
  if (filter.childOf) where.parentId = filter.childOf
  if (filter.conversationOf) where.conversationId = filter.conversationOf
  if (filter.excludeIds && filter.excludeIds.length > 0) {
    where.id = { notIn: filter.excludeIds }
  }

  // Author filter: followingOf (resolved async) takes priority over authorId.
  if (filter.followingOf) {
    where.authorId = { in: await resolveFollowingIds(filter.followingOf) }
  } else if (filter.authorId) {
    where.authorId = filter.authorId
  }

  if (filter.casNumber) where.chemicals = { some: { casNumber: filter.casNumber } }
  if (filter.hasImages) where.NOT = { images: { isEmpty: true } }

  // ── Author dedup (anti-spam): each author appears at most once per page.
  //    Only applies to the generic latest feed (root posts, no author/CAS/
  //    bookmark filter). Uses a windowed approach: fetch recent posts via
  //    the createdAt index, then deduplicate in application code.
  if (dedupeByAuthor && !filter.bookmarkedBy && !filter.authorId && !filter.casNumber) {
    return dedupedByAuthorPage({ userId, take, cursor, order, filter })
  }

  // Bookmarks: join table ordering (Bookmark.createdAt), not Post.createdAt.
  // Can't use a simple where-clause like the other filters.
  if (filter.bookmarkedBy) {
    const bookmarks = await prisma.bookmark.findMany({
      where: {
        userId: filter.bookmarkedBy,
        post: { deletedAt: null },
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: { createdAt: true, post: { include: postInclude(userId) } },
    })
    const posts = bookmarks.map((b) => b.post)
    const nextCursor =
      bookmarks.length > 0 && bookmarks.length >= take
        ? bookmarks[bookmarks.length - 1].createdAt.toISOString()
        : null
    return { posts, nextCursor }
  }

  // Cursor pagination on (createdAt, id) — compound keyset.
  // Ordering is [{ createdAt: order }, { id: order }], so the cursor must
  // encode both fields to avoid skipping/ repeating posts that share the
  // same createdAt millisecond.
  // Cursor format: "<createdAtISO>|<id>"
  if (cursor) {
    const [cursorDate, cursorId] = cursor.split('|')
    const d = new Date(cursorDate)
    where.OR =
      order === 'desc'
        ? [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: cursorId } }]
        : [{ createdAt: { gt: d } }, { createdAt: d, id: { gt: cursorId } }]
  }

  // For reply queries (profile Replies tab + post-detail conversation),
  // include the parent post's author username so PostCard can show
  // "Replying to @xxx".
  const include =
    filter.parentId === 'reply' || filter.conversationOf
      ? { ...postInclude(userId), parent: { select: { author: { select: { username: true } } } } }
      : postInclude(userId)

  const posts = await prisma.post.findMany({
    where,
    include,
    orderBy: [{ createdAt: order }, { id: order }],
    take,
  })

  const nextCursor =
    posts.length > 0 && posts.length >= take
      ? `${posts[posts.length - 1].createdAt.toISOString()}|${posts[posts.length - 1].id}`
      : null

  return { posts, nextCursor }
}

// ─── Deduped-by-author page (anti-spam for latest feed) ──────

async function dedupedByAuthorPage(params: {
  userId?: string
  take: number
  cursor?: string
  order: 'asc' | 'desc'
  filter: FeedFilter
}): Promise<FeedResult> {
  const { userId, take, cursor, order, filter } = params

  // Windowed approach: fetch up to `take * 5` recent posts using the
  // createdAt index (fast), then deduplicate in application code.
  // This avoids DISTINCT ON scanning the entire 780K-row table.
  const fetchSize = Math.min(take * 5, 200)

  const where: Prisma.PostWhereInput = {
    deletedAt: null,
    parentId: null,
  }

  // Following filter
  if (filter.followingOf) {
    where.authorId = { in: await resolveFollowingIds(filter.followingOf) }
  }

  // Cursor pagination
  if (cursor) {
    const [cursorDate, cursorId] = cursor.split('|')
    const d = new Date(cursorDate)
    where.OR =
      order === 'desc'
        ? [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: cursorId } }]
        : [{ createdAt: { gt: d } }, { createdAt: d, id: { gt: cursorId } }]
  }

  const candidates = await prisma.post.findMany({
    where,
    orderBy: [{ createdAt: order }, { id: order }],
    take: fetchSize,
    include: postInclude(userId),
  })

  // Application-level dedup: keep first post per authorId
  const seen = new Set<string>()
  const posts: FeedPost[] = []
  for (const post of candidates) {
    if (!seen.has(post.authorId)) {
      seen.add(post.authorId)
      posts.push(post)
    }
    if (posts.length >= take) break
  }

  // If we didn't get enough unique authors from the window,
  // fall back to including duplicates (better to show content than nothing).
  if (posts.length < take && candidates.length > posts.length) {
    for (const post of candidates) {
      if (!posts.includes(post)) {
        posts.push(post)
        if (posts.length >= take) break
      }
    }
  }

  const nextCursor =
    candidates.length >= fetchSize && posts.length > 0
      ? `${posts[posts.length - 1].createdAt.toISOString()}|${posts[posts.length - 1].id}`
      : null

  return { posts, nextCursor }
}

// ─── New posts since timestamp ──────────────────────────────

/** Count root posts created after `since`, with optional filters.
 *  Used by the "N new posts" banner polling endpoint.
 *  Excludes posts by the requesting user (self) so their own freshly-created
 *  posts don't trigger the "N new posts" banner. */
export async function countNewPosts(params: {
  since: Date
  filter: FeedFilter
  excludeAuthorId?: string
}): Promise<number> {
  const { since, filter, excludeAuthorId } = params
  const where: Prisma.PostWhereInput = {
    deletedAt: null,
    parentId: null,
    createdAt: { gt: since },
  }

  if (excludeAuthorId) {
    where.authorId = { not: excludeAuthorId }
  }

  if (filter.followingOf) {
    where.authorId = { in: await resolveFollowingIds(filter.followingOf) }
  } else if (filter.authorId) {
    where.authorId = filter.authorId
  }

  return prisma.post.count({ where })
}

/** Fetch root posts created after `since`, newest-first. Used by the
 *  "N new posts" banner click and pull-to-refresh to prepend new content. */
export async function getNewPosts(params: {
  userId?: string
  since: Date
  filter: FeedFilter
  take: number
}): Promise<FeedPost[]> {
  const { userId, since, filter, take } = params
  const where: Prisma.PostWhereInput = {
    deletedAt: null,
    parentId: null,
    createdAt: { gt: since },
  }

  if (filter.followingOf) {
    where.authorId = { in: await resolveFollowingIds(filter.followingOf) }
  } else if (filter.authorId) {
    where.authorId = filter.authorId
  }

  return prisma.post.findMany({
    where,
    include: postInclude(userId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })
}

// ─── Recommended SQL ─────────────────────────────────────────

const RECOMMENDED_SQL_WITH_FOLLOWING = `
  WITH following AS (
    SELECT "followingId" FROM "Follow" WHERE "followerId" = $1
  ),
  scored AS (
    SELECT
      p.id,
      p."createdAt",
      (
        p."likeCount" * 3 +
        p."repostCount" * 4 +
        p."replyCount" * 2 +
        p."bookmarkCount" * 1
      ) AS engagement,
      (
        CASE
          WHEN p."createdAt" > NOW() - INTERVAL '6 hours'  THEN 4.0
          WHEN p."createdAt" > NOW() - INTERVAL '24 hours' THEN 2.0
          WHEN p."createdAt" > NOW() - INTERVAL '72 hours' THEN 1.2
          ELSE 0.5
        END
      ) AS recency_mult,
      CASE WHEN p."authorId" IN (SELECT "followingId" FROM following) THEN 1.5 ELSE 1.0 END AS follow_mult
    FROM "Post" p
    WHERE p."parentId" IS NULL
      AND p."deletedAt" IS NULL
      AND p."createdAt" > NOW() - INTERVAL '30 days'
  )
  SELECT id FROM scored
  ORDER BY
    GREATEST(engagement, 0.01) * recency_mult * follow_mult DESC,
    "createdAt" DESC
  LIMIT $2
`

const RECOMMENDED_SQL_ANONYMOUS = `
  WITH scored AS (
    SELECT
      p.id,
      p."createdAt",
      (
        p."likeCount" * 3 +
        p."repostCount" * 4 +
        p."replyCount" * 2 +
        p."bookmarkCount" * 1
      ) AS engagement,
      (
        CASE
          WHEN p."createdAt" > NOW() - INTERVAL '6 hours'  THEN 4.0
          WHEN p."createdAt" > NOW() - INTERVAL '24 hours' THEN 2.0
          WHEN p."createdAt" > NOW() - INTERVAL '72 hours' THEN 1.2
          ELSE 0.5
        END
      ) AS recency_mult
    FROM "Post" p
    WHERE p."parentId" IS NULL
      AND p."deletedAt" IS NULL
      AND p."createdAt" > NOW() - INTERVAL '30 days'
  )
  SELECT id FROM scored
  ORDER BY
    GREATEST(engagement, 0.01) * recency_mult DESC,
    "createdAt" DESC
  LIMIT $1
`
