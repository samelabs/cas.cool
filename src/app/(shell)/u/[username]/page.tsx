import Link from 'next/link'
import { t } from '@/lib/i18n'
import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { VerifiedBadge, MapPinIcon, LinkIcon, CalendarIcon } from '@/components/icons'
import FollowButton from '@/components/profile/FollowButton'
import ProfileLogoutButton from '@/components/profile/ProfileLogoutButton'
import { InfinitePostList } from '@/components/posts/InfinitePostList'
import ProfileMenu from '@/components/profile/ProfileMenu'
import { formatNumber } from '@/lib/utils'
import { cn } from '@/lib/cn'
import type { Metadata } from 'next'
import { getUserWithCounts } from '@/lib/services/user.service'
import { getTimelinePage, checkFollow } from '@/lib/services/post.service'


const TABS = [
  { id: 'posts', label: t.profile.tabs.posts },
  { id: 'replies', label: t.profile.tabs.replies },
  { id: 'media', label: t.profile.tabs.media },
  { id: 'likes', label: t.profile.tabs.likes },
] as const

type TabId = (typeof TABS)[number]['id']

import { SITE_URL } from '@/lib/site'
export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>
}): Promise<Metadata> {
  const { username } = await params
  const user = await getUserWithCounts(username)

  if (!user) {
    return {
      title: t.profile.notFound,
      robots: { index: false, follow: false },
    }
  }

  // Suspended / restricted accounts: keep them out of the index.
  const noindex = user.status === 'suspended' || user.status === 'restricted'

  const name = user.displayName || user.username
  const url = `${SITE_URL}/u/${user.username}`
  const avatar = user.avatar || '/og-default.png'
  const verified = user.verificationStatus === 'verified'

  // Rich description: bio + stats + context, truncated to ~160 chars for SERP.
  const stats = `${user._count?.posts ?? 0} posts · ${user._count?.followers ?? 0} followers`
  const parts = [
    user.bio,
    stats,
    user.location,
  ].filter(Boolean)
  const description = parts.join(' · ').slice(0, 160)

  const ogDescription = [
    user.bio,
    stats,
    verified ? 'Verified' : null,
    user.location,
  ].filter(Boolean).join(' · ')

  return {
    title: `${name} (@${user.username})`,
    description,
    alternates: { canonical: url },
    robots: noindex ? { index: false, follow: false } : { index: true, follow: true },
    openGraph: {
      title: `${name} (@${user.username})`,
      description: ogDescription.slice(0, 200),
      url,
      siteName: t.seo.siteName,
      type: 'profile',
      images: [{ url: avatar, alt: `${name} avatar` }],
    },
    twitter: {
      card: 'summary',
      title: `${name} (@${user.username})`,
      description: ogDescription.slice(0, 200),
      images: [avatar],
    },
  }
}

