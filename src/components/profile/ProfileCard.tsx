import Link from 'next/link'
import { Avatar } from '@/components/ui/Avatar'
import FollowButton from '@/components/profile/FollowButton'
import { VerifiedBadge } from '@/components/icons'
import type { SafeUser } from '@/lib/types'

export interface ProfileCardProps {
  user: SafeUser
  initialFollowing?: boolean
}

/** Compact user card used in "Who to Follow" suggestions. Server-compatible. */
export function ProfileCard({ user, initialFollowing = false }: ProfileCardProps) {
  const displayName = user.displayName || user.username
  return (
    <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-hover">
      <Avatar
        src={user.avatar}
        name={displayName}
        username={user.username}
        size="md"
        href={`/u/${user.username}`}
      />
      <div className="min-w-0 flex-1">
        <Link href={`/u/${user.username}`} className="block group">
          <div className="flex items-center gap-1">
            <span className="truncate text-sm font-semibold text-ink group-hover:underline">
              {displayName}
            </span>
            {user.verificationStatus === 'verified' && (
              <VerifiedBadge className="h-4 w-4 shrink-0 text-brand" />
            )}
          </div>
          <p className="truncate text-sm text-ink-faint">@{user.username}</p>
        </Link>
        {user.bio && (
          <p className="mt-1 line-clamp-2 text-sm text-ink-muted">{user.bio}</p>
        )}
      </div>
      <FollowButton targetUser={user} initialFollowing={initialFollowing} />
    </div>
  )
}

export default ProfileCard
