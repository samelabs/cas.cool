/**
 * Permission helpers — single source of truth for gated features.
 *
 * Every function takes a user object with at least `verificationStatus`
 * (and `status` where relevant). Used on both server (API routes, server
 * components) and client (via SafeUser from context).
 *
 * Verification tiers:
 *   verified    → full platform access
 *   unverified  → limited access (shorter posts, no media uploads, etc.)
 *   pending     → same as unverified until admin approves
 */

export interface PermissionUser {
  verificationStatus: string
  status: string
}

/** Current membership verification for programmatic writes. Check expiry
 *  on every request, so an existing key cannot retain revoked privileges.
 *  - null/undefined expiresAt means indefinite/valid verification.
 *  - expiresAt <= now is expired.
 *  - invalid date cannot grant permission. */
export function hasCurrentVerification(user: {
  verificationStatus: string
  verificationExpiresAt?: Date | string | null
} | null, now = Date.now()): boolean {
  if (!user || user.verificationStatus !== 'verified') return false
  if (user.verificationExpiresAt === null || user.verificationExpiresAt === undefined) {
    return true
  }
  const expiry = new Date(user.verificationExpiresAt).getTime()
  if (Number.isNaN(expiry)) return false
  return expiry > now
}

export interface SafeVerificationSummary {
  status: string
  expiresAt: string | null
  isValid: boolean
}

export interface AccountQualifications {
  canProgrammaticWrite: boolean
  isVerified: boolean
  isSuspended: boolean
  isRestricted: boolean
}

export interface AccountCapabilities {
  authenticated: boolean
  method: 'session' | 'apikey' | 'anonymous'
  user: {
    id: string
    username: string
    displayName: string | null
    status: string
    role: string
    verificationStatus: string
  } | null
  verification: SafeVerificationSummary
  accountQualifications: AccountQualifications
  permissions: {
    canPublicRead: boolean
    canAccountRead: boolean
    canProgrammaticWrite: boolean
    canWebWrite: boolean
    canWrite: boolean
    canSearch: boolean
    canUploadMedia: boolean
    canDirectMessage: boolean
    canDirectMessageAnyone: boolean
    canAdmin: boolean
  }
  limits: {
    maxPostLength: number
    maxImages: number
    rateLimit: {
      readQuotaPerMinute: number
      writeQuotaPerMinute: number
    }
  }
  restrictions: string[]
}

export function computeCapabilities(
  identity: {
    authenticated: boolean
    method: 'session' | 'apikey' | 'anonymous'
    user: {
      id: string
      username: string
      displayName: string | null
      status: string
      role: string
      verificationStatus: string
      verificationExpiresAt?: Date | string | null
    } | null
  },
  now = Date.now(),
): AccountCapabilities {
  const user = identity.user
  const authenticated = identity.authenticated && !!user && user.status !== 'suspended'
  const isVerified = hasCurrentVerification(user, now)

  const verificationExpiresAt =
    user?.verificationExpiresAt instanceof Date
      ? user.verificationExpiresAt.toISOString()
      : typeof user?.verificationExpiresAt === 'string'
        ? user.verificationExpiresAt
        : null

  const verification: SafeVerificationSummary = {
    status: user?.verificationStatus ?? 'unverified',
    expiresAt: verificationExpiresAt,
    isValid: isVerified,
  }

  const restrictions: string[] = []
  if (!authenticated) {
    restrictions.push('Authentication required.')
  } else {
    if (user.status === 'suspended') {
      restrictions.push('Account is suspended.')
    } else if (user.status === 'restricted') {
      restrictions.push('Account is restricted to read-only access.')
    }

    if (identity.method === 'apikey' && !isVerified) {
      restrictions.push('Current verification is required for API and MCP writes.')
    }
    if (!canSearch(user)) {
      restrictions.push('Verification is required to use search.')
    }
    if (!canUploadMedia(user)) {
      restrictions.push('Verification is required to upload media.')
    }
  }

  const isActive = authenticated && user.status === 'active'
  const isRestricted = !!user && user.status === 'restricted'
  const isSuspended = !!user && user.status === 'suspended'
  const canProgrammaticWrite = isActive && identity.method === 'apikey' && isVerified
  const canWebWrite = isActive && identity.method === 'session'
  const canWrite = identity.method === 'apikey' ? canProgrammaticWrite : canWebWrite
  const canAdmin = isActive && user.role === 'admin' && (identity.method !== 'apikey' || isVerified)

  const accountQualifications: AccountQualifications = {
    canProgrammaticWrite: isActive && isVerified,
    isVerified,
    isSuspended,
    isRestricted,
  }

  const effectiveMaxPostLength = authenticated
    ? (identity.method === 'session' ? maxPostLength(user) : (isVerified ? MAX_POST_LENGTH_VERIFIED : MAX_POST_LENGTH_UNVERIFIED))
    : MAX_POST_LENGTH_UNVERIFIED

  const canDirectMessageAnyone = authenticated && canWrite && (
    identity.method === 'session' ? canDirectMessage(user) : isVerified
  )

  return {
    authenticated,
    method: identity.method,
    user: authenticated
      ? {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          status: user.status,
          role: user.role,
          verificationStatus: user.verificationStatus,
        }
      : null,
    verification,
    accountQualifications,
    permissions: {
      canPublicRead: true,
      canAccountRead: authenticated,
      canProgrammaticWrite,
      canWebWrite,
      canWrite,
      canSearch: authenticated && canSearch(user),
      canUploadMedia: authenticated && canWrite && canUploadMedia(user),
      canDirectMessage: authenticated && canWrite,
      canDirectMessageAnyone,
      canAdmin,
    },
    limits: {
      maxPostLength: effectiveMaxPostLength,
      maxImages: 4,
      rateLimit: {
        readQuotaPerMinute: 120,
        writeQuotaPerMinute: 60,
      },
    },
    restrictions,
  }
}

/** Maximum post length in characters. */
export const MAX_POST_LENGTH_VERIFIED = 2000
export const MAX_POST_LENGTH_UNVERIFIED = 300

export function maxPostLength(user: Pick<PermissionUser, 'verificationStatus'> | null): number {
  if (!user) return MAX_POST_LENGTH_UNVERIFIED
  return user.verificationStatus === 'verified'
    ? MAX_POST_LENGTH_VERIFIED
    : MAX_POST_LENGTH_UNVERIFIED
}

/** Verified members can upload images (post images, avatar, banner). */
export function canUploadMedia(user: Pick<PermissionUser, 'verificationStatus'> | null): boolean {
  return !!user && user.verificationStatus === 'verified'
}

/** Verified members can use search. */
export function canSearch(user: Pick<PermissionUser, 'verificationStatus'> | null): boolean {
  return !!user && user.verificationStatus === 'verified'
}

/**
 * DM permission check.
 * - Verified: can message anyone.
 * - Unverified: can only message users who follow them.
 */
export function canDirectMessage(
  sender: Pick<PermissionUser, 'verificationStatus'> | null,
): boolean {
  return !!sender && sender.verificationStatus === 'verified'
}

/** Whether the user needs to pass the "follows me?" check before DM. */
export function needsFollowerCheckForDM(
  sender: Pick<PermissionUser, 'verificationStatus'> | null,
): boolean {
  return !canDirectMessage(sender)
}
