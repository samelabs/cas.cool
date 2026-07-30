/**
 * Layout service — sidebar and navigation data.
 * Shared by the root ShellLayout (SSR prefetch).
 */

import { prisma } from '@/lib/db'
import { getTrendingChemicals, getFollowSuggestions } from './user.service'
import { getUnreadNotificationCount } from './notify.service'
import { getUnreadMessageCount } from './message.service'
import type { SafeUser } from '@/lib/types'
import type { TrendingChemical } from './user.service'

export interface LayoutData {
  trending: TrendingChemical[]
  suggestions: SafeUser[]
  notificationCount: number
  messageCount: number
  needsDocuments: boolean
}

export interface SidebarData {
  trending: TrendingChemical[]
  suggestions: SafeUser[]
}

/**
 * Fetch all layout data in parallel for the shell layout.
 */
export async function getLayoutData(
  currentUserId: string | null,
  userVerificationStatus?: string | null,
): Promise<LayoutData> {
  if (!currentUserId) {
    const trending = await getTrendingChemicals(5)
    return {
      trending,
      suggestions: [],
      notificationCount: 0,
      messageCount: 0,
      needsDocuments: false,
    }
  }

  const [trending, suggestions, notificationCount, messageCount, hasApprovedSubmission] = await Promise.all([
    getTrendingChemicals(5),
    getFollowSuggestions(currentUserId, 5),
    getUnreadNotificationCount(currentUserId),
    getUnreadMessageCount(currentUserId),
    // Verified but no approved submission on file → remind user to submit documents
    userVerificationStatus === 'verified'
      ? prisma.verificationSubmission
          .findFirst({ where: { userId: currentUserId, status: 'approved' }, select: { id: true } })
          .then((r) => !r)
          .catch(() => false)
      : Promise.resolve(false),
  ])

  return {
    trending,
    suggestions,
    notificationCount,
    messageCount,
    needsDocuments: hasApprovedSubmission,
  }
}

/**
 * Sidebar-only data (for pages that fetch their own main content).
 */
export async function getSidebarData(currentUserId: string | null): Promise<SidebarData> {
  if (!currentUserId) {
    return { trending: await getTrendingChemicals(8), suggestions: [] }
  }

  const [trending, suggestions] = await Promise.all([
    getTrendingChemicals(8),
    getFollowSuggestions(currentUserId, 5),
  ])

  return { trending, suggestions }
}
