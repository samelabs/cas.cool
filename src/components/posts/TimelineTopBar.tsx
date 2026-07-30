'use client'

import Link from 'next/link'
import { ComposeBox } from '@/components/posts/ComposeBox'
import { FlaskIcon } from '@/components/icons'
import { useAuth } from '@/components/Providers'
import type { SafePost } from '@/lib/types'

/**
 * Timeline top area — compact compose box for quick posting.
 *
 * User info and logout were removed now that the mobile header avatar
 * (MobileMenuDrawer) and desktop sidebar handle navigation + identity.
 *
 * For logged-out visitors, shows a login/register prompt with brand styling.
 */
export default function TimelineTopBar({
  onPosted,
}: {
  onPosted?: (post: SafePost) => void
}) {
  const { currentUser } = useAuth()

  if (!currentUser) {
    return (
      <div className="border-b border-line bg-brand-tint/30">
        <div className="flex flex-col items-center gap-3 px-6 py-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 ring-1 ring-brand/20">
            <FlaskIcon className="h-6 w-6 text-brand" />
          </div>
          <p className="text-[15px] font-semibold leading-snug text-ink">
            Discover and share chemistry.
          </p>
          <p className="-mt-1 text-[13px] leading-snug text-ink-muted">
            CAS-numbered posts, member connections, real-time updates.
          </p>
          <div className="mt-1 flex w-full items-center gap-3">
            <Link
              href="/login"
              className="flex-1 rounded-full bg-surface py-2.5 text-center text-[15px] font-bold text-brand ring-1 ring-brand/30 transition-colors hover:bg-brand-tint"
            >
              Log in
            </Link>
            <Link
              href="/register"
              className="flex-1 rounded-full bg-brand py-2.5 text-center text-[15px] font-bold text-white transition-colors hover:bg-brand-strong"
            >
              Sign up
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Logged in: just the compact compose box
  return (
    <div className="border-b border-line">
      <ComposeBox compact hideAvatar onPosted={onPosted} />
    </div>
  )
}
