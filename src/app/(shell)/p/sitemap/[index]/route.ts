/**
 * Post sitemap shards — `/p/sitemap/<n>.xml`.
 *
 * A stateless route handler (not a Next metadata route with
 * `generateSitemaps`, whose shard set is frozen at build/prerender time):
 * every numeric index answers at request time, so crossing the 50,000-post
 * boundary needs no rebuild, and an index beyond the current count serves a
 * valid EMPTY sitemap — robots.txt can never advertise a 404 here.
 *
 * Measured on the Next 16.4.3 production build, this segment renders
 * dynamic (ƒ) and each request re-executed the handler; a bare
 * `export const revalidate` never engaged the ISR cache for it. Origin-side
 * result reuse therefore lives in src/lib/services/sitemap.service.ts:
 * a bounded in-memory tier plus a regenerable disk tier that together reuse
 * the full shard working set, same-shard concurrent cold requests coalesced
 * onto one generation whose in-flight record lasts until the disk publish
 * completes, at most 2 generation tasks in parallel (each spanning rows
 * through atomic publish), and the live-post count shared with robots.txt
 * behind a 5 s refresh window that never blocks
 * a cache hit. The public freshness contract stays the advertised
 * cache-control hour, made honest end-to-end by the `Age` header: downstream
 * caches keep the REMAINING validity of the source-cached response.
 *
 * Request validation order (no 500 for any numeric index, no huge OFFSET):
 *   1. malformed segment                → 404
 *   2. skip not a safe integer          → 200 empty urlset, no DB query
 *   3. index beyond shardCountFor(count)→ 200 empty urlset, no OFFSET query
 *   4. otherwise                        → skip/take window (skip < count)
 *
 * Consistency semantics are documented in `src/lib/sitemap.ts`: each shard
 * is an independently refreshed snapshot of the (createdAt DESC, id DESC)
 * ordering; concurrent writes can cause transient overlap/miss near the
 * boundary between shards. No zero-overlap/zero-omission guarantee is made
 * while writes are in flight.
 */

import { EMPTY_URLSET, parseSitemapIndex, shardSkip } from '@/lib/sitemap'
import { getPostSitemapShard } from '@/lib/services/sitemap.service'

const XML_HEADERS = {
  'content-type': 'application/xml; charset=utf-8',
  'cache-control': 'public, max-age=3600, s-maxage=3600',
} as const

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
  if (skip === null) {
    return new Response(EMPTY_URLSET, {
      headers: { ...XML_HEADERS, 'x-sitemap-cache': 'empty' },
    })
  }

  // Beyond the current shard range: valid empty sitemap, no OFFSET query.
  const { xml, cache, ageSeconds } = await getPostSitemapShard(pageIndex, skip)
  return new Response(xml, {
    headers: {
      ...XML_HEADERS,
      'x-sitemap-cache': cache,
      age: String(ageSeconds),
    },
  })
}
