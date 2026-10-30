'use client'

import Link from 'next/link'
import useSWRInfinite from 'swr/infinite'
import { useCallback, useMemo, useRef, useEffect } from 'react'
import { Avatar } from '@/components/ui/Avatar'
import { VerifiedBadge, HeartIcon, CommentIcon, RepostIcon, MailIcon, UserIcon, FlaskIcon, ShieldIcon } from '@/components/icons'
import { timeAgo } from '@/lib/utils'
import { t } from '@/lib/i18n'
import { SWRInfiniteSeed } from '@/components/posts/SWRInfiniteSeed'
import type { SafeNotification, SafeUser } from '@/lib/types'

const PAGE_SIZE = 30

const COPY = t.notifications.copy

function NotifIcon({ type }: { type: SafeNotification['type'] }) {
  const cls = 'h-5 w-5 text-brand'
  switch (type) {
    case 'LIKE': return <HeartIcon filled className={cls} />
    case 'COMMENT': return <CommentIcon className={cls} />
    case 'FOLLOW': return <UserIcon className={cls} />
    case 'REPOST': return <RepostIcon className={cls} />
    case 'MESSAGE': return <MailIcon className={cls} />
    case 'REPORT_RESOLVED': return <ShieldIcon className={cls} />
    default: return <FlaskIcon className={cls} />
  }
}

function NotificationRow({ n }: { n: SafeNotification }) {
  const from = n.from as SafeUser
  const displayName = from.displayName || from.username
  const username = from.username
  const avatar = from.avatar ?? null
  const verified = from.verificationStatus === 'verified'
  return (
    <Link
      href={
        n.type === 'FOLLOW'
          ? `/u/${username}`
          : n.type === 'MESSAGE'
            ? '/messages'
            : // A COMMENT notification opens the REPLY that triggered it
              // (anchored discussion), falling back to the parent post.
              n.replyShortCode
                ? `/p/${n.replyShortCode}`
                : n.postId
                  ? (n.postShortCode ? `/p/${n.postShortCode}` : '/notifications')
                  : `/u/${username}`
      }
      className="flex gap-3 border-b border-line px-4 py-3 transition-colors hover:bg-canvas/80 focus:outline-none"
    >
      <span className="mt-1 shrink-0 text-brand" aria-hidden>
        <NotifIcon type={n.type} />
      </span>
      <div className="min-w-0 flex-1">
        <Avatar src={avatar} name={displayName} username={username} size="sm" />
        <p className="mt-1.5 text-base text-ink">
          <span className="inline-flex items-center gap-1 font-semibold text-ink">
            {displayName}
            {verified && <VerifiedBadge className="h-4 w-4 text-brand" />}
          </span>{' '}
          <span className="text-ink-muted">{COPY[n.type]}</span>
        </p>
        <p className="text-xs text-ink-muted">{timeAgo(n.createdAt)}</p>
      </div>
      {!n.read && (
        <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label={t.notifications.unread} />
      )}
    </Link>
  )
}

export interface NotificationListProps {
  initialNotifications: SafeNotification[]
  initialCursor: string | null
}

interface ApiResponse {
  notifications: SafeNotification[]
  nextCursor: string | null
}

import { swrFetcher } from '@/lib/api-client'
import { post as apiPost } from '@/lib/api-client'
import { useBadges } from '@/components/BadgeProvider'

/**
 * Reusable cursor-based infinite notification list.
 *
 * Same contract as InfinitePostList: page 0 has a REAL key (/api/notifications)
 * seeded from SSR via SWRInfiniteSeed, so the first page is a cache hit and
 * every later page is a plain cursor fetch of the same data source. (The old
 * null page-0 key disabled SWRInfinite's iteration entirely — no page after
 * the first could ever load.)
 */
