/**
 * Post sitemap shards — `/p/sitemap/<n>.xml`.
 *
 * A stateless route handler (not a Next metadata route with
 * `generateSitemaps`, whose shard set is frozen at build/prerender time):
 * every numeric index answers at request time, so crossing the 50,000-post
 * boundary needs no rebuild, and an index beyond the current count serves a
 * valid EMPTY sitemap — robots.txt can never advertise a 404 here.
 *
 * Request validation order (no 500 for any numeric index, no huge OFFSET):
 *   1. malformed segment                → 404
 *   2. skip not a safe integer          → 200 empty urlset, no DB query
 *   3. index beyond shardCountFor(count)→ 200 empty urlset, no OFFSET query
 *   4. otherwise                        → skip/take query (skip < count)
 *
 * Consistency semantics are documented in `src/lib/sitemap.ts`: each shard
 * is an independently revalidated snapshot of the (createdAt DESC, id DESC)
 * ordering; concurrent writes can cause transient overlap/miss near the
 * boundary between shards. No zero-overlap/zero-omission guarantee is made
 * while writes are in flight.
 */

import { prisma } from '@/lib/db'
import { getSiteConfig } from '@/lib/site'
import {
  buildUrlsetXml,
  parseSitemapIndex,
  shardCountFor,
  shardSkip,
  SITEMAP_PAGE_SIZE,
} from '@/lib/sitemap'

export const revalidate = 3600

const EMPTY_URLSET = buildUrlsetXml([])

function emptySitemap(): Response {
  return new Response(EMPTY_URLSET, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=3600',
    },
  })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ index: string }> },
): Promise<Response> {
  const { index } = await params
  const pageIndex = parseSitemapIndex(index)
  if (pageIndex === null) {
    return new Response('Not found', { status: 404 })
  }
  // Overflowing offsets (e.g. 9007199254740991.xml) never reach the DB.
  const skip = shardSkip(pageIndex)
  if (skip === null) return emptySitemap()

  // Beyond the current shard range: valid empty sitemap, no OFFSET query.
  const count = await prisma.post.count({ where: { deletedAt: null } })
  if (pageIndex >= shardCountFor(count)) return emptySitemap()

  const baseUrl = (await getSiteConfig()).origin
  const posts = await prisma.post.findMany({
    where: { deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip,
    take: SITEMAP_PAGE_SIZE,
    select: { shortCode: true, createdAt: true, updatedAt: true },
  })

  const xml = buildUrlsetXml(
    posts
      .filter((p) => p.shortCode)
      .map((p) => ({
        url: `${baseUrl}/p/${p.shortCode}`,
        lastModified: p.updatedAt ?? p.createdAt,
        changeFrequency: 'daily' as const,
        priority: 0.7,
      })),
  )

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=3600',
    },
  })
}
