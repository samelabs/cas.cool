'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useSWRConfig } from 'swr'
import { formatNumber } from '@/lib/utils'
import { useAuth } from '@/components/Providers'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { postUrl } from '@/lib/shortCode'
import {
  BookmarkIcon,
  CommentIcon,
  HeartIcon,
  RepostIcon,
  ViewIcon,
} from '@/components/icons'
import type { SafePost } from '@/lib/types'
import { t } from '@/lib/i18n'
import { post as apiPost, del } from '@/lib/api-client'
import { ShareButton } from '@/components/posts/ShareButton'

export interface PostActionsProps {
  post: SafePost
  hideComment?: boolean
  /** Hide the repost/quote button. Used when this post itself is a quote —
   *  prevents nested quotes (quote-of-a-quote), matching Twitter's behaviour. */
  hideRepost?: boolean
}

/* ── Action button ─────────────────────────────────────── */
function ActionButton({
  label, count, active, activeClass, hoverClass, loading, onClick, href, children,
}: {
  label: string
  count?: number
  active?: boolean
  activeClass?: string
  hoverClass?: string
  loading?: boolean
  onClick?: () => void
  href?: string
  children: React.ReactNode
}) {
  const content = (
    <>
      <span
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-full transition-colors',
          hoverClass,
          active && activeClass,
        )}
      >
        {children}
      </span>
      {/* Count — tight, lightweight, tabular for stable layout.
          Hidden entirely at 0 so empty actions look clean. */}
      <span
        className={cn(
          'text-xs font-medium tabular-nums leading-none',
          typeof count === 'number' && count > 0
            ? (active ? activeClass : 'text-ink-faint')
            : 'hidden',
        )}
      >
        {typeof count === 'number' && count > 0 ? formatNumber(count) : ''}
      </span>
    </>
  )

  // ::before extends the hit area vertically (36→48px; mobile minimum 44)
  // without changing the visual row height.
  const baseClass = cn(
    "group relative flex items-center gap-1 before:absolute before:-top-1.5 before:-bottom-1.5 before:left-0 before:right-0 before:content-[\"\"]",
    loading && 'opacity-60 pointer-events-none',
  )

  if (href) {
    return <Link href={href} aria-label={label} className={baseClass}>{content}</Link>
  }
  return (
    <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} disabled={loading} className={baseClass}>
      {content}
    </button>
  )
}

/* ── Lightweight popover ──────────────────────────────── */
function Popover({
  open,
  onClose,
  align = 'left',
  children,
}: {
  open: boolean
  onClose: () => void
  align?: 'left' | 'right'
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown, { passive: true })
    document.addEventListener('keydown', onEsc)

    // Elevate the popover's stacking context so it paints above sibling
    // cards further down the timeline. We use isolation on the nearest
    // positioned ancestor (the article) to create a new stacking context,
    // plus a high z-index on the popover itself.
    const article = ref.current?.closest('article')
    if (article) {
      ;(article as HTMLElement).style.zIndex = '50'
      ;(article as HTMLElement).style.position = 'relative'
    }

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onEsc)
      if (article) {
        ;(article as HTMLElement).style.zIndex = ''
        ;(article as HTMLElement).style.position = ''
      }
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={ref}
      className={cn(
        'absolute top-full z-50 mt-1.5 min-w-[180px] origin-top overflow-hidden rounded-2xl border border-line-strong bg-surface ring-1 ring-black/5 shadow-xl shadow-black/10',
        'animate-[popoverIn_120ms_ease-out]',
        align === 'left' ? 'left-0' : 'right-0',
      )}
    >
      {children}
    </div>
  )
}

function MenuItem({
  icon, label, onClick, variant = 'default',
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  variant?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-2.5 text-sm font-medium transition-colors active:bg-surface-hover',
        variant === 'danger'
          ? 'text-danger hover:bg-danger-tint'
          : 'text-ink hover:bg-surface-hover',
      )}
    >
      <span className={cn('shrink-0', variant === 'danger' ? 'text-danger' : 'text-ink-muted')}>
        {icon}
      </span>
      {label}
    </button>
  )
}

