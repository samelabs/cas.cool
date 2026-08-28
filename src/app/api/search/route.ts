/**
 * GET /api/search?q=<query>&cursor=<cursor>&take=<n>
 *
 * Cursor-paginated post search — the client-side endpoint behind the explore
 * page's infinite scroll. The SSR first page comes from
 * searchPostsFirstPage() via the explore page itself; this route serves
 * every subsequent page using the same query semantics (content ILIKE +
 * CAS-number branch, trgm-friendly).
 *
 * Auth: optional. Search itself is a verified-only feature (canSearch) —
 * anonymous callers receive an empty result, not an error, so the explore
 * page's browse mode pagination (which uses /api/posts) is unaffected.
 */

import { NextRequest } from 'next/server'
import { resolveIdentity } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { canSearch } from '@/lib/permissions'
import { searchPostsAfterCursor } from '@/lib/services/search.service'

export async function GET(request: NextRequest) {
  const identity = await resolveIdentity()
  const limited = checkRateLimit(identity, 'read')
  if (limited) return limited

  // Search permission gate — mirrors explore page SSR (canSearch).
  if (!canSearch(identity.user)) {
    return Response.json({ posts: [], nextCursor: null })
  }

  const sp = request.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const cursor = sp.get('cursor') ?? undefined
  const takeRaw = Number(sp.get('take'))
  const take = Number.isFinite(takeRaw) && takeRaw > 0 ? takeRaw : undefined

  const page = await searchPostsAfterCursor(q, identity.user?.id ?? null, cursor, take)

  return Response.json({ posts: page.posts, nextCursor: page.nextCursor })
}
