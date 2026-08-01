import { t } from '@/lib/i18n'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import { NotificationBadgeSync } from '@/components/BadgeProvider'
import NotificationList from '@/components/notifications/NotificationList'
import { getNotificationsFirstPage } from '@/lib/services/notify.service'

export const metadata = { title: t.notifications.title }

export default async function NotificationsPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/login')

  // getNotificationsFirstPage handles:
  // 1. Fetch first page (captures original read/unread state for rendering)
  // 2. Mark as read (silent) — only if there were unread items
  // 3. Opportunistic cleanup — delete read notifications older than 30 days
  // 4. Batch-lookup shortCodes for posts referenced in notifications
  const { notifications, nextCursor: initialCursor } = await getNotificationsFirstPage(me.id)

  return (
    <>
      <NotificationBadgeSync />
      <PageHeader title={t.notifications.title} subtitle={t.nav.activities(notifications.length)} backHref="/" />

      {notifications.length === 0 ? (
        <div className="px-4 py-16 text-center text-ink-muted">
          <p className="text-lg font-semibold text-ink-muted">{t.notifications.emptyTitle}</p>
          <p className="mt-1 text-sm">
            {t.notifications.emptyHint}
          </p>
        </div>
      ) : (
        <NotificationList
          initialNotifications={notifications}
          initialCursor={initialCursor}
        />
      )}
    </>
  )
}
