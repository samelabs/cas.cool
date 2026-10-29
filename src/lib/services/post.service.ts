/**
 * Application read service — composes the product-independent post core
 * (`post-core.service.ts`) with the chemical product layer. This is the
 * primary read-side place where CorePosts become the public chemical-community
 * post views (SafePost): CAS page filtering via `chemicalPostWhere`, and
 * per-page batch tag assembly via `attachPostChemicals`.
 */

import {
  getTimelinePage as getCoreTimelinePage,
  getPostByShortCode as getCorePostByShortCode,
  getPostById as getCorePostById,
  getPostChain as getCorePostChain,
  getPostReplies as getCorePostReplies,
} from '@/lib/services/post-core.service'
import { chemicalPostWhere } from '@/lib/chemistry/post-feed'
import { attachPostChemical, attachPostChemicals } from '@/lib/chemistry/post-views'
import type { TimelineQuery as CoreTimelineQuery } from '@/lib/services/post-core.service'
import type { SafePost } from '@/lib/types'

export { checkFollow, PostServiceError } from '@/lib/services/post-core.service'
export type { PostActor, ServiceError, ServiceResult } from '@/lib/services/post-core.service'

export interface FeedPage {
  posts: SafePost[]
  nextCursor: string | null
}

export interface TimelineQuery extends Omit<CoreTimelineQuery, 'postWhere'> {
  /** Posts tagged with this CAS number (CAS pages — Latest selection only). */
  cas?: string
}

// ─── Timeline / Feed ──────────────────────────────────────────

export async function getTimelinePage(params: TimelineQuery): Promise<FeedPage> {
  const { cas, ...coreParams } = params
  // The product predicate is relevant to the CAS page's Latest list;
  // Following and For You keep their own selection semantics.
  const page = await getCoreTimelinePage({
    ...coreParams,
    postWhere: cas && params.tab === 'latest' ? chemicalPostWhere(cas) : undefined,
  })
  return { posts: await attachPostChemicals(page.posts), nextCursor: page.nextCursor }
}

// ─── Post Detail + Reply Chain ────────────────────────────────

export async function getPostByShortCode(
  shortCode: string,
  currentUserId?: string | null,
): Promise<SafePost | null> {
  const post = await getCorePostByShortCode(shortCode, currentUserId)
  return post ? attachPostChemical(post) : null
}

export async function getPostById(
  postId: string,
  currentUserId?: string | null,
): Promise<SafePost | null> {
  const post = await getCorePostById(postId, currentUserId)
  return post ? attachPostChemical(post) : null
}

export async function getPostChain(
  postId: string,
  conversationId: string | null,
  currentUserId?: string | null,
  options?: { limit?: number; cursor?: string | null },
): Promise<{
  ancestors: SafePost[]
  hasMoreAncestors: boolean
  oldestAncestorId: string | null
  nextAncestorCursor: string | null
}> {
  const result = await getCorePostChain(postId, conversationId, currentUserId, options)
  return {
    ancestors: await attachPostChemicals(result.ancestors),
    hasMoreAncestors: result.hasMoreAncestors,
    oldestAncestorId: result.oldestAncestorId,
    nextAncestorCursor: result.nextAncestorCursor,
  }
}

export async function getPostReplies(
  postId: string,
  currentUserId?: string | null,
  limit?: number,
): Promise<FeedPage> {
  const page = await getCorePostReplies(postId, currentUserId, limit)
  return { posts: await attachPostChemicals(page.posts), nextCursor: page.nextCursor }
}
