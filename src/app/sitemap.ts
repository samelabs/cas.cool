import type { MetadataRoute } from 'next'
import { getSiteConfig } from '@/lib/site'

// Revalidate every hour instead of force-dynamic.
export const revalidate = 3600

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = (await getSiteConfig()).origin

  // Static discovery pages
  return [
    { url: baseUrl, changeFrequency: 'always', priority: 1.0 },
    { url: `${baseUrl}/explore`, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${baseUrl}/about`, changeFrequency: 'monthly', priority: 0.3 },
  ]
}
