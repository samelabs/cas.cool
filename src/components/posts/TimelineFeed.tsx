'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@/lib/i18n'
import useSWRInfinite from 'swr/infinite'
import { SWRConfig } from 'swr'
import { PostCard } from '@/components/posts/PostCard'
import TimelineTopBar from '@/components/posts/TimelineTopBar'
import { FlaskIcon } from '@/components/icons'
import { cn } from '@/lib/cn'
import { FEED_PAGE_SIZE } from '@/lib/feed-constants'
import { usePullToRefresh } from '@/lib/usePullToRefresh'
import type { SafePost } from '@/lib/types'
import { get, swrFetcher } from '@/lib/api-client'

/** Build the cache key for a given page. This string is now purely a SWR
 *  cache identifier — the fetcher parses it back into getTimeline params. */
function pageKey(tab: string, cursor: string | null): string {
  const base = `/api/posts?tab=${tab}&take=${FEED_PAGE_SIZE}`
  return cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base
}

interface Page {
  posts: SafePost[]
  nextCursor: string | null
}

/**
 * SWR fetcher — the cache key is a real URL (/api/posts?tab=...&cursor=...).
 * swrFetcher does a same-origin GET and parses JSON.
 */
const fetcher = (url: string): Promise<Page> => swrFetcher<Page>(url)

export interface TimelineFeedProps {
  initialPosts: SafePost[]
  initialNextCursor: string | null
  initialTab: 'latest' | 'following'
  isLoggedIn: boolean
}

type TabId = 'latest' | 'following'

// ─── Pull-to-refresh indicator ──────────────────────────────

function PullIndicator({
  pullDistance,
  threshold,
  isPulling,
  isRefreshing,
}: {
  pullDistance: number
  threshold: number
  isPulling: boolean
  isRefreshing: boolean
}) {
  if (pullDistance === 0 && !isRefreshing) return null

  const height = isRefreshing ? 44 : pullDistance
  const progress = Math.min(pullDistance / threshold, 1)

  return (
    <div
      className="flex items-center justify-center overflow-hidden"
      style={{
        height,
        transition: isPulling || isRefreshing ? 'none' : 'height 0.3s cubic-bezier(0.2, 0, 0, 1)',
      }}
    >
      <svg
        className={cn('h-5 w-5 text-brand', isRefreshing && 'animate-spin')}
        style={{
          opacity: isRefreshing ? 1 : Math.max(progress, 0.15),
          transform: isRefreshing ? undefined : `rotate(${progress * 270}deg)`,
        }}
        viewBox="0 0 24 24"
        fill="none"
      >
        <path
          d="M12 2a10 10 0 0 1 10 10"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  )
}

// ─── New posts banner ───────────────────────────────────────

function NewPostsBanner({
  loading,
  onClick,
}: {
  loading: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="sticky top-0 z-20 flex w-full items-center justify-center gap-1.5 border-b border-brand/20 bg-brand-tint/80 py-2 text-sm font-bold text-brand backdrop-blur-sm transition-colors hover:bg-brand-tint disabled:opacity-60"
      style={{ animation: 'banner-in 0.3s ease' }}
    >
      {loading ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand/30 border-t-brand" />
      ) : (
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
        >
          <path
            d="M12 19V5M5 12l7-7 7 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {t.feed.newPostsAvailable}
    </button>
  )
}

// ─── Tabs ───────────────────────────────────────────────────

function Tabs({
  tab,
  isLoggedIn,
  onChange,
}: {
  tab: TabId
  isLoggedIn: boolean
  onChange: (t: TabId) => void
}) {
  const tabs: { id: TabId; label: string }[] = isLoggedIn
    ? [
        { id: 'latest', label: t.feed.latest },
        { id: 'following', label: t.feed.following },
      ]
    : []

  if (tabs.length <= 1) return null

  return (
    <nav className="flex border-b border-line bg-surface">
      {tabs.map((t) => {
        const active = tab === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              'relative flex-1 py-3.5 text-center text-base font-semibold transition-colors hover:bg-surface-hover',
              active ? 'text-ink' : 'text-ink-muted',
            )}
          >
            {t.label}
            {active && (
              <span className="absolute bottom-0 left-1/2 h-1 w-12 -translate-x-1/2 rounded-full bg-brand" />
            )}
          </button>
        )
      })}
    </nav>
  )
}

/** createdAt arrives as a real Date through RSC props but as a string
 *  through every API fetch (JSON round-trip). Normalize at the boundary
 *  before storing/comparing — mixed types silently broke the watermark
 *  (string.toISOString throws; string > Date is always false). */
const asDate = (d: Date | string): Date => (d instanceof Date ? d : new Date(d))

// ─── Main component ─────────────────────────────────────────

