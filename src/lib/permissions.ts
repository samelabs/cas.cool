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
