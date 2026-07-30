'use server'

import { prisma } from '@/lib/db'

import { getCurrentUser } from '@/lib/auth'
import { postInclude, serializePost } from '@/lib/serialize'
import { countNewPosts, type FeedFilter } from '@/lib/feed'

import { maxPostLength } from '@/lib/permissions'
import { generateShortCode } from '@/lib/shortCode'
import { upsertNotification } from '@/lib/notification'
import { extractCASNumber, extractMentions } from '@/lib/utils'
import { revalidatePath } from 'next/cache'
import type { SafePost } from '@/lib/types'
import { ActionResult, ActionError, assertCanWrite } from './_shared'
import { withResult, requireUser } from './_guards'
import { getTimelinePage, getPostById } from '@/lib/services/post.service'

const MAX_IMAGES = 4
const CAS_FORMAT = /^\d{2,7}-\d{2}-\d$/
const EDIT_WINDOW_MS = 60 * 60 * 1000 // 60 minutes

// ─── Types ────────────────────────────────────────────────────

export interface TimelineParams {
  tab: 'latest' | 'following' | 'foryou'
  cursor?: string
  take?: number
  cas?: string
  author?: string
  scope?: 'replies' | 'media' | undefined
  likedBy?: string
  bookmarkedBy?: string
  repliesOf?: string
  conversationOf?: string
  exclude?: string[]
  since?: string
}

export interface TimelineResult {
  posts: SafePost[]
  nextCursor: string | null
}

export interface CreatePostInput {
  content: string
  parentId?: string | null
  quotePostId?: string | null
  casNumbers?: string[]
  images?: string[] // /uploads/ URLs from prior upload step
}

// ─── Read Actions ─────────────────────────────────────────────

/**
 * Fetch a page of posts from the timeline.
 * Delegates to post.service.getTimelinePage — single source of truth.
 */
export async function getTimeline(params: TimelineParams): Promise<ActionResult<TimelineResult>> {
  return withResult(async () => {
    const user = await getCurrentUser()
    const page = await getTimelinePage({
      tab: params.tab,
      cursor: params.cursor,
      take: params.take,
      userId: user?.id ?? null,
      cas: params.cas,
      author: params.author,
      scope: params.scope,
      likedBy: params.likedBy,
      bookmarkedBy: params.bookmarkedBy,
      repliesOf: params.repliesOf,
      conversationOf: params.conversationOf,
      exclude: params.exclude,
      since: params.since,
    })
    return { posts: page.posts, nextCursor: page.nextCursor }
  })
}

/**
 * Count new posts since a timestamp — for the "N new posts" banner.
 */
export async function getNewPostCount(since: string, tab: string): Promise<ActionResult<{ count: number }>> {
  return withResult(async () => {
    if (!since) return { count: 0 }
    const sinceDate = new Date(since)
    if (isNaN(sinceDate.getTime())) return { count: 0 }

    const user = await getCurrentUser()
    const filter: FeedFilter = { parentId: 'root' }

    if (tab === 'following') {
      if (!user) return { count: 0 }
      filter.followingOf = user.id
    }

    const count = await countNewPosts({ since: sinceDate, filter, excludeAuthorId: user?.id })
    return { count }
  })
}

/**
 * Get a single post — delegates to post.service.getPostById.
 */
export async function getPost(postId: string): Promise<ActionResult<SafePost>> {
  return withResult(async () => {
    const user = await getCurrentUser()
    const post = await getPostById(postId, user?.id)
    if (!post) throw new ActionError('NOT_FOUND', 'Post not found.')
    return post
  })
}

// ─── Write Actions ────────────────────────────────────────────

/**
 * Create a post (top-level, reply, or quote).
 * Image upload is handled separately — pass URLs here.
 */