function TimelineFeedInner({
  initialPosts,
  initialTab,
  isLoggedIn,
}: Omit<TimelineFeedProps, 'initialNextCursor'>) {
  const [tab, setTab] = useState<TabId>(initialTab)
  const [newPostsCount, setNewPostsCount] = useState(0)
  const [bannerLoading, setBannerLoading] = useState(false)

  // Watermark: timestamp of the newest post the user has acknowledged
  // seeing. Used as the "since" boundary for new-post detection. Updated
  // when: (a) initial mount from SSR data, (b) user creates a post,
  // (c) banner click / pull-to-refresh fetches new content.
  const newestSeenRef = useRef<Date | null>(
    initialPosts.length > 0 ? asDate(initialPosts[0].createdAt) : null,
  )

  // Keep the URL in sync (shareable / refresh-stable) WITHOUT triggering a
  // full Next.js navigation (which would remount this component and lose state).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = tab === 'latest' ? '/' : `/?tab=${tab}`
    window.history.replaceState(null, '', url)
  }, [tab])

  const getKey = useCallback(
    (pageIndex: number, prevPage: Page | null): string | null => {
      if (pageIndex === 0) return pageKey(tab, null)
      if (!prevPage || prevPage.posts.length === 0 || !prevPage.nextCursor) return null
      return pageKey(tab, prevPage.nextCursor)
    },
    [tab],
  )

  const {
    data,
    error,
    size,
    setSize,
    isValidating,
    mutate,
  } = useSWRInfinite<Page>(getKey, fetcher, {
    revalidateFirstPage: true,
    revalidateOnFocus: true,
    initialSize: 1,
  })

  const posts = useMemo<SafePost[]>(() => {
    if (!data) return initialPosts
    return data.flatMap((p) => (p ? p.posts : []))
  }, [data, initialPosts])

  // ─── Watermark sync with the visible feed top ───
  // SWR revalidation (mount / focus / back-navigation) silently swaps newer
  // posts into the first page while newestSeenRef may still hold its stale
  // SSR seed — the banner then re-appears (and its click becomes a no-op)
  // for posts already visible in the list. Whatever sits at the top of the
  // rendered feed counts as seen: advance the watermark with it.
  useEffect(() => {
    const first = data?.[0]?.posts?.[0]
    if (!first) return
    const top = asDate(first.createdAt)
    if (!newestSeenRef.current || top > newestSeenRef.current) {
      newestSeenRef.current = top
      setNewPostsCount(0)
    }
  }, [data])

  const lastPage = data?.[data.length - 1]
  const MAX_PAGES = 50
  const reachingEnd =
    (!!lastPage && lastPage.nextCursor === null && (data?.length ?? 0) > 0) ||
    (data?.length ?? 0) >= MAX_PAGES
  const isLoadingMore =
    isValidating && size > 0 && (data?.length ?? 0) < size && (data?.length ?? 0) > 0

  // ─── Refresh logic (shared by banner click + pull-to-refresh) ───

  const refreshNewPosts = useCallback(async () => {
    const since = newestSeenRef.current
    if (!since) return

    try {
      const result = await get<{ posts: SafePost[]; nextCursor: string | null }>(
        `/api/posts?tab=${tab}&since=${encodeURIComponent(since.toISOString())}&take=50`,
      )
      if (!result.ok || !result.data) return
      const fetched = result.data.posts || []

      if (fetched.length > 0) {
        mutate(
          (pages) => {
            if (!pages || pages.length === 0) return pages
            const first = pages[0]
            const existingIds = new Set(
              pages.flatMap((p) => (p ? p.posts.map((post) => post.id) : [])),
            )
            const toPrepend = fetched.filter((p: SafePost) => !existingIds.has(p.id))
            if (toPrepend.length === 0) return pages
            return [{ ...first, posts: [...toPrepend, ...first.posts] }, ...pages.slice(1)]
          },
          { revalidate: false },
        )
        newestSeenRef.current = asDate(fetched[0].createdAt)
      }

      setNewPostsCount(0)
    } catch {
      // Silently fail — pull-to-refresh just snaps back
    }
  }, [tab, mutate])

  // ─── Pull-to-refresh ───

  const { pullDistance, isPulling, isRefreshing } = usePullToRefresh({
    onRefresh: refreshNewPosts,
  })

  // ─── New posts banner polling (Latest only) ───

  useEffect(() => {
    // Banner + polling only on the Latest tab
    if (tab !== 'latest') return

    const watermark = newestSeenRef.current
    if (!watermark) return

    let cancelled = false

    const checkNewPosts = async () => {
      if (cancelled || document.hidden) return
      const since = newestSeenRef.current
      if (!since) return

      try {
        const result = await get<{ posts: SafePost[]; nextCursor: string | null }>(
          `/api/posts?tab=latest&since=${encodeURIComponent(since.toISOString())}&take=1`,
        )
        if (cancelled || !result.ok || !result.data) return
        if (!cancelled) setNewPostsCount(result.data.posts.length > 0 ? 1 : 0)
      } catch {
        // network errors are silent — next poll will retry
      }
    }

    // Initial check + 60s interval
    checkNewPosts()
    const interval = setInterval(checkNewPosts, 60_000)

    // Also check when the tab becomes visible (user returns to cas.cool)
    const onVisibility = () => {
      if (!document.hidden) checkNewPosts()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [tab])

  // ─── Handlers ───

  const handlePosted = useCallback(
    (post: SafePost) => {
      mutate(
        (pages) => {
          if (!pages || pages.length === 0) return pages
          const first = pages[0]
          if (first.posts.some((p) => p.id === post.id)) return pages
          return [{ ...first, posts: [post, ...first.posts] }, ...pages.slice(1)]
        },
        { revalidate: false },
      )
      // Advance watermark so the banner doesn't count the user's own post
      const createdAt = asDate(post.createdAt)
      if (!newestSeenRef.current || createdAt > newestSeenRef.current) {
        newestSeenRef.current = createdAt
      }
      window.scrollTo({ top: 0, behavior: 'auto' })
    },
    [mutate],
  )

  const handleDeleted = useCallback(
    (postId: string) => {
      mutate(
        (pages) => {
          if (!pages) return pages
          return pages.map((p) =>
            p ? { ...p, posts: p.posts.filter((post) => post.id !== postId) } : p,
          )
        },
        { revalidate: false },
      )
    },
    [mutate],
  )

  const handleBannerClick = useCallback(async () => {
    setBannerLoading(true)
    await refreshNewPosts()
    setBannerLoading(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [refreshNewPosts])

  // ─── Infinite scroll ───

  const sentinelRef = useRef<HTMLDivElement>(null)
  const hasLeftViewportRef = useRef(false)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || reachingEnd) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        if (entry.isIntersecting) {
          if (hasLeftViewportRef.current) {
            setSize((s) => s + 1)
          }
        } else {
          hasLeftViewportRef.current = true
        }
      },
      { rootMargin: '400px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [setSize, reachingEnd])

  // ─── Render ───

  const handleTabChange = useCallback((newTab: TabId) => {
    setTab(newTab)
    if (newTab !== 'latest') setNewPostsCount(0)
  }, [])

  const showBanner = tab === 'latest' && newPostsCount > 0

  return (
    <>
      <PullIndicator
        pullDistance={pullDistance}
        threshold={65}
        isPulling={isPulling}
        isRefreshing={isRefreshing}
      />

      <Tabs tab={tab} isLoggedIn={isLoggedIn} onChange={handleTabChange} />

      <TimelineTopBar onPosted={handlePosted} />

      {showBanner && (
        <NewPostsBanner
          loading={bannerLoading}
          onClick={handleBannerClick}
        />
      )}

      {posts.length === 0 && !isValidating ? (
        <div className="px-4 py-16 text-center text-ink-muted">
          <FlaskIcon className="mx-auto mb-3 h-10 w-10 text-ink-faint" />
          <p className="text-lg font-semibold text-ink-muted">
            {tab === 'following'
              ? t.feed.noPostsFollowing
              : t.feed.noPostsYet}
          </p>
          <p className="mt-1 text-sm">
            {tab === 'following'
              ? t.feed.followingEmptyHint
              : t.feed.forYouEmptyHint}
          </p>
        </div>
      ) : (
        <>
          {posts.map((p) => (
            <PostCard key={p.id} post={p} onDeleted={handleDeleted} />
          ))}

          <div ref={sentinelRef} className="h-px w-full" aria-hidden />

          {isLoadingMore && (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-ink-faint">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
              {t.common.loadingMore}
            </div>
          )}

          {error && (
            <div className="py-6 text-center text-sm text-danger">
              {t.feed.failedToLoad}
            </div>
          )}
        </>
      )}
    </>
  )
}

/**
 * TimelineFeed wraps the inner component in an SWRConfig whose `fallback`
 * seeds the first page from server-rendered data. This is what makes the feed
 * render instantly (SSR) and lets SWR cache survive client-side navigation, so
 * scroll position and loaded pages are preserved when navigating back.
 */
export function TimelineFeed(props: TimelineFeedProps) {
  const { initialPosts, initialNextCursor, initialTab } = props
  const firstKey = pageKey(initialTab, null)

  const fallback = useMemo(
    () => ({ [firstKey]: { posts: initialPosts, nextCursor: initialNextCursor } as Page }),
    [firstKey, initialPosts, initialNextCursor],
  )

  return (
    <SWRConfig value={{ fallback }}>
      <TimelineFeedInner {...props} />
    </SWRConfig>
  )
}

export default TimelineFeed
