import type { MetadataRoute } from 'next'
import { prisma } from '@/lib/db'
import { getSiteConfig } from '@/lib/site'
import { shardCountFor } from '@/lib/sitemap'

export const revalidate = 3600

export default async function robots(): Promise<MetadataRoute.Robots> {
  const site = await getSiteConfig()
  const count = await prisma.post.count({ where: { deletedAt: null } })
  // Shard routes are stateless (`/p/sitemap/[index]/route.ts`): every index
  // answers, and one past the count serves a valid EMPTY sitemap. A stale
  // robots entry after the count shrinks is therefore never a 404 — it fades
  // out at the next (hourly) robots revalidation.
  const postSitemaps = Array.from({ length: shardCountFor(count) }, (_, i) => `${site.origin}/p/sitemap/${i}.xml`)

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/settings', '/messages', '/notifications', '/bookmarks', '/compose'],
    },
    sitemap: [
      `${site.origin}/sitemap.xml`,
      ...postSitemaps,
      `${site.origin}/u/sitemap.xml`,
      `${site.origin}/cas/sitemap.xml`,
    ],
  }
}
