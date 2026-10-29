'use client'

import { useContext, type ReactNode } from 'react'
import { BrowseCacheContext } from '@/components/posts/BrowseStateProvider'

/**
 * Seed a useSWRInfinite first page into the identity-owned browse cache
 * (BrowseStateProvider) before the list below mounts.
 *
 * Writes ONLY when the key is absent:
 * - Fresh visit / hard reload — seeds the SSR page so page 0 is a cache
 *   hit (no duplicate first-page fetch; the SSR nextCursor is available to
 *   pagination immediately).
 * - Back-navigation — the persistent cache already holds the pages,
 *   cursors and size the user loaded, which are NEWER than this SSR
 *   snapshot; overwriting would throw that away and flash older content.
 *
 * Without a BrowseStateProvider above (a programming error — every list
 * lives under the root Providers), nothing is seeded and we warn in dev:
 * silently seeding into SWR's module-global default cache would leak data
 * across server-side requests.
 */
export function SWRInfiniteSeed<Page>({
  cacheKey,
  page,
  children,
}: {
  cacheKey: string
  page: Page
  children: ReactNode
}) {
  const browseCache = useContext(BrowseCacheContext)

  if (browseCache && !browseCache.has(cacheKey)) {
    browseCache.set(cacheKey, { data: page })
  } else if (process.env.NODE_ENV === 'development' && !browseCache) {
    console.error(
      `SWRInfiniteSeed('${cacheKey}'): no BrowseStateProvider above — page not seeded.`,
    )
  }

  return <>{children}</>
}
