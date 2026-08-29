'use client'

import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Avatar } from '@/components/ui/Avatar'
import { useAuth } from '@/components/Providers'
import { useBadges } from '@/components/BadgeProvider'
import { cn } from '@/lib/cn'
import {
  FlaskIcon,
  HomeIcon,
  SearchIcon,
  BellIcon,
  MailIcon,
  BookmarkIcon,
  UserIcon,
  SettingsIcon,
  ShieldIcon,
  BadgeCheckIcon,
  LogoutIcon,
  XIcon,
} from '@/components/icons'
import type { SafeUser } from '@/lib/types'
import { t } from '@/lib/i18n'

export interface MobileMenuDrawerProps {
  currentUser: SafeUser
}

export function MobileMenuDrawer({
  currentUser,
}: MobileMenuDrawerProps) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const { logout } = useAuth()
  const { notificationCount, messageCount } = useBadges()

  // Close on route change — React pattern for adjusting state during render
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  const [prevPath, setPrevPath] = useState(pathname)
  if (prevPath !== pathname) {
    setPrevPath(pathname)
    setOpen(false)
  }

  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = ''
      }
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const items = [
    { label: t.nav.home, href: '/', Icon: HomeIcon, badge: 0 },
    { label: t.nav.explore, href: '/explore', Icon: SearchIcon, badge: 0 },
    { label: t.nav.notifications, href: '/notifications', Icon: BellIcon, badge: notificationCount },
    { label: t.nav.messages, href: '/messages', Icon: MailIcon, badge: messageCount },
    { label: t.nav.bookmarks, href: '/bookmarks', Icon: BookmarkIcon, badge: 0 },
    { label: t.nav.profile, href: `/u/${currentUser.username}`, Icon: UserIcon, badge: 0 },
    { label: t.nav.settings, href: '/settings', Icon: SettingsIcon, badge: 0 },
    { label: t.nav.verify, href: '/verify', Icon: BadgeCheckIcon, badge: 0 },
    ...(currentUser.role === 'admin'
      ? [{ label: t.nav.admin, href: '/admin', Icon: ShieldIcon, badge: 0 }]
      : []),
  ]

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <>
      {/* Avatar trigger */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t.nav.openMenu}
        className="flex items-center rounded-full active:scale-95 transition-transform"
      >
        <Avatar
          src={currentUser.avatar}
          name={currentUser.displayName || currentUser.username}
          username={currentUser.username}
          size="sm"
        />
      </button>

      {/* Overlay + drawer.
       * Portal to body: the in-page header carries backdrop-blur-md, which
       * makes it the containing block for fixed descendants — anchoring the
       * overlay to the 53px header instead of the viewport (drawer collapsed).
       * Rendering at body level keeps `fixed inset-0` viewport-anchored. */}
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-[60] md:hidden">
          {/* Backdrop — click to close */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
          />

          {/* Slide-in panel from left */}
          <nav
            className="absolute inset-y-0 left-0 flex w-[300px] max-w-[85vw] flex-col bg-surface shadow-2xl"
          >
            {/* Header with logo + close button */}
            <div className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-2">
                <FlaskIcon className="h-7 w-7 text-brand" />
                <span className="text-lg font-extrabold tracking-tight text-brand">
                  CAS<span className="text-ink">.cool</span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.nav.closeMenu}
                className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink active:scale-90"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            {/* User info */}
            <Link
              prefetch={false}
              href={`/u/${currentUser.username}`}
              className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-hover"
            >
              <Avatar
                src={currentUser.avatar}
                name={currentUser.displayName || currentUser.username}
                username={currentUser.username}
                size="md"
              />
              <div className="min-w-0 leading-tight">
                <div className="truncate text-base font-bold text-ink">
                  {currentUser.displayName || currentUser.username}
                </div>
                <div className="truncate text-sm text-ink-faint">
                  @{currentUser.username}
                </div>
              </div>
            </Link>

            {/* Divider */}
            <div className="mx-5 my-1 border-t border-line" />

            {/* Nav items */}
            <div className="flex-1 overflow-y-auto px-3 py-2">
              {items.map((item) => {
                const active = isActive(item.href)
                const { Icon } = item
                return (
                  <Link
                    prefetch={false}
                    key={item.label}
                    href={item.href}
                    className={cn(
                      'flex items-center gap-4 rounded-xl px-3 py-3 text-base transition-colors',
                      active
                        ? 'font-bold text-brand'
                        : 'font-medium text-ink hover:bg-surface-hover',
                    )}
                  >
                    <span className="relative">
                      <Icon className="h-[22px] w-[22px]" />
                      {item.badge > 0 && (
                        <span className="absolute -right-1.5 -top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-brand px-1 text-xs font-bold text-white ring-2 ring-surface">
                          {item.badge > 99 ? '99+' : item.badge}
                        </span>
                      )}
                    </span>
                    {item.label}
                  </Link>
                )
              })}
            </div>

            {/* Logout — extra bottom padding clears the fixed MobileNav */}
            <div className="border-t border-line px-3 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] pt-3">
              <button
                type="button"
                onClick={() => void logout()}
                className="flex w-full items-center gap-4 rounded-xl px-3 py-3 text-base font-medium text-ink-faint transition-colors hover:bg-danger-tint hover:text-danger"
              >
                <LogoutIcon className="h-[22px] w-[22px]" />
                {t.nav.logOut}
              </button>
            </div>
          </nav>
          </div>,
          document.body
        )}
    </>
  )
}

export default MobileMenuDrawer
