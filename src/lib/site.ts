import 'server-only'
import { unstable_cache, revalidateTag, revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'

export const SITE_CONFIG_TAG = 'site-config'

/** Database-owned public identity. Cache for one hour, matching sitemap ISR. */
export const getSiteConfig = unstable_cache(
  async () => {
    const site = await prisma.siteConfig.findUnique({ where: { id: 1 } })
    if (!site) throw new Error('SiteConfig row 1 is required. Run migrations.')
    const origin = new URL(site.origin)
    if (!['https:', 'http:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('SiteConfig.origin must be an absolute HTTP(S) origin.')
    }
    if (!/^[a-z][a-z0-9_]{1,15}$/.test(site.keyPrefix)) {
      throw new Error('SiteConfig.keyPrefix must be 2-16 lowercase ASCII letters, digits or underscores.')
    }
    return {
      origin: origin.origin,
      name: site.name,
      shortName: site.shortName,
      keyPrefix: site.keyPrefix,
      description: site.description,
      tagline: site.tagline,
      analyticsId: site.analyticsId,
      githubUrl: site.githubUrl,
    }
  },
  ['site-config'],
  { revalidate: 3600, tags: [SITE_CONFIG_TAG] },
)

/** Invalidate cached site identity across data cache and page layouts. */
export function revalidateSiteConfig() {
  try {
    revalidateTag(SITE_CONFIG_TAG, 'max')
    revalidatePath('/', 'layout')
  } catch (error) {
    console.error('[SiteConfig] cache revalidation failed:', error)
  }
}
