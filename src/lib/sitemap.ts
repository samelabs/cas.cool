/**
 * Sitemap sharding primitives — shared by the post sitemap shard route and
 * robots.txt. Kept pure (no DB, no Next imports) so boundary behavior is
 * unit-testable.
 *
 * Shard lifecycle contract:
 * - Shards are stateless. ANY numeric shard index answers at request time;
 *   an index past the current post count serves a valid EMPTY <urlset>,
 *   never a 404. Crossing the 50,000 boundary therefore needs no rebuild,
 *   and a stale robots.txt (hourly revalidation) can never advertise a
 *   dead URL in either direction — a shard that no longer has content
 *   serves an empty sitemap until robots revalidates.
 *
 * Consistency semantics (honest, no absolute claims):
 * - Each shard renders an independent snapshot of the deterministic
 *   (createdAt DESC, id DESC) ordering. While posts are being created or
 *   deleted, two shards regenerated at different moments may transiently
 *   overlap or miss rows near the boundary; shards converge to an exact
 *   partition once writes stop and each shard's revalidation fires.
 * - The post sitemap covers ALL live posts (sharded); the user and CAS
 *   sitemaps are single bounded documents capped at 50,000 rows — entries
 *   beyond the cap are NOT listed there.
 */

export const SITEMAP_PAGE_SIZE = 50_000

/** Number of shards robots.txt advertises for a live-post count. Always ≥ 1. */
export function shardCountFor(count: number): number {
  return Math.max(1, Math.ceil(count / SITEMAP_PAGE_SIZE))
}

/** Parse a shard path segment (`0`, `0.xml`) — null when malformed. */
export function parseSitemapIndex(segment: string): number | null {
  const match = /^(\d+)(?:\.xml)?$/.exec(segment)
  if (!match) return null
  const index = Number(match[1])
  return Number.isSafeInteger(index) ? index : null
}

/**
 * OFFSET for a shard, or null when the offset is not representable as a
 * safe integer (e.g. 9007199254740991 × 50,000). Callers must answer such
 * indices with an empty sitemap WITHOUT issuing the query — a huge OFFSET
 * is a Prisma client error (500), not an empty page.
 */
export function shardSkip(pageIndex: number): number | null {
  const skip = pageIndex * SITEMAP_PAGE_SIZE
  return Number.isSafeInteger(skip) && skip >= 0 ? skip : null
}

export interface SitemapEntry {
  url: string
  lastModified?: Date | string | null
  changeFrequency?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
  priority?: number
}

function toW3CDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Serialize a sitemap <urlset> document by hand (shard routes are plain
 *  route handlers, not Next metadata routes). */
export function buildUrlsetXml(entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    let url = `  <url><loc>${escapeXml(entry.url)}</loc>`
    if (entry.lastModified) url += `<lastmod>${toW3CDate(entry.lastModified)}</lastmod>`
    if (entry.changeFrequency) url += `<changefreq>${entry.changeFrequency}</changefreq>`
    if (entry.priority !== undefined) url += `<priority>${entry.priority.toFixed(1)}</priority>`
    return `${url}</url>`
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}