export async function createPost(input: CreatePostInput): Promise<ActionResult<SafePost>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    const content = input.content.trim()

    // Validation
    if (!content && (!input.images || input.images.length === 0) && !input.quotePostId) {
      throw new ActionError('BAD_REQUEST', 'Content is required.')
    }
    if (!content && input.quotePostId) {
      throw new ActionError('BAD_REQUEST', 'Quote posts require text.')
    }
    const limit = maxPostLength(user)
    if (content.length > limit) {
      throw new ActionError('BAD_REQUEST', `Content too long (max ${limit} characters)`)
    }

    const imageUrls = (input.images ?? []).filter((u) => u.startsWith('/uploads/')).slice(0, MAX_IMAGES)

    // Parent + conversation resolution
    const parentId = input.parentId || null
    let conversationId: string | null = null
    if (parentId) {
      const parent = await prisma.post.findUnique({
        where: { id: parentId },
        select: { id: true, conversationId: true },
      })
      if (!parent) throw new ActionError('NOT_FOUND', 'Parent post not found.')
      conversationId = parent.conversationId ?? parent.id
    }

    // Quote validation
    const quotePostId = input.quotePostId || null
    if (quotePostId) {
      const quoted = await prisma.post.findUnique({ where: { id: quotePostId }, select: { id: true } })
      if (!quoted) throw new ActionError('NOT_FOUND', 'Quoted post not found.')
    }

    // CAS numbers: manual + auto-extracted
    const allCas = new Set<string>()
    for (const cas of input.casNumbers ?? []) {
      if (CAS_FORMAT.test(cas)) allCas.add(cas)
    }
    if (content) {
      const extracted = extractCASNumber(content)
      if (extracted) allCas.add(extracted)
    }

    // Atomic transaction
    const post = await prisma.$transaction(async (tx) => {
      const chemicalConnect: { casNumber: string }[] = []
      for (const casNumber of allCas) {
        await tx.chemical.upsert({ where: { casNumber }, create: { casNumber }, update: {} })
        chemicalConnect.push({ casNumber })
      }

      const created = await tx.post.create({
        data: {
          authorId: user.id,
          parentId,
          conversationId,
          quotePostId,
          content,
          images: imageUrls,
          shortCode: generateShortCode(),
          chemicals: { connect: chemicalConnect },
        },
        include: postInclude(user.id),
      })

      for (const casNumber of allCas) {
        await tx.chemical.update({ where: { casNumber }, data: { postCount: { increment: 1 } } })
      }

      if (parentId) {
        await tx.post.update({ where: { id: parentId }, data: { replyCount: { increment: 1 } } })
      }

      // Maintain denormalized User.postCount
      await tx.user.update({ where: { id: user.id }, data: { postCount: { increment: 1 } } })

      return created
    })

    // Notifications (fire-and-forget)
    if (parentId) {
      const parent = await prisma.post.findUnique({ where: { id: parentId }, select: { authorId: true } })
      if (parent && parent.authorId !== user.id) {
        await upsertNotification({ userId: parent.authorId, fromId: user.id, type: 'COMMENT', postId: parentId })
      }
    }
    if (quotePostId) {
      const quoted = await prisma.post.findUnique({ where: { id: quotePostId }, select: { authorId: true } })
      if (quoted && quoted.authorId !== user.id) {
        await upsertNotification({ userId: quoted.authorId, fromId: user.id, type: 'REPOST', postId: post.id })
      }
    }
    if (content) {
      const usernames = extractMentions(content)
      if (usernames.length > 0) {
        const mentioned = await prisma.user.findMany({ where: { username: { in: usernames } }, select: { id: true } })
        for (const u of mentioned) {
          if (u.id !== user.id) {
            await upsertNotification({ userId: u.id, fromId: user.id, type: 'MENTION', postId: post.id })
          }
        }
      }
    }

    revalidatePath('/')
    return serializePost(post)
  })
}

/**
 * Edit own post (author only, within 60-minute window).
 */
