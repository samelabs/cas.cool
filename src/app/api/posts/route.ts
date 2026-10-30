/**
 * /api/posts
 *
 * GET   — read timeline / feed (list posts)
 * POST  — create post / reply / quote
 *
 * GET Auth: optional (API Key, Session, or anonymous).
 *   Query params mirror `getTimelinePage`:
 *   tab (latest|following|foryou), cursor, take, cas, author, scope
 *   (replies|media), likedBy, bookmarkedBy, repliesOf, conversationOf,
 *   since. Returns { posts, nextCursor }.
 *
 * POST Auth: requireWrite (read-only API keys rejected).
 *   Body (JSON): { content, parentId?, quotePostId?, casNumbers?, images? }
 *
 * HTTP shell only — reads compose in post.service.ts; writes and their
 * transactions compose in post-write.service.ts.
 */

import { after, NextRequest } from 'next/server'
import { drainEnqueuedSideEffects } from '@/lib/services/side-effect.service'
import { requireWrite, resolveIdentity } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { validateTimelineCursor } from '@/lib/pagination'
import { createPost } from '@/lib/services/post-write.service'
import { getTimelinePage, getPostChain, PostServiceError, type ServiceError } from '@/lib/services/post.service'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

/** Feed responses carry per-viewer interaction state (liked/bookmarked) —
 *  they are private, uncacheable data. Without this header a browser may
 *  answer SWR revalidations from a stale copy and the UI never converges. */
function jsonFeed(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...(init?.headers ?? {}), 'Cache-Control': 'private, no-store' },
  })
}

function serviceError(e: ServiceError) {
  return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status })
}

// ── GET /api/posts — read timeline / feed ────────────────────

export async function GET(request: NextRequest) {
  const identity = await resolveIdentity()
  const limited = checkRateLimit(identity, 'read')
  if (limited) return limited
  after(async () => { await drainEnqueuedSideEffects([]) })

  const sp = request.nextUrl.searchParams

  const tabRaw = sp.get('tab')
  const tab =
    tabRaw === 'following' || tabRaw === 'foryou' ? tabRaw : 'latest'

  const cursor = sp.get('cursor') ?? undefined
  const takeRaw = Number(sp.get('take'))
  const take = Number.isFinite(takeRaw) && takeRaw > 0 ? takeRaw : undefined

  const scopeRaw = sp.get('scope')
  const scope = scopeRaw === 'replies' || scopeRaw === 'media' ? scopeRaw : undefined

  const likedBy = sp.get('likedBy') ?? undefined
  const bookmarkedBy = sp.get('bookmarkedBy') ?? undefined
  const since = sp.get('since') ?? undefined
  const cas = sp.get('cas') ?? undefined

  // The chemical predicate is defined for chronological Latest selection.
  // Reject combinations the service cannot apply instead of silently
  // returning an unfiltered feed.
  if (cas && (tab !== 'latest' || likedBy || bookmarkedBy || since)) {
    return jsonError(400, 'bad_request', 'CAS filtering requires a Latest post list.')
  }

  if (bookmarkedBy) {
    if (!identity.authenticated || !identity.user) {
      return jsonError(401, 'unauthorized', 'Authentication required to view bookmarks.')
    }
    if (bookmarkedBy !== identity.user.id) {
      return jsonError(403, 'forbidden', 'You can only view your own bookmarks.')
    }
  }

  if (tab === 'following') {
    if (!identity.authenticated || !identity.user) {
      return jsonError(401, 'unauthorized', 'Authentication required for following timeline.')
    }
  }

  const ancestorsOf = sp.get('ancestorsOf')

  // For You's ranked first page emits a timestamp; its chronological tail
  // and other feeds (including Bookmarks) emit compound keysets. The cursor
  // check must not depend on `since`: an unparseable since is rejected here
  // (it must not silently fall through to the tabs with an unvalidated
  // cursor — that path reaches Prisma with an Invalid Date), and a cursor
  // sent alongside a valid since is ignored by the service but still has to
  // be well-formed.
  if (since && Number.isNaN(new Date(since).getTime())) {
    return jsonError(400, 'bad_request', 'Invalid since.')
  }
  if (cursor && !ancestorsOf) {
    const isSpecial = Boolean(likedBy || bookmarkedBy)
    if (!validateTimelineCursor(cursor, tab, isSpecial)) {
      return jsonError(400, 'bad_request', 'Invalid cursor.')
    }
  }

  if (ancestorsOf) {
    if (cursor && (typeof cursor !== 'string' || cursor.length > 512)) {
      return jsonError(400, 'bad_request', 'Invalid cursor.')
    }
    try {
      const result = await getPostChain(ancestorsOf, null, identity.user?.id ?? null, {
        limit: take,
        cursor: cursor || null,
      })
      return jsonFeed({
        posts: result.ancestors,
        nextCursor: result.nextAncestorCursor,
        hasMoreAncestors: result.hasMoreAncestors,
      })
    } catch (err: unknown) {
      if (err instanceof PostServiceError) {
        return jsonError(err.status, err.code, err.message)
      }
      throw err
    }
  }

  try {
    const page = await getTimelinePage({
      tab,
      cursor,
      take,
      userId: identity.user?.id ?? null,
      cas,
      author: sp.get('author') ?? undefined,
      scope,
      likedBy,
      bookmarkedBy,
      repliesOf: sp.get('repliesOf') ?? undefined,
      conversationOf: sp.get('conversationOf') ?? undefined,
      since,
    })

    return jsonFeed({ posts: page.posts, nextCursor: page.nextCursor })
  } catch (err: unknown) {
    if (err instanceof PostServiceError) {
      return jsonError(err.status, err.code, err.message)
    }
    throw err
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError(400, 'bad_request', 'Invalid JSON.')

  const result = await createPost(
    { id: auth.identity.user!.id, verificationStatus: auth.identity.user!.verificationStatus, role: auth.identity.user!.role },
    {
      content: typeof body.content === 'string' ? body.content.trim() : '',
      parentId: typeof body.parentId === 'string' && body.parentId ? body.parentId : null,
      quotePostId: typeof body.quotePostId === 'string' && body.quotePostId ? body.quotePostId : null,
      images: Array.isArray(body.images)
        ? body.images.filter((u: unknown) => typeof u === 'string' && u.startsWith('/uploads/'))
        : [],
      casNumbers: Array.isArray(body.casNumbers)
        ? body.casNumbers
        : typeof body.casNumbers === 'string'
          ? body.casNumbers
          : null,
    },
  )
  if (!result.ok) return serviceError(result.error)
  return Response.json(result.data, { status: 201, headers: { 'Cache-Control': 'private, no-store' } })
}
