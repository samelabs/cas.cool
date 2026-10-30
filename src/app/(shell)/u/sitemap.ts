import type { MetadataRoute } from 'next'
import { prisma } from '@/lib/db'
import { getSiteConfig } from '@/lib/site'

export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = (await getSiteConfig()).origin
  // Bounded to 50,000 users, ordered by creation date.
  const users = await prisma.user.findMany({
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
