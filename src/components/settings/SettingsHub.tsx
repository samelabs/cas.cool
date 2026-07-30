'use client'

import Link from 'next/link'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/cn'
import {
  UserIcon,
  ShieldIcon,
  SettingsIcon,
  ChevronRightIcon,
  VerifiedBadge,
  BadgeCheckIcon,
} from '@/components/icons'
import type { SafeUser } from '@/lib/types'

export function SettingsHub({ user }: { user: SafeUser }) {
  const isVerified = user.verificationStatus === 'verified'

  const cards = [
    {
      href: '/settings/profile',
      Icon: UserIcon,
      title: t.settings.profile,
      desc: t.settings.profileDesc,
    },
    {
      href: '/settings/security',
      Icon: ShieldIcon,
      title: t.settings.security,
      desc: t.settings.securityDesc,
    },
    {
      href: '/settings/api',
      Icon: SettingsIcon,
      title: t.api.title,
      desc: t.api.description,
      verifiedOnly: true,
    },
  ]

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      {/* Verification status banner */}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-2">
          {user.verificationStatus === 'verified' ? (
            <>
              <VerifiedBadge className="h-5 w-5 text-brand" />
              <span className="font-semibold text-ink">{t.common.verified}</span>
            </>
          ) : user.verificationStatus === 'pending' ? (
            <>
              <BadgeCheckIcon className="h-5 w-5 text-warning" />
              <span className="text-sm text-warning">{t.common.underReview}</span>
            </>
          ) : (
            <>
              <BadgeCheckIcon className="h-5 w-5 text-ink-faint" />
              <span className="text-sm text-ink-muted">{t.common.notVerified}</span>
            </>
          )}
        </div>
        <Link
          href="/verify"
          className="text-sm font-semibold text-brand hover:underline"
        >
          {user.verificationStatus === 'unverified' ? t.settings.getVerified : t.settings.viewDetails}
        </Link>
      </div>

      {/* Settings cards */}
      <div className="space-y-2">
        {cards.map((card) => {
          const locked = card.verifiedOnly && !isVerified
          return (
            <Link
              key={card.href}
              href={card.href}
              className={cn(
                'flex items-center gap-3 rounded-xl border border-line bg-surface p-4 transition',
                'hover:border-line-strong hover:bg-surface-hover',
              )}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-hover">
                <card.Icon className="h-5 w-5 text-ink-muted" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{card.title}</span>
                  {locked && (
                    <span className="rounded-full bg-warning-tint px-2 py-0.5 text-xs font-medium text-warning">
                      {t.api.verificationRequired}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-ink-muted line-clamp-2">{card.desc}</p>
              </div>
              <ChevronRightIcon className="h-5 w-5 shrink-0 text-ink-faint" />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