/* ── Main component ───────────────────────────────────── */
export function PostActions({ post, hideComment = false, hideRepost = false }: PostActionsProps) {
  const router = useRouter()
  const { currentUser } = useAuth()
  const { showToast } = useToast()
  const { mutate: globalMutate } = useSWRConfig()

  const [liked, setLiked] = useState(post.liked ?? false)
  const [likeCount, setLikeCount] = useState(post._count?.likes ?? 0)
  const [likePending, setLikePending] = useState(false)

  const [reposted, setReposted] = useState(post.reposted ?? false)
  const [repostCount, setRepostCount] = useState(post._count?.reposts ?? 0)
  const [repostPending, setRepostPending] = useState(false)

  const [bookmarked, setBookmarked] = useState(post.bookmarked ?? false)
  const [bookmarkCount, setBookmarkCount] = useState(post._count?.bookmarks ?? 0)
  const [bookmarkPending, setBookmarkPending] = useState(false)

  /**
   * Sync interaction state into the SWR cache so that client-side navigation
   * back to the timeline (or any InfinitePostList) shows the updated counts.
   *
   * SWR caches by URL key. We walk ALL cached entries, find pages containing
   * this post, and patch the post's counts + interaction flags in-place.
   * This runs AFTER the optimistic UI update + successful API call, so the
   * cache reflects what the user just did.
   *
   * Uses globalMutate with a filter function — only touches matching keys,
   * never triggers a refetch.
   */
  /**
   * Sync engagement changes to SWR cache without refetching.
   * Accepts deltas (not absolute values) to avoid stale-closure bugs when
   * the user fires multiple toggles before React re-renders.
   */
  const syncCache = useCallback(
    (
      patch: Partial<Pick<SafePost, 'liked' | 'reposted' | 'bookmarked'>>,
      countDelta: Partial<Record<'likes' | 'reposts' | 'bookmarks', number>>,
    ) => {
      globalMutate(
        (key: unknown) => typeof key === 'string' && key.startsWith('/api/posts'),
        (data: unknown) => {
          if (!data || typeof data !== 'object') return data
          const page = data as { posts?: SafePost[]; nextCursor?: string | null }
          if (!Array.isArray(page.posts)) return data
          return {
            ...page,
            posts: page.posts.map((p) =>
              p.id === post.id
                ? {
                    ...p,
                    ...patch,
                    _count: {
                      likes: Math.max(0, (p._count?.likes ?? 0) + (countDelta.likes ?? 0)),
                      reposts: Math.max(0, (p._count?.reposts ?? 0) + (countDelta.reposts ?? 0)),
                      bookmarks: Math.max(0, (p._count?.bookmarks ?? 0) + (countDelta.bookmarks ?? 0)),
                      replies: p._count?.replies ?? 0,
                    },
                  }
                : p,
            ),
          }
        },
        { revalidate: false },
      )
    },
    [globalMutate, post.id],
  )

  // Heart-pop animation trigger. Incremented on each like to force React to
  // remount the icon wrapper (key change) so the CSS animation replays.
  // Uses transform (GPU composited) instead of color transitions (CPU paint).
  const [likeAnim, setLikeAnim] = useState(0)

  const requireAuth = (): boolean => {
    if (!currentUser) {
      showToast(t.postActions.pleaseSignIn, 'info')
      router.push('/login')
      return false
    }
    return true
  }

  const toggleLike = async () => {
    if (!requireAuth() || likePending) return
    const next = !liked
    setLiked(next)
    setLikeCount((c) => c + (next ? 1 : -1))
    if (next) setLikeAnim((n) => n + 1)
    setLikePending(true)
    try {
      const result = next
        ? await apiPost('/api/posts/' + post.shortCode + '/like')
        : await del('/api/posts/' + post.shortCode + '/like')
      if (!result.ok) throw new Error(result.error ?? undefined)
      syncCache({ liked: next }, { likes: next ? 1 : -1 })
    } catch {
      setLiked(!next)
      setLikeCount((c) => c + (next ? -1 : 1))
      showToast(t.postActions.actionFailed, 'error')
    } finally {
      setLikePending(false)
    }
  }

  const toggleRepost = async () => {
    if (!requireAuth() || repostPending) return
    const next = !reposted
    setReposted(next)
    setRepostCount((c) => c + (next ? 1 : -1))
    setRepostPending(true)
    try {
      const result = next
        ? await apiPost('/api/posts/' + post.shortCode + '/repost')
        : await del('/api/posts/' + post.shortCode + '/repost')
      if (!result.ok) throw new Error(result.error ?? undefined)
      syncCache({ reposted: next }, { reposts: next ? 1 : -1 })
    } catch {
      setReposted(!next)
      setRepostCount((c) => c + (next ? -1 : 1))
      showToast(t.postActions.actionFailed, 'error')
    } finally {
      setRepostPending(false)
    }
  }

  const toggleBookmark = async () => {
    if (!requireAuth() || bookmarkPending) return
    const next = !bookmarked
    setBookmarked(next)
    setBookmarkCount((c) => c + (next ? 1 : -1))
    setBookmarkPending(true)
    try {
      const result = next
        ? await apiPost('/api/posts/' + post.shortCode + '/bookmark')
        : await del('/api/posts/' + post.shortCode + '/bookmark')
      if (!result.ok) throw new Error(result.error ?? undefined)
      syncCache({ bookmarked: next }, { bookmarks: next ? 1 : -1 })
    } catch {
      setBookmarked(!next)
      setBookmarkCount((c) => c + (next ? -1 : 1))
      showToast(t.postActions.actionFailed, 'error')
    } finally {
      setBookmarkPending(false)
    }
  }

  const [showRepostMenu, setShowRepostMenu] = useState(false)

  const closeRepostMenu = useCallback(() => setShowRepostMenu(false), [])

  return (
    <div className="flex items-center justify-between w-full sm:max-w-[460px]">
      {/* Reply */}
      {!hideComment && (
        <ActionButton
          label={t.postActions.reply}
          count={post._count?.replies}
          href={postUrl(post)}
          hoverClass="group-hover:bg-brand-tint group-hover:text-brand"
        >
          <CommentIcon className="h-[18px] w-[18px] text-ink-faint group-hover:text-brand" />
        </ActionButton>
      )}

      {/* Repost / Quote — hidden for quote posts (prevents nested quotes) */}
      {!hideRepost && (
        <div className="relative">
          <ActionButton
            label={reposted ? t.postActions.undoRepost : t.postActions.repost}
            count={repostCount}
            active={reposted}
            loading={repostPending}
            onClick={() => setShowRepostMenu((v) => !v)}
            activeClass="text-brand"
            hoverClass="group-hover:bg-brand-tint group-hover:text-brand"
          >
            <RepostIcon className={cn('h-[18px] w-[18px]', reposted ? 'text-brand' : 'text-ink-faint')} filled={reposted} />
          </ActionButton>
          <Popover open={showRepostMenu} onClose={closeRepostMenu} align="left">
            <MenuItem
              icon={<RepostIcon className="h-4 w-4" />}
              label={reposted ? t.postActions.undoRepost : t.postActions.repost}
              onClick={() => { setShowRepostMenu(false); toggleRepost(); }}
            />
            <div className="mx-3 border-t border-line" />
            <MenuItem
              icon={<CommentIcon className="h-4 w-4" />}
              label={t.postActions.quote}
              onClick={() => {
                setShowRepostMenu(false)
                if (!requireAuth()) return
                router.push(`/compose?quote=${post.id}`)
              }}
            />
          </Popover>
        </div>
      )}

      {/* Like */}
      <ActionButton
        label={liked ? t.postActions.unlike : t.postActions.like}
        count={likeCount}
        active={liked}
        loading={likePending}
        onClick={toggleLike}
        activeClass="text-danger"
        hoverClass="group-hover:bg-danger-tint group-hover:text-danger"
      >
        <span key={likeAnim} className={cn(likeAnim > 0 && 'inline-flex animate-[heart-pop_0.45s_ease-out]')}>
          <HeartIcon className={cn('h-[18px] w-[18px]', liked ? 'text-danger' : 'text-ink-faint')} filled={liked} />
        </span>
      </ActionButton>

      {/* Views */}
      <ActionButton
        label={t.postActions.views}
        count={post.views > 0 ? post.views : undefined}
      >
        <ViewIcon className="h-[18px] w-[18px] text-ink-faint" />
      </ActionButton>

      {/* Bookmark */}
      <ActionButton
        label={bookmarked ? t.postActions.removeBookmark : t.postActions.bookmark}
        count={bookmarkCount}
        active={bookmarked}
        loading={bookmarkPending}
        onClick={toggleBookmark}
        activeClass="text-brand"
        hoverClass="group-hover:bg-brand/10 group-hover:text-brand"
      >
        <BookmarkIcon className={cn('h-[18px] w-[18px]', bookmarked ? 'text-brand' : 'text-ink-faint')} filled={bookmarked} />
      </ActionButton>

      {/* Share */}
      <ShareButton post={post} variant="icon" />
    </div>
  )
}

export default PostActions
