import { redirect } from 'next/navigation'
import { t } from '@/lib/i18n'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import ConversationList from '@/components/messages/ConversationList'
import { getConversationList } from '@/lib/services/message.service'

export const metadata = { title: t.messages.title }
export const dynamic = 'force-dynamic'

export default async function MessagesPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/login')

  // Fetch conversations + participants + last message + unread counts
  // (all handled by the service — no N+1 queries).
  const conversations = await getConversationList(me.id, 50)

  // Map to the ConversationItem shape expected by ConversationList.
  const items = conversations.map((c) => ({
    id: c.id,
    other: c.otherUser,
    lastMsg: c.lastMessage
      ? { content: c.lastMessage.content, createdAt: c.lastMessage.createdAt.toISOString(), senderId: c.lastMessage.senderId }
      : null,
    unread: c.unreadCount,
  }))

  return (
    <>
      <PageHeader title={t.messages.title} backHref="/" />
      <ConversationList items={items} currentUserId={me.id} />
    </>
  )
}