export default function NotificationList({ initialNotifications, initialCursor }: NotificationListProps) {
  const basePath = '/api/notifications'
  const firstPage = useMemo<ApiResponse>(
    () => ({ notifications: initialNotifications, nextCursor: initialCursor }),
    [initialNotifications, initialCursor],
  )

  return (
    <SWRInfiniteSeed cacheKey={basePath} page={firstPage}>
      <NotificationListInner initialNotifications={initialNotifications} />
    </SWRInfiniteSeed>
  )
}

function NotificationListInner({ initialNotifications }: { initialNotifications: SafeNotification[] }) {
  const basePath = '/api/notifications'
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { setNotificationCount } = useBadges()

  const getKey = useCallback(
    (pageIndex: number, previousPageData: ApiResponse | null): string | null => {
      if (pageIndex === 0) return basePath
      if (!previousPageData || !previousPageData.nextCursor) return null
      return `${basePath}?cursor=${encodeURIComponent(previousPageData.nextCursor)}`
    },
    [basePath],
  )

  const { data, error, isValidating, setSize, size } = useSWRInfinite<ApiResponse>(
    getKey,
    swrFetcher<ApiResponse>,
    { revalidateFirstPage: false },
  )

  // ── Per-page read confirmation (R8) ──
  // The SSR first page was confirmed server-side (revision-guarded) at
  // render time. Each subsequently FETCHED page the user has actually seen
  // is confirmed here via POST /api/notifications/ack with the (id,
  // revision) pair observed at fetch time — a stale confirmation can never
  // clear a re-activated row, and the badge converges to the server's
  // post-confirmation truth. Fires once per page; failures are silent
  // (the unread state simply stays until the next visit).
  const ackedPagesRef = useRef(new Set<number>())
  useEffect(() => {
    if (!data) return
    let cancelled = false
    ;(async () => {
      for (let pageIndex = 0; pageIndex < data.length; pageIndex++) {
        if (cancelled || ackedPagesRef.current.has(pageIndex)) continue
        const page = data[pageIndex]
        if (!page?.notifications?.length) continue
        const items = page.notifications
          .filter((n) => !n.read)
          .map((n) => ({ id: n.id, revision: n.revision }))
        if (items.length > 0) {
          const result = await apiPost<{ confirmed: number; unreadRemaining: number }>('/api/notifications/ack', { items })
          if (!cancelled && result.ok && result.data) {
            setNotificationCount(result.data.unreadRemaining)
          }
        }
        ackedPagesRef.current.add(pageIndex)
      }
    })()
    return () => { cancelled = true }
  }, [data, setNotificationCount])

  // Dedupe by id: a re-activation between cached pages could otherwise
  // render the same notification twice.
  const allNotifications = useMemo(() => {
    const source = data
      ? data.flatMap((page) => page?.notifications ?? [])
      : initialNotifications
    const seen = new Set<string>()
    return source.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
  }, [data, initialNotifications])

  const lastPage = data?.[data.length - 1]
  const reachingEnd = lastPage && lastPage.nextCursor === null && (data?.length ?? 0) > 0

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || reachingEnd) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isValidating) setSize(size + 1)
      },
      { rootMargin: '600px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [setSize, size, isValidating, reachingEnd])

  if (allNotifications.length === 0 && error) {
    return (
      <div className="py-6 text-center text-sm text-danger">{t.feed.failedToLoad}</div>
    )
  }

  return (
    <>
      {allNotifications.map((n) => (
        <NotificationRow key={n.id} n={n} />
      ))}

      {reachingEnd && allNotifications.length > PAGE_SIZE && (
        <div className="py-6 text-center text-sm text-ink-faint">{t.feed.endOfFeed}</div>
      )}

      <div ref={sentinelRef} className="h-1" />

      {error && (
        <div className="py-6 text-center text-sm text-danger">{t.feed.failedToLoad}</div>
      )}

      {isValidating && (
        <div className="flex justify-center py-6">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
        </div>
      )}
    </>
  )
}