export async function updatePost(
  postId: string,
  content: string,
  keepImages: string[],
  casNumbers?: string[] | null,
): Promise<ActionResult<SafePost>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, createdAt: true },
    })
    if (!post) throw new ActionError('NOT_FOUND', 'Post not found.')
    if (post.authorId !== user.id) throw new ActionError('FORBIDDEN', 'You can only edit your own posts.')

    const elapsed = Date.now() - new Date(post.createdAt).getTime()
    if (elapsed > EDIT_WINDOW_MS) throw new ActionError('FORBIDDEN', 'Edit window has expired.')

    const trimmed = content.trim()
    const finalImages = keepImages.filter((u) => u.startsWith('/uploads/')).slice(0, MAX_IMAGES)

    if (trimmed.length === 0 && finalImages.length === 0) {
      throw new ActionError('BAD_REQUEST', 'Content is required.')
    }
    const limit = maxPostLength(user)
    if (trimmed.length > limit) {
      throw new ActionError('BAD_REQUEST', `Content too long (max ${limit} characters)`)
    }

    // Single transaction: edit + chemical re-tagging + Chemical.postCount diff.
    // If casNumbers is provided, diff old vs new tags and maintain counts.
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.post.update({
        where: { id: postId },
        data: { content: trimmed, images: finalImages, editedAt: new Date() },
        include: postInclude(user.id),
      })

      if (casNumbers) {
        const validCas = casNumbers.filter((c) => CAS_FORMAT.test(c))
        const oldCas = result.chemicals.map((c) => c.casNumber)
        const newSet = new Set(validCas)
        const oldSet = new Set(oldCas)
        const toAdd = validCas.filter((c) => !oldSet.has(c))
        const toRemove = oldCas.filter((c) => !newSet.has(c))

        // Upsert new chemicals + connect
        for (const casNumber of toAdd) {
          await tx.chemical.upsert({ where: { casNumber }, create: { casNumber }, update: {} })
        }
        await tx.post.update({
          where: { id: postId },
          data: { chemicals: { set: validCas.map((c) => ({ casNumber: c })) } },
        })
        for (const casNumber of toAdd) {
          await tx.chemical.update({ where: { casNumber }, data: { postCount: { increment: 1 } } })
        }
        for (const casNumber of toRemove) {
          await tx.chemical.update({ where: { casNumber }, data: { postCount: { decrement: 1 } } })
        }
      }

      return result
    })

    revalidatePath('/')
    return serializePost(updated)
  })
}

/**
 * Soft-delete own post (or admin deletes any post).
 */
export async function deletePost(postId: string): Promise<ActionResult<{ success: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, parentId: true, chemicals: { select: { casNumber: true } } },
    })
    if (!post) throw new ActionError('NOT_FOUND', 'Post not found.')
    if (post.authorId !== user.id && user.role !== 'admin') {
      throw new ActionError('FORBIDDEN', 'You can only delete your own posts.')
    }

    await prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: { deletedAt: new Date(), content: '', images: [], chemicals: { set: [] } },
      })
      if (post.parentId) {
        await tx.post.update({ where: { id: post.parentId }, data: { replyCount: { decrement: 1 } } })
      }
      // Maintain denormalized User.postCount
      await tx.user.update({ where: { id: post.authorId }, data: { postCount: { decrement: 1 } } })
      // Maintain Chemical.postCount for each detached chemical
      for (const chem of post.chemicals) {
        await tx.chemical.update({ where: { casNumber: chem.casNumber }, data: { postCount: { decrement: 1 } } })
      }
    })

    revalidatePath('/')
    return { success: true }
  })
}

/**
 * Toggle like on a post (creates LIKE notification, not for own post).
 */
export async function toggleLike(postId: string): Promise<ActionResult<{ liked: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } })
    if (!post) throw new ActionError('NOT_FOUND', 'Post not found.')

    const existing = await prisma.like.findUnique({ where: { postId_userId: { postId, userId: user.id } } })

    if (existing) {
      // deleteMany + count guard prevents underflow on concurrent/raced deletes.
      await prisma.$transaction(async (tx) => {
        const deleted = await tx.like.deleteMany({ where: { id: existing.id } })
        if (deleted.count > 0) {
          await tx.post.update({ where: { id: postId }, data: { likeCount: { decrement: 1 } } })
        }
      })
      return { liked: false }
    }

    try {
      await prisma.$transaction([
        prisma.like.create({ data: { postId, userId: user.id } }),
        prisma.post.update({ where: { id: postId }, data: { likeCount: { increment: 1 } } }),
      ])
    } catch (e: unknown) {
      if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) throw e
    }

    if (post.authorId !== user.id) {
      await upsertNotification({ userId: post.authorId, fromId: user.id, type: 'LIKE', postId })
    }

    return { liked: true }
  })
}

