'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Avatar } from '@/components/ui/Avatar'
import { cn } from '@/lib/cn'
import { useCurrentUser, useAuth } from '@/components/Providers'
import {
  BellIcon,
  SearchIcon,
  FlaskIcon,
  HomeIcon,
  MailIcon,
  SettingsIcon,
  UserIcon,
  BookmarkIcon,
  ShieldIcon,
  BadgeCheckIcon,
  LogoutIcon,
  VerifiedBadge,
} from '@/components/icons'
import { useBadges } from '@/components/BadgeProvider'
import type { SafeUser } from '@/lib/types'
import { t } from '@/lib/i18n'

export interface SidebarProps {
  currentUser?: SafeUser | null
  needsDocuments?: boolean
}

interface NavItem {
  label: string
  href: string
  Icon: (props: { className?: string }) => React.ReactNode
  badge?: number
  alert?: boolean
  match: 'exact' | 'prefix'
}

function Badge({ count }: { count: number }) {
  if (!count) return null
  return (
    <span className="absolute -top-1 -right-1 flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-brand px-1 text-[11px] font-bold text-white ring-2 ring-surface">
      {count > 99 ? '99+' : count}
    </span>
  )
}

export function Sidebar({ currentUser: userProp, needsDocuments = false }: SidebarProps) {
  const pathname = usePathname()
  const ctxUser = useCurrentUser()
  const { logout } = useAuth()
  const { notificationCount, messageCount } = useBadges()
  const currentUser = userProp ?? ctxUser

  const items: NavItem[] = [
    { label: t.nav.home, href: '/', Icon: HomeIcon, match: 'exact' },
    { label: t.nav.explore, href: '/explore', Icon: SearchIcon, match: 'prefix' },
    { label: t.nav.notifications, href: '/notifications', Icon: BellIcon, badge: notificationCount, match: 'prefix' },
    { label: t.nav.messages, href: '/messages', Icon: MailIcon, badge: messageCount, match: 'prefix' },
    { label: t.nav.bookmarks, href: '/bookmarks', Icon: BookmarkIcon, match: 'prefix' },
    {
      label: t.nav.profile,
      href: currentUser ? `/u/${currentUser.username}` : '/login',
      Icon: UserIcon,
      match: 'prefix',
    },
    { label: t.nav.settings, href: '/settings', Icon: SettingsIcon, match: 'prefix' },
    { label: t.nav.verify, href: '/verify', Icon: BadgeCheckIcon, alert: needsDocuments, match: 'prefix' },
    ...(currentUser?.role === 'admin'
      ? [{ label: t.nav.admin, href: '/admin', Icon: ShieldIcon, match: 'prefix' as const }]
      : []),
  ]

  const isActive = (item: NavItem) =>
    item.match === 'exact' ? pathname === item.href : pathname.startsWith(item.href)

  return (
    <nav className="flex h-full w-full flex-col gap-0.5 py-1 pl-2 pr-1 xl:px-3">
      {/* Logo */}
      <Link
        href="/"
        className="mb-2 flex items-center justify-center rounded-full px-2 py-3 text-brand transition-colors hover:bg-surface-hover xl:justify-start xl:gap-2"
        title={t.brand.name}
      >
        <FlaskIcon className="h-8 w-8 shrink-0" />
        <span className="hidden text-xl font-extrabold tracking-tight xl:inline">
          CAS<span className="text-ink">.cool</span>
        </span>
      </Link>

      {/* Nav items */}
      {items.map((item) => {
        const active = isActive(item)
        const { Icon } = item
        return (
          <Link
            key={item.label}
            href={item.href}
            aria-label={item.label}
            title={item.label}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex items-center justify-center rounded-full px-2 py-2.5 text-lg transition-colors xl:justify-start xl:gap-4 xl:px-3',
              active
                ? 'font-bold text-ink'
                : 'font-normal text-ink-muted hover:bg-surface-hover hover:text-ink',
            )}
          >
            <span className="relative shrink-0">
              <Icon
                className={cn(
                  'h-7 w-7 transition-colors',
                  active ? 'text-brand' : 'text-ink-muted group-hover:text-ink',
                )}
              />
              {typeof item.badge === 'number' && item.badge > 0 && <Badge count={item.badge} />}
              {item.alert && (
                <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warning" />
                </span>
              )}
            </span>
            <span className="hidden xl:inline">{item.label}</span>
          </Link>
        )
      })}

      {/* Current user card + logout */}
      <div className="mt-auto pt-2">
        {currentUser ? (
          <div className="flex flex-col items-center gap-0.5 xl:flex-row xl:items-center xl:gap-1">
            <Link
              href={`/u/${currentUser.username}`}
              className="flex min-w-0 flex-1 items-center justify-center rounded-full p-2 transition-colors hover:bg-surface-hover xl:justify-start xl:gap-3"
              title={currentUser.displayName || currentUser.username}
            >
              <Avatar user={currentUser} size="md" />
              <div className="hidden min-w-0 flex-1 leading-tight xl:block">
                <div className="flex items-center gap-1 text-sm font-semibold text-ink">
                  <span className="truncate">{currentUser.displayName || currentUser.username}</span>
                  {currentUser.verificationStatus === 'verified' && (
                    <VerifiedBadge className="h-4 w-4 shrink-0 text-brand" />
                  )}
                </div>
                <div className="truncate text-sm text-ink-faint">@{currentUser.username}</div>
              </div>
            </Link>
            <button
              type="button"
              onClick={() => void logout()}
              aria-label={t.nav.logOut}
              title={t.nav.logOut}
              className="flex items-center justify-center rounded-full p-2.5 text-lg text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink xl:px-3 xl:text-base"
            >
              <LogoutIcon className="h-7 w-7" />
            </button>
          </div>
        ) : null}
      </div>
    </nav>
  )
}

export default Sidebar
