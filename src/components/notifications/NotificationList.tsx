'use client'

import Link from 'next/link'
import useSWRInfinite from 'swr/infinite'
import { useRef, useEffect } from 'react'
import { Avatar } from '@/components/ui/Avatar'
import { VerifiedBadge, HeartIcon, CommentIcon, RepostIcon, MailIcon, UserIcon, FlaskIcon, ShieldIcon } from '@/components/icons'
import { timeAgo } from '@/lib/utils'
import { t } from '@/lib/i18n'
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
    case 'MENTION': return <FlaskIcon className={cls} />
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

export default function NotificationList({ initialNotifications, initialCursor }: NotificationListProps) {
  const sentinelRef = useRef<HTMLDivElement>(null)

  const { data, error, isValidating, setSize, size } = useSWRInfinite<ApiResponse>(
    (pageIndex, previousPageData) => {
      if (previousPageData && !previousPageData.notifications.length) return null
      // Page 0 is SSR data (no fetch needed).
      if (pageIndex === 0) return null
      // Use cursor from previous page.
      const cursor =
        previousPageData?.nextCursor ??
        initialCursor
      return cursor ? `/api/notifications?cursor=${encodeURIComponent(cursor)}` : null
    },
    swrFetcher<ApiResponse>,
    { revalidateFirstPage: false },
  )

  const allNotifications = [
    ...(initialNotifications ?? []),
    ...(data?.slice(1).flatMap((d) => d.notifications) ?? []),
  ]

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
