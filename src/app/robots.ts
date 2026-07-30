import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/settings', '/messages', '/notifications', '/bookmarks', '/compose'],
    },
    sitemap: 'https://cas.cool/sitemap.xml',
  }
}
