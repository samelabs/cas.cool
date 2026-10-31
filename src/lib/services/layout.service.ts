/**
 * Layout service — sidebar and navigation data.
 * Shared by the root ShellLayout (SSR prefetch).
 */

import { prisma } from '@/lib/db'
import { getTrendingChemicals } from './user.service'
import { getUnreadNotificationCount } from './notify.service'
import { getUnreadMessageCount } from './message.service'
import type { TrendingChemical } from './user.service'

export interface LayoutData {
  trending: TrendingChemical[]
  notificationCount: number
  messageCount: number
  needsDocuments: boolean
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
      notificationCount: 0,
      messageCount: 0,
      needsDocuments: false,
    }
  }

  const [trending, notificationCount, messageCount, hasApprovedSubmission] = await Promise.all([
    getTrendingChemicals(5),
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
    notificationCount,
    messageCount,
    needsDocuments: hasApprovedSubmission,
  }
}