function asTab(v: string | string[] | undefined): TabId {
  return TABS.some((t) => t.id === v) ? (v as TabId) : 'posts'
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const { username } = await params
  const [me, profile] = await Promise.all([
    getCurrentUser(),
    getUserWithCounts(username),
  ])
  if (!profile) notFound()

  const user = profile
  const isSelf = me?.id === user.id
  const tab = asTab((await searchParams).tab)

  // Parallel: follow-check + feed
  const [isFollowing, feedData] = await Promise.all([
    me ? checkFollow(me.id, user.id) : Promise.resolve(false),
    tab === 'likes'
      ? getTimelinePage({ tab: 'latest', likedBy: user.id, userId: me?.id }).then((result) => ({
          posts: result.posts,
          nextCursor: result.nextCursor,
          basePath: `/api/posts?likedBy=${user.id}`,
        }))
      : getTimelinePage({
          tab: 'latest',
          author: user.id,
          scope: tab === 'replies' ? 'replies' : tab === 'media' ? 'media' : undefined,
          userId: me?.id,
        }).then((result) => ({
          posts: result.posts,
          nextCursor: result.nextCursor,
          basePath:
            tab === 'replies' ? `/api/posts?tab=latest&author=${user.id}&scope=replies`
            : tab === 'media' ? `/api/posts?tab=latest&author=${user.id}&scope=media`
            : `/api/posts?tab=latest&author=${user.id}`,
        })),
  ])

  const { posts: initialPosts, nextCursor, basePath } = feedData
  const displayName = user.displayName || user.username
  const joinDate = new Date(user.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/80 px-4 backdrop-blur-md">
        <div className="flex h-[53px] items-center gap-4">
          <Link href="/" className="grid h-9 w-9 place-items-center rounded-full hover:bg-surface-hover/70">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
            </svg>
          </Link>
          <div className="min-w-0">
            <h1 className="flex items-center gap-1 truncate text-lg font-extrabold text-ink">
              {displayName}
              {user.verificationStatus === 'verified' && <VerifiedBadge className="h-4 w-4 text-brand" />}
            </h1>
            <p className="text-xs text-ink-muted">{formatNumber(user._count?.posts ?? 0)} posts</p>
          </div>
          <ProfileMenu user={user} isSelf={isSelf} />
        </div>
      </header>

      {/* Banner — 3:1 aspect ratio (matches the crop modal exactly). */}
      <div className="aspect-[3/1] w-full bg-gradient-to-r from-brand to-brand-ink">
        {user.banner && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.banner} alt="" className="h-full w-full object-cover" />
        )}
      </div>

      {/* Identity row */}
      <div className="px-4">
        <div className="-mt-16 flex items-end justify-between">
          <Avatar
            src={user.avatar}
            name={displayName}
            username={user.username}
            size="xl"
          />
          <div className="mb-3 flex gap-2">
            {isSelf ? (
              <>
                <Button href="/settings" variant="secondary" size="sm">
                  {t.profile.editProfile}
                </Button>
                <ProfileLogoutButton />
              </>
            ) : (
              <>
                <Link
                  href={`/messages/new?to=${user.id}`}
                  className="inline-flex h-9 items-center justify-center rounded-full bg-surface px-4 text-sm font-semibold text-ink ring-1 ring-line-strong transition-colors hover:bg-surface-hover"
                >
                  {t.profile.message}
                </Link>
                <FollowButton
                  targetUser={user}
                  initialFollowing={isFollowing}
                  size="sm"
                />
              </>
            )}
          </div>
        </div>

        <div className="mt-3">
          <div className="flex items-center gap-1">
            <h2 className="text-xl font-extrabold text-ink">{displayName}</h2>
            {user.verificationStatus === 'verified' && <VerifiedBadge className="h-5 w-5 text-brand" />}
          </div>
          <p className="text-ink-muted">@{user.username}</p>

          {user.bio && <p className="mt-3 whitespace-pre-wrap text-base text-ink">{user.bio}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-faint">
            {user.location && (
              <span className="inline-flex items-center gap-1">
                <MapPinIcon className="h-4 w-4" />
                {user.location}
              </span>
            )}
            {user.website && (
              <a
                href={user.website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-brand hover:underline"
              >
                <LinkIcon className="h-4 w-4" />
                {user.website.replace(/^https?:\/\//, '')}
              </a>
            )}
            <span className="inline-flex items-center gap-1">
              <CalendarIcon className="h-4 w-4" />
              Joined {joinDate}
            </span>
          </div>

          <div className="mt-3 flex gap-5 text-sm">
            <span>
              <span className="font-bold text-ink">
                {formatNumber(user._count?.following ?? 0)}
              </span>{' '}
              <span className="text-ink-muted">{t.profile.following}</span>
            </span>
            <span>
              <span className="font-bold text-ink">
                {formatNumber(user._count?.followers ?? 0)}
              </span>{' '}
              <span className="text-ink-muted">{t.profile.followers}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <nav className="mt-4 flex border-b border-line">
        {TABS.map((t) => {
          const active = tab === t.id
          return (
            <Link
              key={t.id}
              href={`/u/${user.username}?tab=${t.id}`}
              className={cn(
                'relative flex-1 py-4 text-center text-base font-semibold transition-colors hover:bg-surface-hover',
                active ? 'text-ink' : 'text-ink-muted',
              )}
            >
              {t.label}
              {active && (
                <span className="absolute bottom-0 left-1/2 h-1 w-12 -translate-x-1/2 rounded-full bg-brand" />
              )}
            </Link>
          )
        })}
      </nav>

      {/* Feed */}
      <InfinitePostList
        basePath={basePath}
        initialPosts={initialPosts}
        initialNextCursor={nextCursor}
        variant={tab === 'media' ? 'media' : 'feed'}
        emptyMessage={t.feed.nothingHereYet}
      />
    </>
  )
}
