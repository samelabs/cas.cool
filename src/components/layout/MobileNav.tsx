'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'
import {
  BellIcon,
  SearchIcon,
  HomeIcon,
  MailIcon,
  PlusIcon,
} from '@/components/icons'
import { useBadges } from '@/components/BadgeProvider'
import { t } from '@/lib/i18n'

export function MobileNav() {
  const pathname = usePathname()
  const { notificationCount, messageCount } = useBadges()
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href))

  return (
    <nav className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-50 flex items-center justify-around border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-lg md:hidden">
      {/* Home */}
      <NavIcon href="/" active={isActive('/')} Icon={HomeIcon} />

      {/* Explore */}
      <NavIcon href="/explore" active={isActive('/explore') || isActive('/search')} Icon={SearchIcon} />

      {/* Center compose */}
      <Link
        href="/compose"
        aria-label={t.nav.newPost}
        className="-mt-5 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand text-white shadow-lg shadow-brand/30 transition-transform hover:scale-105 active:scale-95"
      >
        <PlusIcon className="h-6 w-6" />
      </Link>

      {/* Notifications */}
      <NavIcon
        href="/notifications"
        active={isActive('/notifications')}
        Icon={BellIcon}
        badge={notificationCount}
      />

      {/* Messages */}
      <NavIcon
        href="/messages"
        active={isActive('/messages')}
        Icon={MailIcon}
        badge={messageCount}
      />
    </nav>
  )
}

function NavIcon({
  href,
  active,
  Icon,
  badge = 0,
}: {
  href: string
  active: boolean
  Icon: (props: { className?: string }) => React.ReactNode
  badge?: number
}) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className="relative flex h-14 w-full items-center justify-center">
      <span className="relative">
        <Icon className={cn('h-6 w-6 transition-colors', active ? 'text-brand' : 'text-ink-faint')} />
        {badge > 0 && (
          <span className="absolute -right-1.5 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-white ring-2 ring-surface">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
    </Link>
  )
}

export default MobileNav
