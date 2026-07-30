import type { MetadataRoute } from 'next'
import { prisma } from '@/lib/db'
import { SITE_URL } from '@/lib/site'

// Revalidate every hour instead of force-dynamic.
// The sitemap queries up to 20K rows — caching avoids hitting the DB on every crawl.
export const revalidate = 3600

export default async function sitemap() {
  const baseUrl = SITE_URL

  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    { url: baseUrl, changeFrequency: 'always', priority: 1.0 },
    { url: `${baseUrl}/explore`, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${baseUrl}/search`, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${baseUrl}/about`, changeFrequency: 'monthly', priority: 0.3 },
  ]

  // Top users (limit to avoid huge sitemap)
  const users = await prisma.user.findMany({
    take: 5000,
    select: { username: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  const userPages: MetadataRoute.Sitemap = users.map((u) => ({
    url: `${baseUrl}/u/${u.username}`,
    lastModified: u.createdAt,
    changeFrequency: 'weekly',
    priority: 0.6,
  }))

  // Top chemicals
  const chemicals = await prisma.chemical.findMany({
    take: 10000,
    where: { postCount: { gt: 0 } },
    select: { casNumber: true, updatedAt: true },
    orderBy: { postCount: 'desc' },
  })
  const chemicalPages: MetadataRoute.Sitemap = chemicals.map((c) => ({
    url: `${baseUrl}/cas/${c.casNumber}`,
    lastModified: c.updatedAt,
    changeFrequency: 'weekly',
    priority: 0.5,
  }))

  return [...staticPages, ...userPages, ...chemicalPages]
}
