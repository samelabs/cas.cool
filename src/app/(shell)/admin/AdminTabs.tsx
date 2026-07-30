'use client'

import Link from 'next/link'
import { t } from '@/lib/i18n'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/admin/verifications', label: t.admin.tabs.verifications },
  { href: '/admin/users', label: t.admin.tabs.users },
  { href: '/admin/reports', label: t.admin.tabs.reports },
]

export default function AdminTabs() {
  const pathname = usePathname()
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')

  return (
    <nav className="flex gap-1 px-4 pb-2">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          data-active={isActive(tab.href)}
          className="rounded-full px-4 py-1.5 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-hover data-[active=true]:bg-brand data-[active=true]:text-white"
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
