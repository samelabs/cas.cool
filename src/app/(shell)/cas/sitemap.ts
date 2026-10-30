import type { MetadataRoute } from 'next'
import { prisma } from '@/lib/db'
import { getSiteConfig } from '@/lib/site'

export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = (await getSiteConfig()).origin
  // Bounded to top 50,000 registered chemicals by post count.
  const chemicals = await prisma.chemical.findMany({
    take: 50000,
    select: { casNumber: true, updatedAt: true },
    orderBy: { postCount: 'desc' },
  })

  return chemicals.map((c) => ({
    url: `${baseUrl}/cas/${c.casNumber}`,
    lastModified: c.updatedAt,
    changeFrequency: 'weekly',
    priority: 0.5,
  }))
}
