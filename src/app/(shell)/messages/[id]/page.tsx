import { notFound, redirect } from 'next/navigation'
import { t } from '@/lib/i18n'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import { VerifiedBadge } from '@/components/icons'
import MessageThread from '@/components/messages/MessageThread'
import { MessageBadgeSync } from '@/components/BadgeProvider'
import { getConversationThread } from '@/lib/services/message.service'

export const metadata = { title: t.messages.conversation }

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const me = await getCurrentUser()
  if (!me) redirect('/login')

  const { id } = await params

  // getConversationThread handles:
  // - conversation lookup + access check
  // - other user fetch
  // - message fetch (take 200)
  // - unread count (before marking)
  // - mark received messages as read
  const { otherUser, messages, unreadInConv } = await getConversationThread(id, me.id, 200)

  if (!otherUser) notFound()

  const displayName = otherUser.displayName || otherUser.username

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden pb-14 md:static md:h-[100dvh] md:pb-0">
      <MessageBadgeSync unreadCount={unreadInConv} />
      <PageHeader
        title={
          <span className="inline-flex items-center gap-1">
            <span className="truncate">{displayName}</span>
            {otherUser.verificationStatus === 'verified' && (
              <VerifiedBadge className="h-4 w-4 shrink-0 text-brand" />
            )}
          </span>
        }
        subtitle={`@${otherUser.username}`}
        backHref="/messages"
      />
      <MessageThread
        conversationId={id}
        currentUserId={me.id}
        otherUser={otherUser}
        initialMessages={messages.map((m) => ({
          id: m.id,
          senderId: m.senderId,
          content: m.content,
          createdAt: m.createdAt,
        }))}
      />
    </div>
  )
}