/**
 * Toggle repost on a post. Creates both a Repost record AND a timeline Post entry.
 */
export async function toggleRepost(postId: string): Promise<ActionResult<{ reposted: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } })
    if (!post) throw new ActionError('NOT_FOUND', 'Post not found.')

    const existing = await prisma.repost.findUnique({ where: { postId_userId: { postId, userId: user.id } } })

    if (existing) {
      // Interactive tx so we can guard decrements on deleteMany results.
      await prisma.$transaction(async (tx) => {
        await tx.repost.delete({ where: { id: existing.id } })
        const deleted = await tx.post.deleteMany({ where: { authorId: user.id, quotePostId: postId, content: '' } })
        if (deleted.count > 0) {
          await tx.post.update({ where: { id: postId }, data: { repostCount: { decrement: 1 } } })
          await tx.user.update({ where: { id: user.id }, data: { postCount: { decrement: 1 } } })
        }
      })
      revalidatePath('/')
      return { reposted: false }
    }

    await prisma.$transaction([
      prisma.repost.create({ data: { postId, userId: user.id } }),
      prisma.post.create({
        data: {
          authorId: user.id,
          content: '',
          quotePostId: postId,
          images: [],
          shortCode: generateShortCode(),
        },
      }),
      prisma.post.update({ where: { id: postId }, data: { repostCount: { increment: 1 } } }),
      prisma.user.update({ where: { id: user.id }, data: { postCount: { increment: 1 } } }),
    ])

    if (post.authorId !== user.id) {
      await upsertNotification({ userId: post.authorId, fromId: user.id, type: 'REPOST', postId })
    }

    revalidatePath('/')
    return { reposted: true }
  })
}

/**
 * Toggle bookmark on a post (no notification).
 */
export async function toggleBookmark(postId: string): Promise<ActionResult<{ bookmarked: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } })
    if (!post) throw new ActionError('NOT_FOUND', 'Post not found.')

    const existing = await prisma.bookmark.findUnique({ where: { postId_userId: { postId, userId: user.id } } })

    if (existing) {
      // deleteMany + count guard prevents underflow on concurrent/raced deletes.
      await prisma.$transaction(async (tx) => {
        const deleted = await tx.bookmark.deleteMany({ where: { id: existing.id } })
        if (deleted.count > 0) {
          await tx.post.update({ where: { id: postId }, data: { bookmarkCount: { decrement: 1 } } })
        }
      })
      return { bookmarked: false }
    }

    try {
      await prisma.$transaction([
        prisma.bookmark.create({ data: { postId, userId: user.id } }),
        prisma.post.update({ where: { id: postId }, data: { bookmarkCount: { increment: 1 } } }),
      ])
    } catch (e: unknown) {
      if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) throw e
    }

    return { bookmarked: true }
  })
}

/**
 * Increment view count — deduped per user via PostView table.
 */
export async function incrementView(postId: string): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const user = await getCurrentUser().catch(() => null)

    if (user) {
      try {
        await prisma.postView.create({ data: { postId, userId: user.id } })
        await prisma.$executeRaw`UPDATE "Post" SET views = views + 1 WHERE id = ${postId}`
          .catch((e) => console.error('View increment error:', e))
      } catch (e: unknown) {
        if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) {
          console.error('PostView create error:', e)
        }
      }
    } else {
      await prisma.$executeRaw`UPDATE "Post" SET views = views + 1 WHERE id = ${postId}`
        .catch((e) => console.error('View increment error:', e))
    }

    return { ok: true }
  })
}
