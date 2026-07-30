'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/ui/Button'
import { useCurrentUser } from '@/components/Providers'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import type { SafeUser } from '@/lib/types'
import { t } from '@/lib/i18n'
import { toggleFollow } from '@/actions/social'

export interface FollowButtonProps {
  /** The user to follow / unfollow. */
  targetUser: SafeUser
  initialFollowing?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

/**
 * Follow / Unfollow button with optimistic updates.
 *
 * Desktop: hover reveals an "Unfollow" state (red text + ✕ icon).
 * Mobile/touch: first tap arms the "confirm unfollow" state (shows red
 * "Unfollow" text), second tap executes. Auto-disarms after 3s timeout.
 * This prevents accidental unfollows on touch devices where there is no hover.
 */
export default function FollowButton({
  targetUser,
  initialFollowing = false,
  size = 'sm',
  className,
}: FollowButtonProps) {
  const router = useRouter()
  const currentUser = useCurrentUser()
  const { showToast } = useToast()
  const [following, setFollowing] = useState(initialFollowing)
  const [pending, setPending] = useState(false)
  // Armed = showing the "tap again to unfollow" confirm state (mobile)
  const [armed, setArmed] = useState(false)

  // Auto-disarm after 3 seconds so a stray tap doesn't linger
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(timer)
  }, [armed])

  // Never show a self-follow button.
  if (currentUser?.id === targetUser.id) return null

  const toggle = async () => {
    if (!currentUser) {
      showToast(t.profile.pleaseSignInToFollow, 'info')
      router.push('/login')
      return
    }
    if (pending) return

    // Mobile confirm: if following and not yet armed, arm first (don't unfollow).
    if (following && !armed) {
      setArmed(true)
      return
    }

    const next = !following
    setFollowing(next)
    setArmed(false)
    setPending(true)
    try {
      const result = await toggleFollow(targetUser.username)
      if (!result.ok) {
        throw new Error(result.error || t.profile.requestFailed)
      }
      // Refresh SSR data so other FollowButton instances (RightPanel suggestions,
      // profile page) reflect the new follow state without a manual page reload.
      router.refresh()
      showToast(result.data.following ? t.profile.followed : t.profile.unfollowed, 'success', 2000)
    } catch (err) {
      setFollowing(!next)
      showToast(err instanceof Error ? err.message : t.errors.somethingWrong, 'error')
    } finally {
      setPending(false)
    }
  }

  if (following) {
    return (
      <Button
        onClick={toggle}
        isLoading={pending}
        variant="outline"
        size={size}
        className={cn(
          'group min-w-[92px]',
          armed && 'border-danger/50 text-danger',
          className,
        )}
      >
        {/* ✓ check icon — hidden on hover (desktop) or when armed (mobile) */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn('h-4 w-4 group-hover:hidden', armed && 'hidden')}
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        {/* ✕ icon — shown on hover (desktop) or when armed (mobile) */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn('hidden h-4 w-4 group-hover:inline', armed && 'inline')}
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
        <span className={cn('group-hover:hidden', armed && 'hidden')}>{t.profile.following}</span>
        <span className={cn('hidden group-hover:inline text-danger', armed && 'inline')}>{t.profile.unfollow}</span>
      </Button>
    )
  }

  return (
    <Button
      onClick={toggle}
      isLoading={pending}
      variant="primary"
      size={size}
      className={cn('min-w-[92px]', className)}
    >
      {/* + plus icon for Follow */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
      {t.profile.follow}
    </Button>
  )
}
