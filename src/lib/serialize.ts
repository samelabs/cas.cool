// Helpers to turn Prisma query results into the safe, serializable shapes
// defined in src/lib/types.ts. Kept here so every page renders posts/users
// the exact same way.

import type { SafePost, SafeUser, SafeChemical } from './types'

/** Shared Prisma `select` for the public, client-safe fields of a User. */
export const userSelect = {
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

/** Prisma select for Chemical — only the fields embedded in posts.
 *  name + smiles are deliberately excluded: they're system-maintained
 *  metadata displayed ONLY on the CAS detail page, not in post cards
 *  or search results. Post cards show just the CAS number as a tag. */
export const chemicalSelect = {
  id: true,
  casNumber: true,
  postCount: true,
} as const

/**
 * Shared Prisma `include` for a Post: author + chemicals + engagement
 * counts + the current user's like / repost / bookmark state.
 */
export function postInclude(currentUserId?: string | null) {
  const uid = currentUserId ?? '__no_user__'
  return {
    author: { select: userSelect },
    chemicals: { select: chemicalSelect },
    quotedPost: { include: postIncludeNested(uid) },
    // Engagement counts read from denormalized columns (likeCount, replyCount,
    // repostCount, bookmarkCount) — top-level scalar fields, included by default.
    // No _count subqueries needed (H3/M14).
    likes: { where: { userId: uid }, select: { id: true } },
    reposts: { where: { userId: uid }, select: { id: true } },
    bookmarks: { where: { userId: uid }, select: { id: true } },
  } as const
}

function postIncludeNested(currentUserId?: string | null) {
  const uid = currentUserId ?? '__no_user__'
  return {
    author: { select: userSelect },
    chemicals: { select: chemicalSelect },
    likes: { where: { userId: uid }, select: { id: true } },
    reposts: { where: { userId: uid }, select: { id: true } },
    bookmarks: { where: { userId: uid }, select: { id: true } },
  } as const
}

type RelationArr = { id: string }[] | undefined

interface RawPost {
  id: string
  shortCode?: string | null
  authorId: string
  parentId: string | null
  conversationId?: string | null
  content: string
  quotePostId?: string | null
  images: string[]
  views: number
  // Denormalized engagement counts (H3/M14)
  likeCount: number
  replyCount: number
  repostCount: number
  bookmarkCount: number
  createdAt: Date
  updatedAt?: Date
  editedAt?: Date | null
  deletedAt?: Date | null
  author: SafeUser
  chemicals: SafeChemical[]
  quotedPost?: RawPost | null
  parent?: { author: { username: string } } | null
  likes?: RelationArr
  reposts?: RelationArr
  bookmarks?: RelationArr
}

export function serializePost(p: RawPost): SafePost {
  return {
    id: p.id,
    shortCode: p.shortCode ?? null,
    authorId: p.authorId,
    parentId: p.parentId,
    conversationId: p.conversationId ?? null,
    replyToUsername: p.parent?.author.username ?? null,
    content: p.content,
    quotePostId: p.quotePostId ?? null,
    quotedPost: p.quotedPost ? serializePost(p.quotedPost as RawPost) : null,
    chemicals: p.chemicals ?? [],
    images: p.images ?? [],
    views: p.views,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    editedAt: p.editedAt ?? null,
    deletedAt: p.deletedAt ?? null,
    author: serializeUser(p.author),
    _count: {
      replies: p.replyCount,
      likes: p.likeCount,
      reposts: p.repostCount,
      bookmarks: p.bookmarkCount,
    },
    liked: (p.likes?.length ?? 0) > 0,
    reposted: (p.reposts?.length ?? 0) > 0,
    bookmarked: (p.bookmarks?.length ?? 0) > 0,
  }
}

type RawUser = Omit<SafeUser, '_count'>

export function serializeUser(u: RawUser): SafeUser {
  return {
    ...u,
    _count: {
      posts: u.postCount ?? 0,
      followers: u.followerCount ?? 0,
      following: u.followingCount ?? 0,
    },
  }
}

/** Build a SafeUser[] with _count from a Prisma user query that used userSelect + _count. */
export function serializeUsers(
  users: RawUser[]
): SafeUser[] {
  return users.map(serializeUser)
}
