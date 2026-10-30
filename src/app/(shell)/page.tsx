import { redirect } from 'next/navigation'
import { t } from '@/lib/i18n'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { TimelineFeed } from '@/components/posts/TimelineFeed'
import { MobileMenuDrawer } from '@/components/layout/MobileMenuDrawer'
import { FlaskIcon } from '@/components/icons'
import { getSiteConfig } from '@/lib/site'
import { getTimelinePage } from '@/lib/services/post.service'
import { BrandWordmark } from '@/components/layout/BrandWordmark'

export async function generateMetadata() {
  const site = await getSiteConfig()
  return { title: t.seo.homeTitle, description: site.description, alternates: { canonical: site.origin } }
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
  // Home feed always loads the initial page (page 0); deep cursors belong to
  // client-driven infinite pagination, never SSR-injected into page 0 cache keys.
  const feedResult = await getTimelinePage({
    tab: tab === 'following' ? 'following' : 'latest',
    userId: me?.id,
  })

  const initialPosts = feedResult.posts
  const nextCursor = feedResult.nextCursor

  return (
    <>
      {/*
       * Header below the sidebar's md breakpoint:
       *   [avatar]    [centered logo]    [spacer]
       * Avatar opens MobileMenuDrawer (slide-in panel with full nav).
       * At md and above, the sidebar supplies the brand and navigation.
       */}
      <header className="sticky top-0 z-30 border-b border-line bg-surface/80 backdrop-blur-md md:hidden">
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

          {/* Centered brand while the sidebar is hidden. */}
          <div className="flex flex-1 justify-center">
            <Link href="/" className="flex items-center gap-1.5">
              <FlaskIcon className="h-5 w-5 text-brand" />
              <span className="text-lg font-extrabold tracking-tight text-brand">
                <BrandWordmark />
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
