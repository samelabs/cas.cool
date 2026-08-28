import Link from 'next/link'
import { t } from '@/lib/i18n'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import SearchBox from '@/components/layout/SearchBox'
import { ProfileCard } from '@/components/profile/ProfileCard'
import { InfinitePostList } from '@/components/posts/InfinitePostList'
import { TrendingIcon, FlaskIcon } from '@/components/icons'
import { canSearch } from '@/lib/permissions'
import { getTrendingChemicals } from '@/lib/services/user.service'
import {
  searchPostsFirstPage,
  getSearchSuggestions,
  getMatchingChemicals,
} from '@/lib/services/search.service'
import { getTimelinePage } from '@/lib/services/post.service'
import type { SafePost, SafeUser } from '@/lib/types'

export const metadata = { title: t.explore.title }

function asString(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? '' : v ?? ''
}

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>
}) {
  const q = asString((await searchParams).q).trim()
  const me = await getCurrentUser()
  const searchAllowed = canSearch(me)
  const searching = searchAllowed && q.length > 0

  // Trending sidebar — always fetched (shown in browse mode).
  const trendingCas = await getTrendingChemicals(8)

  let initialPosts: SafePost[] = []
  let nextCursor: string | null = null
  let basePath: string
  let users: SafeUser[] = []
  let matchedChemicals: { casNumber: string; name: string | null; postCount: number }[] = []

  if (searching) {
    // Search: SSR query for first page + entry-point suggestions (chemicals,
    // CAS number (when query is CAS-like). Chemical name is NOT searched
    // because it's system-maintained and currently empty — CAS number
    // matching is sufficient for chemical lookups.
    const [postsResult, suggestionsResult, chemicalsResult] = await Promise.all([
      searchPostsFirstPage(q, me?.id),
      getSearchSuggestions(q),
      getMatchingChemicals(q, 5),
    ])

    initialPosts = postsResult.posts
    nextCursor = postsResult.nextCursor
    users = suggestionsResult.users
    matchedChemicals = chemicalsResult
    basePath = `/api/search?q=${encodeURIComponent(q)}`
  } else {
    // Browse: SSR-seed with engagement-ranked recommended feed.
    // Explore is the discovery page — surfaces high-engagement content
    // that users might not see in the chronological home timeline.
    const result = await getTimelinePage({ tab: 'foryou', userId: me?.id })
    initialPosts = result.posts
    nextCursor = result.nextCursor
    basePath = '/api/posts?tab=foryou'
  }

  return (
    <>
      <PageHeader title={t.explore.title} backHref="/">
        {searchAllowed && (
          <div className="border-b border-line p-3">
            <SearchBox initialQuery={q} />
          </div>
        )}
      </PageHeader>

      {!searching && (
        <section className="border-b border-line">
          <h2 className="flex items-center gap-2 px-4 py-3 text-lg font-bold text-ink">
            <TrendingIcon className="h-5 w-5 text-brand" />
            {t.explore.trendingChemicals}
          </h2>
          {trendingCas.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-ink-muted">{t.explore.noTrending}</p>
          ) : (
            <div className="grid grid-cols-2">
              {trendingCas.map((c, i) => (
                <Link
                  key={c.casNumber}
                  href={`/cas/${c.casNumber}`}
                  className="border-b border-r border-line px-4 py-3 transition-colors hover:bg-canvas/80"
                >
                  <p className="text-xs text-ink-muted">{t.explore.trending(i + 1)}</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-brand-ink">
                    CAS {c.casNumber}
                  </p>
                  {c.name && <p className="truncate text-sm text-ink-muted">{c.name}</p>}
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {c.postCount.toLocaleString()} posts
                  </p>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {searching && matchedChemicals.length > 0 && (
        <section className="border-b border-line">
          {matchedChemicals.map((c) => (
            <Link
              key={c.casNumber}
              href={`/cas/${c.casNumber}`}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-tint">
                <FlaskIcon className="h-5 w-5 text-brand" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm font-semibold text-brand-ink">
                  CAS {c.casNumber}
                </p>
                {c.name && <p className="truncate text-sm text-ink-muted">{c.name}</p>}
              </div>
              <span className="shrink-0 text-xs text-ink-faint">
                {c.postCount.toLocaleString()} posts
              </span>
            </Link>
          ))}
        </section>
      )}

      {searching && users.length > 0 && (
        <section className="border-b border-line">
          <h2 className="px-4 py-3 text-sm font-bold uppercase tracking-wide text-ink-faint">
            {t.explore.people}
          </h2>
          {users.map((u) => (
            <ProfileCard key={u.id} user={u} />
          ))}
        </section>
      )}

      <InfinitePostList
        basePath={basePath}
        initialPosts={initialPosts}
        initialNextCursor={nextCursor}
        emptyMessage={searching ? t.explore.noResults(q) : t.explore.noPosts}
      />
    </>
  )
}
