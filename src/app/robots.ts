import type { MetadataRoute } from 'next'
import { getSiteConfig } from '@/lib/site'
import { getLivePostCount } from '@/lib/services/sitemap.service'
import { shardCountFor } from '@/lib/sitemap'

export const revalidate = 3600

export default async function robots(): Promise<MetadataRoute.Robots> {
  const site = await getSiteConfig()
  // Same counting rule and count window as the shard route (shared
  // getLivePostCount: `deletedAt: null`, refreshed at most once per 5s).
  // This document itself revalidates hourly, so the advertised shard list
  // converges to the same data state as the shards within that window.
  const count = await getLivePostCount()
  // Shard routes are stateless (`/p/sitemap/[index]/route.ts`): every index
  // answers, and one past the count serves a valid EMPTY sitemap. A stale
  // robots entry after the count shrinks is therefore never a 404 — it fades
  // out at the next (hourly) robots revalidation.
  const postSitemaps = Array.from({ length: shardCountFor(count) }, (_, i) => `${site.origin}/p/sitemap/${i}.xml`)

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: '/api/',
    },
    sitemap: [
      `${site.origin}/sitemap.xml`,
      ...postSitemaps,
      `${site.origin}/u/sitemap.xml`,
      `${site.origin}/cas/sitemap.xml`,
    ],
  }
}
