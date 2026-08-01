'use client'

import { useState } from 'react'
import { t } from '@/lib/i18n'
import Link from 'next/link'
import { Avatar } from '@/components/ui/Avatar'
import { VerifiedBadge, TrashIcon } from '@/components/icons'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { timeAgo } from '@/lib/utils'
import type { SafeUser } from '@/lib/types'
import { del } from '@/lib/api-client'

export interface ConversationItem {
  id: string
  other: SafeUser
  lastMsg: {
    content: string
    createdAt: string
    senderId: string
  } | null
  unread: number
}

export default function ConversationList({
  items: initialItems,
  currentUserId,
}: {
  items: ConversationItem[]
  currentUserId: string
}) {
  const { showToast } = useToast()
  const [items, setItems] = useState(initialItems)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleDelete = async (id: string, name: string) => {
    // Snapshot before optimistic removal — for precise rollback of just this item.
    const snapshot = items
    // Optimistic: remove immediately
    setItems((prev) => prev.filter((c) => c.id !== id))
    setDeletingId(id)
    try {
      const result = await del('/api/messages/' + id)
      if (!result.ok) throw new Error(result.error || t.errors.failed)
      showToast(t.messages.conversationDeleted(name), 'success', 2000)
    } catch {
      // Rollback: restore only the failed item, preserving any other deletions.
      const removed = snapshot.find((c) => c.id === id)
      if (removed) {
        setItems((prev) => (prev.some((c) => c.id === id) ? prev : [...prev, removed]))
      }
      showToast(t.messages.failedToDelete, 'error')
    } finally {
      setDeletingId(null)
    }
  }

  if (items.length === 0) {
    return (
      <div className="px-4 py-16 text-center text-ink-muted">
        <p className="text-lg font-semibold text-ink-muted">{t.messages.noConversations}</p>
        <p className="mt-1 text-sm">
          Start a conversation from someone&rsquo;s profile.
        </p>
      </div>
    )
  }

  return (
    <>
      {items.map(({ id, other, lastMsg, unread }) => {
        const displayName = other.displayName || other.username
        const isUnread = unread > 0
        return (
          <div
            key={id}
            className={cn(
              'group relative flex items-center gap-3 border-b border-line px-4 py-3 transition-colors hover:bg-canvas/80',
              deletingId === id && 'opacity-40',
            )}
          >
            {/* Tap area → open conversation */}
            <Link
              href={`/messages/${id}`}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <Avatar
                src={other.avatar}
                name={displayName}
                username={other.username}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span
                    className={cn(
                      'truncate',
                      isUnread ? 'font-bold text-ink' : 'font-semibold text-ink',
                    )}
                  >
                    {displayName}
                  </span>
                  {other.verificationStatus === 'verified' && <VerifiedBadge className="h-4 w-4 shrink-0 text-brand" />}
                  {lastMsg && (
                    <span className="ml-auto shrink-0 text-xs text-ink-faint">
                      {timeAgo(lastMsg.createdAt)}
                    </span>
                  )}
                </div>
                <p
                  className={cn(
                    'truncate text-sm',
                    isUnread ? 'font-semibold text-ink' : 'text-ink-muted',
                  )}
                >
                  {lastMsg
                    ? (lastMsg.senderId === currentUserId ? t.messages.youPrefix : '') + lastMsg.content
                    : t.messages.sayHello}
                </p>
              </div>
            </Link>

            {/* Unread badge */}
            {isUnread && (
              <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-brand px-1 text-xs font-bold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}

            {/* Delete button — always visible (mobile-first, no hover dependency) */}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void handleDelete(id, displayName)
              }}
              className="shrink-0 rounded-full p-1.5 text-ink-faint transition-colors hover:bg-danger-tint hover:text-danger"
              aria-label={`Delete conversation with ${displayName}`}
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        )
      })}
    </>
  )
}
