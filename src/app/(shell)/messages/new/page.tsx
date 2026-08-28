import { redirect } from 'next/navigation'
import { t } from '@/lib/i18n'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import PageHeader from '@/components/layout/PageHeader'
import NewMessageForm from '@/components/messages/NewMessageForm'
import { getUserById } from '@/lib/services/user.service'
import type { SafeUser } from '@/lib/types'

export const metadata = { title: t.messages.newConversation }

/**
 * /messages/new?to=<userId> — new conversation entry point.
 *
 * Does NOT create a Conversation record. Renders a lightweight send UI
 * showing the recipient's profile. The conversation is only created when
 * the user actually sends a message (via POST /api/messages).
 *
 * If a conversation already exists between the two users, redirect to it
 * directly.
 */
export default async function NewConversationPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string }>
}) {
  const me = await getCurrentUser()
  if (!me) redirect('/login')

  const { to } = await searchParams
  if (!to) redirect('/messages')

  // Prevent self-conversation
  if (to === me.id) redirect('/messages')

  // Verify the target user exists
  const target = await getUserById(to)
  if (!target) redirect('/messages')

  // If a conversation already exists, redirect to it (no new record needed)
  const [user1Id, user2Id] = [me.id, to].sort()
  const existing = await prisma.conversation.findUnique({
    where: { user1Id_user2Id: { user1Id, user2Id } },
    select: { id: true },
  })
  if (existing) redirect(`/messages/${existing.id}`)

  const displayName = target.displayName || target.username

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden pb-14 md:static md:h-[100dvh] md:pb-0">
      <PageHeader title={displayName} subtitle={`@${target.username}`} backHref="/messages" />
      <NewMessageForm recipient={target as SafeUser} senderId={me.id} />
    </div>
  )
}
