import Link from 'next/link'
import { ProfileCard } from '@/components/profile/ProfileCard'
import { SearchIcon, TrendingIcon, SparklesIcon } from '@/components/icons'
import type { SafeUser } from '@/lib/types'
import { t } from '@/lib/i18n'
import { VERSION, GITHUB_URL } from '@/lib/version'

export interface TrendingChemical {
  casNumber: string
  name?: string | null
  postCount: number
}

export interface RightPanelProps {
  trending?: TrendingChemical[]
  suggestions?: SafeUser[]
}

function TrendingRow({ rank, item }: { rank: number; item: TrendingChemical }) {
  return (
    <Link
      href={`/cas/${item.casNumber}`}
      className="block rounded-xl px-4 py-2.5 transition-colors hover:bg-surface-hover"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-faint">
          {t.explore.trending(rank)}
        </span>
        <TrendingIcon className="h-3.5 w-3.5 text-brand" />
      </div>
      <p className="mt-0.5 truncate font-mono text-sm font-semibold text-brand-ink">
        CAS {item.casNumber}
      </p>
      {item.name && <p className="truncate text-sm text-ink-muted">{item.name}</p>}
      <p className="mt-0.5 text-xs text-ink-faint">{item.postCount.toLocaleString()} posts</p>
    </Link>
  )
}

export function RightPanel({ trending = [], suggestions = [] }: RightPanelProps) {
  return (
    <div className="flex h-full w-full flex-col gap-4 px-4 py-2">
      {/* Search */}
      <form action="/explore" method="get" className="sticky top-0 z-10 bg-surface/80 py-2 backdrop-blur">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            name="q"
            placeholder={t.explore.sidebarSearchPlaceholder}
            aria-label={t.common.search}
            className="w-full rounded-full border border-transparent bg-surface-hover py-2.5 pl-12 pr-4 text-base text-ink placeholder:text-ink-faint focus:border-brand focus:bg-surface focus:outline-none transition-colors"
          />
        </div>
      </form>

      {/* Trending */}
      <section className="overflow-hidden rounded-2xl bg-surface-hover/50">
        <h2 className="flex items-center gap-2 px-4 py-3 text-lg font-bold text-ink">
          <TrendingIcon className="h-5 w-5 text-brand" />
          {t.explore.trendingChemicals}
        </h2>
        {trending.length > 0 ? (
          <div className="flex flex-col">
            {trending.slice(0, 5).map((item, i) => (
              <TrendingRow key={item.casNumber} rank={i + 1} item={item} />
            ))}
          </div>
        ) : (
          <p className="px-4 pb-4 text-sm text-ink-muted">
            {t.explore.noTrending}
          </p>
        )}
        <Link
          href="/explore"
          className="block border-t border-line/50 px-4 py-3 text-sm text-brand hover:bg-surface-hover"
        >
          Show more
        </Link>
      </section>

      {/* Who to follow */}
      <section className="overflow-hidden rounded-2xl bg-surface-hover/50">
        <h2 className="flex items-center gap-2 px-4 py-3 text-lg font-bold text-ink">
          <SparklesIcon className="h-5 w-5 text-info" />
          Who to Follow
        </h2>
        {suggestions.length > 0 ? (
          <div className="flex flex-col">
            {suggestions.slice(0, 3).map((user) => (
              <ProfileCard key={user.id} user={user} />
            ))}
          </div>
        ) : (
          <p className="px-4 pb-4 text-sm text-ink-muted">{t.explore.noSuggestions}</p>
        )}
        <Link
          href="/explore"
          className="block border-t border-line px-4 py-3 text-sm text-brand hover:bg-surface-hover"
        >
          Find more people
        </Link>
      </section>

      <footer className="px-1 text-xs leading-relaxed text-ink-faint">
        <p>
          <Link href="/about" className="hover:text-ink-muted">{t.about.title}</Link> ·{' '}
          <Link href="/explore" className="hover:text-ink-muted">{t.nav.explore}</Link> ·{' '}
          <Link href="/settings" className="hover:text-ink-muted">{t.nav.settings}</Link>
        </p>
        <p className="mt-1">© {new Date().getFullYear()} CAS.cool · <Link href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-ink-muted">v{VERSION}</Link></p>
      </footer>
    </div>
  )
}

export default RightPanel
