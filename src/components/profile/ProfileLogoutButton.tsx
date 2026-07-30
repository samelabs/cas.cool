'use client'

import { useAuth } from '@/components/Providers'
import { LogoutIcon } from '@/components/icons'

/**
 * Logout button for the profile page — shown only when viewing your own profile.
 */
export default function ProfileLogoutButton() {
  const { logout } = useAuth()

  return (
    <button
      type="button"
      onClick={() => void logout()}
      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-surface px-4 text-sm font-semibold text-ink-faint ring-1 ring-line-strong transition-colors hover:bg-danger-tint hover:text-danger hover:ring-danger"
    >
      <LogoutIcon className="h-4 w-4" />
      Log out
    </button>
  )
}
