'use client'

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'

/**
 * Badge counts for the navigation — notification + message unread totals.
 *
 * **Why this exists:** The counts are fetched server-side in `(shell)/layout.tsx`
 * and passed as initial values here.  The shell layout (a Server Component)
 * does NOT re-render on client-side navigation, so the static props would be
 * stale until a full page refresh.  This context holds the counts in React
 * state, allowing client components (notifications page, conversation page) to
 * update them instantly when the user reads notifications/messages.
 *
 * Consumers:
 *   - Sidebar, MobileNav, MobileMenuDrawer → display the counts
 *   - NotificationBadgeSync (notifications page) → clears notification count
 *   - MessageBadgeSync (conversation page) → decrements message count
 */

interface BadgeContextValue {
  notificationCount: number
  messageCount: number
  setNotificationCount: (n: number) => void
  decrementMessages: (n: number) => void
}

const BadgeContext = createContext<BadgeContextValue | null>(null)

/** Read badge counts + updaters.  Returns zeros if used outside BadgeProvider. */
export function useBadges(): BadgeContextValue {
  const ctx = useContext(BadgeContext)
  if (!ctx) {
    return { notificationCount: 0, messageCount: 0, setNotificationCount: () => {}, decrementMessages: () => {} }
  }
  return ctx
}

export function BadgeProvider({
  initialNotificationCount = 0,
  initialMessageCount = 0,
  children,
}: {
  initialNotificationCount?: number
  initialMessageCount?: number
  children: ReactNode
}) {
  const [notificationCount, setNotificationCountState] = useState(initialNotificationCount)
  const [messageCount, setMessageCountState] = useState(initialMessageCount)

  const setNotificationCount = useCallback((n: number) => {
    setNotificationCountState(n)
  }, [])

  const decrementMessages = useCallback((n: number) => {
    setMessageCountState((prev) => Math.max(0, prev - n))
  }, [])

  return (
    <BadgeContext.Provider value={{ notificationCount, messageCount, setNotificationCount, decrementMessages }}>
      {children}
    </BadgeContext.Provider>
  )
}

/* ── Sync helpers — tiny client components placed on pages that mark-as-read ── */

/** Placed on /notifications — clears the notification badge on mount. */
export function NotificationBadgeSync() {
  const { setNotificationCount } = useBadges()
  useEffect(() => {
    setNotificationCount(0)
  }, [setNotificationCount])
  return null
}

/** Placed on /messages/[id] — decrements the message badge by the number
 *  of messages that were marked as read when the conversation was opened. */
export function MessageBadgeSync({ unreadCount }: { unreadCount: number }) {
  const { decrementMessages } = useBadges()
  useEffect(() => {
    if (unreadCount > 0) decrementMessages(unreadCount)
  }, [unreadCount, decrementMessages])
  return null
}
