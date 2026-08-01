'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@/lib/i18n'
import Link from 'next/link'
import useSWRInfinite from 'swr/infinite'
import { SWRConfig } from 'swr'
import { PostCard } from '@/components/posts/PostCard'
import { FlaskIcon } from '@/components/icons'
import { postUrl } from '@/lib/shortCode'

import { getTimeline } from '@/actions/posts'
import { searchPosts } from '@/actions/search'
import type { SafePost } from '@/lib/types'

interface Page {
  posts: SafePost[]
  nextCursor: string | null
}

/**
 * SWR fetcher that parses the legacy URL-based cache key and dispatches
 * to the appropriate Server Action. The basePath URL is kept as the SWR
 * cache key for compatibility with SWRConfig fallback and optimistic
 * mutations, but no HTTP request is made.
 */
const fetcher = async (url: string): Promise<Page> => {
  const parsed = new URL(url, 'http://localhost')
  const sp = parsed.searchParams

  // Search route
  if (parsed.pathname === '/api/search') {
    const q = sp.get('q') || ''
    const cursor = sp.get('cursor') ?? undefined
    const take = parseInt(sp.get('take') || '0') || undefined
    const result = await searchPosts(q, cursor, take)
    if (!result.ok) throw new Error(t.errors.failedToLoadPosts)
    return { posts: result.data.posts, nextCursor: result.data.nextCursor }
  }

  // Posts route — extract all parameters
  const tab = sp.get('tab') === 'following' ? 'following' : sp.get('tab') === 'latest' ? 'latest' : 'foryou'
  const cursor = sp.get('cursor') ?? undefined
  const take = parseInt(sp.get('take') || '0') || undefined

  const result = await getTimeline({
    tab,
    cursor,
    take,
    cas: sp.get('cas') ?? undefined,
    author: sp.get('author') ?? undefined,
    scope: sp.get('scope') === 'replies' ? 'replies' : sp.get('scope') === 'media' ? 'media' : undefined,
    likedBy: sp.get('likedBy') ?? undefined,
    bookmarkedBy: sp.get('bookmarkedBy') ?? undefined,
    repliesOf: sp.get('repliesOf') ?? undefined,
    conversationOf: sp.get('conversationOf') ?? undefined,
    since: sp.get('since') ?? undefined,
  })

  if (!result.ok) throw new Error(result.error || t.errors.failedToLoadPosts)
  return result.data
}

export interface InfinitePostListHandle {
  /** Append a post to the first page of the SWR infinite cache (optimistic). */
  inject: (post: SafePost) => void
}

export interface InfinitePostListProps {
  /** Base API path without cursor, e.g. `/api/posts?tab=latest&tag=ethanol` */
  basePath: string
  /** SSR-seeded first page for instant render + hydration. */
  initialPosts: SafePost[]
  initialNextCursor: string | null
  /** Optional empty-state message override. */
  emptyMessage?: string
  /** `'feed'` (default) renders PostCards; `'media'` renders an image grid. */
  variant?: 'feed' | 'media'
  /** Username to show as "replying to @user" on each card (post-detail replies). */
  replyingTo?: string
  /** When true, suppress the empty-state UI entirely (render nothing). */
  hideEmpty?: boolean
  /** When true, suppress the end-of-list separator (dashes + dot). */
  hideEndSeparator?: boolean
  /** Called on mount with a handle exposing cache mutation (for optimistic replies). */
  onReady?: (handle: InfinitePostListHandle) => void
}

