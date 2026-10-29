import type { MetadataRoute } from 'next'
import { prisma } from '@/lib/db'
import { getSiteConfig } from '@/lib/site'

export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = (await getSiteConfig()).origin
  // BOUNDED, not exhaustive: the 50,000 newest active users only. Users
  // beyond the cap are not listed in any sitemap until ranking shifts.
  // (The post sitemap is the only sharded, full-coverage surface.)
  const users = await prisma.user.findMany({
    where: { status: 'active' },
    take: 50000,
    select: { username: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })

  return users.map((u) => ({
    url: `${baseUrl}/u/${u.username}`,
    lastModified: u.createdAt,
    changeFrequency: 'weekly',
    priority: 0.6,
  }))
}
