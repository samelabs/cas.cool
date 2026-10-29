import { renderToString } from 'react-dom/server'
import { useContext, type ReactNode } from 'react'
import { expect, it } from 'vitest'
import { SWRInfiniteSeed } from './SWRInfiniteSeed'
import { BrowseCacheContext, BrowseStateProvider } from './BrowseStateProvider'

interface TestPage {
  posts: { id: string }[]
  nextCursor: string | null
}

function CacheProbe({ cacheKey }: { cacheKey: string }) {
  const cache = useContext(BrowseCacheContext)
  const cached = cache?.get(cacheKey) as { data?: TestPage } | undefined
  return <span>{cached?.data?.posts[0]?.id ?? 'missing'}</span>
}

/** Writes a "previously loaded" page into the ambient browse cache during
 *  render, before the seed below it runs — simulating a warm cache on
 *  back-navigation. */
function WarmCache({ cacheKey, page, children }: { cacheKey: string; page: TestPage; children: ReactNode }) {
  const browseCache = useContext(BrowseCacheContext)!
  if (!browseCache.has(cacheKey)) {
    browseCache.set(cacheKey, { data: page })
  }
  return <>{children}</>
}

function tree(page: TestPage, cacheKey: string, identityKey = 'user-a') {
  return renderToString(
    <BrowseStateProvider identityKey={identityKey}>
      <SWRInfiniteSeed cacheKey={cacheKey} page={page}>
        <CacheProbe cacheKey={cacheKey} />
      </SWRInfiniteSeed>
    </BrowseStateProvider>,
  )
}

it('seeds the SSR page into the identity browse cache before children render', () => {
  const html = tree({ posts: [{ id: 'p1' }], nextCursor: 'next-page' }, '/api/posts?tab=latest')
  expect(html).toContain('p1')
})

it('never overwrites an already-cached page (back-navigation keeps newer state)', () => {
  const cacheKey = '/api/posts?tab=latest'
  const html = renderToString(
    <BrowseStateProvider identityKey="user-a">
      <WarmCache cacheKey={cacheKey} page={{ posts: [{ id: 'cached-newer' }], nextCursor: 'c1' }}>
        <SWRInfiniteSeed cacheKey={cacheKey} page={{ posts: [{ id: 'ssr-older' }], nextCursor: 's1' }}>
          <CacheProbe cacheKey={cacheKey} />
        </SWRInfiniteSeed>
      </WarmCache>
    </BrowseStateProvider>,
  )
  expect(html).toContain('cached-newer')
})

it('isolates browse caches per identity (a switch starts empty)', () => {
  const cacheKey = '/api/posts?tab=latest'
  // Identity A loads a page.
  const asA = tree({ posts: [{ id: 'a-post' }], nextCursor: null }, cacheKey, 'user-a')
  expect(asA).toContain('a-post')
  // Identity B, same browser session: fresh provider instance, same key —
  // must NOT see A's cached page; its own SSR seed is what renders.
  const asB = tree({ posts: [{ id: 'b-post' }], nextCursor: null }, cacheKey, 'user-b')
  expect(asB).toContain('b-post')
  expect(asB).not.toContain('a-post')
})

it('does nothing (and does not crash) without a BrowseStateProvider', () => {
  const html = renderToString(
    <SWRInfiniteSeed
      cacheKey="/api/posts?tab=latest"
      page={{ posts: [{ id: 'p1' }], nextCursor: null }}
    >
      <span>children-render</span>
    </SWRInfiniteSeed>,
  )
  expect(html).toContain('children-render')
})