function InfinitePostListInner({
  basePath,
  initialPosts,
  emptyMessage = t.feed.noPostsYet,
  variant = 'feed',
  replyingTo,
  hideEmpty = false,
  onReady,
}: Omit<InfinitePostListProps, 'initialNextCursor'>) {
  const getKey = useCallback(
    (pageIndex: number, prevPage: Page | null): string | null => {
      if (pageIndex === 0) return basePath
      if (!prevPage || !prevPage.nextCursor) return null
      const sep = basePath.includes('?') ? '&' : '?'
      return `${basePath}${sep}cursor=${encodeURIComponent(prevPage.nextCursor)}`
    },
    [basePath],
  )

  const { data, error, size, setSize, isValidating, mutate } = useSWRInfinite<Page>(
    getKey,
    fetcher,
    { revalidateFirstPage: false, revalidateOnFocus: false },
  )

  // Expose cache mutation to parent for optimistic updates (e.g. new reply).
  useEffect(() => {
    if (!onReady) return
    onReady({
      inject: (post: SafePost) =>
        mutate(
          (pages) => {
            if (!pages) return pages
            const next = [...pages]
            if (next[0]) {
              next[0] = { ...next[0], posts: [...next[0].posts, post] }
            }
            return next
          },
          { revalidate: false },
        ),
    })
  }, [mutate, onReady])

  // Posts hidden by user-initiated delete. Lives in local state so the
  // deleted post disappears instantly from both the SSR seed and the
  // SWR-loaded pages. Cleared on navigation (component unmount).
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())

  const handleDeleted = useCallback((postId: string) => {
    setHiddenIds((prev) => new Set(prev).add(postId))
    mutate(
      (pages) => {
        if (!pages) return pages
        return pages.map((p) =>
          p ? { ...p, posts: p.posts.filter((post) => post.id !== postId) } : p,
        )
      },
      { revalidate: false },
    )
  }, [mutate])

  const posts = useMemo<SafePost[]>(() => {
    const all = data ? data.flatMap((p) => (p ? p.posts : [])) : initialPosts
    return hiddenIds.size > 0 ? all.filter((p) => !hiddenIds.has(p.id)) : all
  }, [data, initialPosts, hiddenIds])

  const lastPage = data?.[data.length - 1]
  const MAX_PAGES = 50 // 1000 posts — prevents unbounded DOM growth
  const reachingEnd =
    (!!lastPage && lastPage.nextCursor === null && (data?.length ?? 0) > 0) ||
    (data?.length ?? 0) >= MAX_PAGES
  const isLoadingMore = isValidating && size > 0 && (data?.length ?? 0) < size && (data?.length ?? 0) > 0

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

  if (posts.length === 0 && !isValidating) {
    if (hideEmpty) return null
    return (
      <div className="flex flex-col items-center px-4 py-16 text-center text-ink-muted">
        <FlaskIcon className="h-10 w-10 text-ink-faint" />
        <p className="mt-3 text-lg font-semibold text-ink-muted">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <>
      {variant === 'media' ? (
        <div className="grid grid-cols-2 gap-0.5 p-2 sm:grid-cols-3">
          {posts
            .filter((p) => (p.images?.length ?? 0) > 0)
            .flatMap((p) =>
              p.images.map((src, i) => (
                <Link key={`${p.id}-${i}`} href={postUrl(p)} className="aspect-square overflow-hidden bg-surface-hover">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="h-full w-full object-cover" />
                </Link>
              )),
            )}
        </div>
      ) : (
        posts.map((p) => (
          <PostCard key={p.id} post={p} replyingTo={replyingTo} onDeleted={handleDeleted} />
        ))
      )}

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
  )
}

/**
 * Reusable cursor-based infinite post list.
 *
 * Wraps `useSWRInfinite` with an IntersectionObserver sentinel for
 * scroll-triggered pagination. The first page is seeded from SSR data
 * via `SWRConfig` fallback so the initial render is instant and
 * hydratable. Each instance's `basePath` naturally forms a unique SWR
 * cache key, so different pages (tag, CAS, profile) never collide.
 */
export function InfinitePostList(props: InfinitePostListProps) {
  const { basePath, initialPosts, initialNextCursor } = props

  const fallback = useMemo(
    () => ({
      [basePath]: { posts: initialPosts, nextCursor: initialNextCursor } as Page,
    }),
    [basePath, initialPosts, initialNextCursor],
  )

  return (
    <SWRConfig value={{ fallback }}>
      <InfinitePostListInner {...props} />
    </SWRConfig>
  )
}

export default InfinitePostList
