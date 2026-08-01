import { redirect } from 'next/navigation'
import { t } from '@/lib/i18n'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { TimelineFeed } from '@/components/posts/TimelineFeed'
import { MobileMenuDrawer } from '@/components/layout/MobileMenuDrawer'
import { FlaskIcon } from '@/components/icons'
import { SITE_URL } from '@/lib/site'
import { getTimelinePage } from '@/lib/services/post.service'

export const metadata = {
  title: t.seo.homeTitle,
  description:
    t.seo.homeDescription,
  alternates: {
    canonical: SITE_URL,
  },
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const [me, searchTab] = await Promise.all([
    getCurrentUser(),
    searchParams,
  ])
  const tab = searchTab.tab === 'following' ? 'following' : 'latest'

  if (!me && tab === 'following') redirect('/login')

  // Fetch feed — getCurrentUser already returns counts via userSelect.
  const feedResult = await getTimelinePage({
    tab: tab === 'following' ? 'following' : 'latest',
    userId: me?.id,
  })

  const initialPosts = feedResult.posts
  const nextCursor = feedResult.nextCursor

  return (
    <>
      {/*
       * Header — Twitter-style on mobile:
       *   [avatar]    [centered logo]    [spacer]
       * Avatar opens MobileMenuDrawer (slide-in panel with full nav).
       * On desktop (md+), logo is left-aligned (sidebar handles navigation).
       */}
      <header className="sticky top-0 z-30 border-b border-line bg-surface/80 backdrop-blur-md">
        <div className="flex h-[53px] items-center px-4">
          {me ? (
            <div className="md:hidden">
              <MobileMenuDrawer
                currentUser={me}
              />
            </div>
          ) : (
            <div className="md:hidden w-9" />
          )}

          {/* Logo: centered on mobile, left on desktop */}
          <div className="flex flex-1 justify-center md:justify-start">
            <Link href="/" className="flex items-center gap-1.5">
              <FlaskIcon className="h-5 w-5 text-brand" />
              <span className="text-lg font-extrabold tracking-tight text-brand">
                CAS<span className="text-ink">.cool</span>
              </span>
            </Link>
          </div>

          {/* Right spacer to balance the avatar on mobile */}
          <div className="w-9 md:hidden" />
        </div>
      </header>

      {/* Timeline: tabs + compose + infinite-scrolling feed (client-side) */}
      <TimelineFeed
        initialPosts={initialPosts}
        initialNextCursor={nextCursor}
        initialTab={tab}
        isLoggedIn={!!me}
      />
    </>
  )
}
