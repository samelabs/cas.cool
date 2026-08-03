'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Avatar } from '@/components/ui/Avatar'
import { AutoResizeTextarea } from '@/components/ui/AutoResizeTextarea'
import { useToast } from '@/components/ui/Toast'
import { t } from '@/lib/i18n'
import type { SafeUser } from '@/lib/types'

import { post } from '@/lib/api-client'

export interface ChatMessage {
  id: string
  senderId: string
  content: string
  createdAt: Date | string
}

export interface MessageThreadProps {
  conversationId: string
  currentUserId: string
  otherUser: SafeUser
  initialMessages: ChatMessage[]
}

function SendIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      className={className}
    >
      <path d="M3.4 20.4 21 12 3.4 3.6 3 10l12 2-12 2z" />
    </svg>
  )
}

export default function MessageThread({
  conversationId,
  currentUserId,
  otherUser,
  initialMessages,
}: MessageThreadProps) {
  const { showToast } = useToast()
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  // Cache today's date string once to avoid creating new Date() per message per render.
  const todayStr = new Date().toLocaleDateString()

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Direct scrollTop — NOT scrollIntoView(). scrollIntoView() propagates
    // to ALL scrollable ancestors (body/html). When the page is even 1px
    // taller than the viewport (common — borders, safe-area, keyboard),
    // the algorithm recalculates and RESETS this container's scroll to the
    // top, causing messages to "jump up" on every send. Setting scrollTop
    // directly scopes the scroll to this container only.
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setDraft('')
    const optimistic: ChatMessage = {
      id: `tmp-${Date.now()}`,
      senderId: currentUserId,
      content: text,
      createdAt: new Date().toISOString(),
    }
    setMessages((m) => [...m, optimistic])
    try {
      const result = await post('/api/messages/' + conversationId + '/send', { content: text })
      if (!result.ok) throw new Error()
      // sendMessage returns { ok: true } — no message id returned, so the
      // optimistic message stays with its temp id. The real message will appear
      // on next server revalidation of the conversation.
    } catch {
      // Remove the optimistic message entirely on failure
      setMessages((m) => m.filter((msg) => msg.id !== optimistic.id))
      showToast(t.messages.messageFailed, 'error')
    } finally {
      setSending(false)
    }
  }, [draft, sending, conversationId, currentUserId, showToast])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-1">
        {messages.length === 0 ? (
          <div className="h-full grid place-items-center text-center">
            <div>
              <Avatar
                src={otherUser.avatar}
                name={otherUser.displayName || otherUser.username}
                username={otherUser.username}
                size="xl"
              />
              <p className="mt-3 font-bold text-ink">
                {otherUser.displayName || otherUser.username}
              </p>
              <p className="text-sm text-ink-muted">@{otherUser.username}</p>
              <p className="mt-2 text-sm text-ink-muted">
                Say hello to start the conversation.
              </p>
            </div>
          </div>
        ) : (
          messages.map((m, i) => {
            const mine = m.senderId === currentUserId
            const msgDate = new Date(m.createdAt)
            const prevMsg = messages[i - 1]
            // Show timestamp when sender changes OR >5 min gap from previous message.
            const showTimestamp =
              i === 0 ||
              !prevMsg ||
              prevMsg.senderId !== m.senderId ||
              (msgDate.getTime() - new Date(prevMsg.createdAt).getTime()) > 5 * 60 * 1000

            return (
              <div key={m.id}>
                {showTimestamp && (
                  <div className="my-2 text-center text-xs text-ink-faint">
                    {msgDate.toLocaleDateString() === todayStr
                      ? msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      : msgDate.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
                        ' ' + msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
                <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-base whitespace-pre-wrap break-words ${
                      mine
                        ? 'bg-brand text-white rounded-br-sm'
                        : 'bg-surface-hover text-ink rounded-bl-sm'
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              </div>
            )
          })
        )}
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
