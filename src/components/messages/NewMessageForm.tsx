'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Avatar } from '@/components/ui/Avatar'
import { AutoResizeTextarea } from '@/components/ui/AutoResizeTextarea'
import { useToast } from '@/components/ui/Toast'
import { t } from '@/lib/i18n'
import type { SafeUser } from '@/lib/types'
import { startConversation } from '@/actions/social'

export interface NewMessageFormProps {
  recipient: SafeUser
  senderId: string
}

function SendIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" className={className}>
      <path d="M3.4 20.4 21 12 3.4 3.6 3 10l12 2-12 2z" />
    </svg>
  )
}

/**
 * Lightweight message form for /messages/new — sends the first message
 * without creating a conversation record upfront. POST /api/messages
 * creates the conversation + message in one atomic step, then this
 * component redirects to /messages/<conversationId>.
 */
export default function NewMessageForm({ recipient }: NewMessageFormProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const result = await startConversation(recipient.id, text)
      if (!result.ok) {
        throw new Error(result.error || t.errors.failedToSendMessage)
      }
      // Redirect to the conversation thread
      router.push(`/messages/${result.data.conversationId}`)
    } catch {
      showToast(t.messages.messageFailed, 'error')
    } finally {
      setSending(false)
    }
  }, [draft, sending, recipient.id, router, showToast])

  const displayName = recipient.displayName || recipient.username

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-4">
        <Avatar
          src={recipient.avatar}
          name={displayName}
          username={recipient.username}
          size="xl"
        />
        <p className="mt-3 font-bold text-ink">
          {displayName}
        </p>
        <p className="text-sm text-ink-muted">@{recipient.username}</p>
        <p className="mt-2 text-sm text-ink-muted">
          {t.messages.sayHello}
        </p>
      </div>

      <div className="shrink-0 border-t border-line bg-surface p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
          className="flex items-center gap-2"
        >
          <AutoResizeTextarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            minRows={1}
            maxHeight={120}
            maxLength={4000}
            placeholder={t.messages.placeholderNew}
            className="min-w-0 rounded-2xl border border-line-strong px-4 py-2 placeholder:text-ink-faint focus:border-brand focus:ring-1 focus:ring-brand outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            aria-label={t.messages.send}
            className="grid place-items-center w-10 h-10 rounded-full bg-brand text-white hover:bg-brand-strong disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            <SendIcon className="w-5 h-5" />
          </button>
        </form>
      </div>
    </div>
  )
}
