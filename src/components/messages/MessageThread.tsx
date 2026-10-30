'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Avatar } from '@/components/ui/Avatar'
import { AutoResizeTextarea } from '@/components/ui/AutoResizeTextarea'
import { useToast } from '@/components/ui/Toast'
import { t } from '@/lib/i18n'
import type { SafeUser } from '@/lib/types'

import { post, get } from '@/lib/api-client'

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

  // ── Incoming-message polling ──
  // Fetch messages after a composite (createdAt, id) boundary — the same
  // ordering the server sorts by, so same-millisecond messages can't be
  // dropped at a batch cutoff. Each tick drains hasMore batches (bounded
  // per tick; the boundary advances every batch, so any backlog finishes
  // on the next tick). A monotonically increasing sequence tag discards
  // stale/overlapping responses; merge dedupes by server id.
  // Also runs once right after a successful send so the server copy
  // replaces the optimistic tmp-* bubble.
  const boundaryRef = useRef<{ ts: string; id: string }>(
    initialMessages.length > 0
      ? (() => {
          const last = initialMessages[initialMessages.length - 1]
          return { ts: new Date(last.createdAt).toISOString(), id: last.id }
        })()
      : { ts: new Date(0).toISOString(), id: '' },
  )
  const pollSeqRef = useRef(0)
  const pollNow = useCallback(async () => {
    const seq = ++pollSeqRef.current
    try {
      // Drain bounded batches per tick; each batch advances the composite
      // boundary, so a large backlog continues on the next tick without loss.
      for (let batch = 0; batch < 10; batch++) {
        const qs = new URLSearchParams({ afterTs: boundaryRef.current.ts })
        if (boundaryRef.current.id) qs.set('afterId', boundaryRef.current.id)
        const result = await get<{ messages: ChatMessage[]; hasMore?: boolean }>(
          `/api/messages/${conversationId}?${qs}`,
        )
        if (seq !== pollSeqRef.current) return // a newer poll superseded us
        if (!result.ok || !result.data || result.data.messages.length === 0) return
        const incoming = result.data.messages
        setMessages((prev) => {
          // Server ids we already show (tmp-* optimistic bubbles excluded —
          // they get superseded below by the real server message).
          const known = new Set(prev.filter((m) => !m.id.startsWith('tmp-')).map((m) => m.id))
          const fresh = incoming.filter((m) => !known.has(m.id))
          if (fresh.length === 0) return prev
          // Drop optimistic bubbles that the fetched range now covers.
          const newestFresh = new Date(fresh[fresh.length - 1].createdAt).getTime()
          const kept = prev.filter(
            (m) => !m.id.startsWith('tmp-') || new Date(m.createdAt).getTime() > newestFresh,
          )
          return [...kept, ...fresh].sort(
            (x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime(),
          )
        })
        const last = incoming[incoming.length - 1]
        boundaryRef.current = { ts: new Date(last.createdAt).toISOString(), id: last.id }
        if (result.data.hasMore !== true) return
      }
    } catch {
      // Network hiccup — next tick retries from the same boundary.
    }
  }, [conversationId])
  useEffect(() => {
    // Initial sync right after mount catches messages sent between SSR
    // render and hydration (the 15s wait below would miss them).
    void pollNow()
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void pollNow()
    }, 15_000)
    return () => clearInterval(timer)
  }, [pollNow])

  // ── Older-history paging (R7): the first screen shows the most recent
  // window; scrolling to the top loads the next older batch through the
  // composite (beforeTs, beforeId) boundary — same ordering as the server,
  // so no gaps or repeats across pages. hasMoreHistory=false stops at the
  // conversation's true beginning ONLY after a successful response confirms
  // no more history. HTTP failures (429, 500) preserve the boundary and
  // retryable state.
  const oldestBoundaryRef = useRef<{ ts: string; id: string } | null>(
    initialMessages.length > 0
      ? { ts: new Date(initialMessages[0].createdAt).toISOString(), id: initialMessages[0].id }
      : null,
  )
  const [hasMoreHistory, setHasMoreHistory] = useState(true)
  const loadingHistoryRef = useRef(false)
  const retryUntilRef = useRef<number>(0)
  const loadOlderHistory = useCallback(async () => {
    const boundary = oldestBoundaryRef.current
    if (!boundary || loadingHistoryRef.current || !hasMoreHistory) return
    if (Date.now() < retryUntilRef.current) return
    loadingHistoryRef.current = true
    try {
      const qs = new URLSearchParams({ beforeTs: boundary.ts, beforeId: boundary.id })
      const result = await get<{ messages: ChatMessage[]; hasMore?: boolean }>(
        `/api/messages/${conversationId}?${qs}`,
      )
      if (!result.ok) {
        // HTTP failure: retain boundary and retryable state (never setHasMoreHistory(false)).
        if (result.status === 429) {
          const retryHeader = result.headers?.get('Retry-After')
          const retrySec = retryHeader ? parseInt(retryHeader, 10) : 1
          const delayMs = (Number.isNaN(retrySec) ? 1 : Math.max(1, retrySec)) * 1000
          retryUntilRef.current = Date.now() + delayMs
        }
        return
      }
      if (!result.data || result.data.messages.length === 0) {
        // Successful response confirmed no older history.
        setHasMoreHistory(false)
        return
      }
      const older = result.data.messages
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id))
        const fresh = older.filter((m) => !known.has(m.id))
        if (fresh.length === 0) return prev
        return [...fresh, ...prev].sort(
          (x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime(),
        )
      })
      const first = older[0]
      oldestBoundaryRef.current = { ts: new Date(first.createdAt).toISOString(), id: first.id }
      setHasMoreHistory(result.data.hasMore !== false)
    } catch {
      // Network hiccup — retry on the next scroll-to-top.
    } finally {
      loadingHistoryRef.current = false
    }
  }, [conversationId, hasMoreHistory])

  // Cache today's date string once to avoid creating new Date() per message per render.
  const todayStr = new Date().toLocaleDateString()

  const scrollRef = useRef<HTMLDivElement>(null)
  // Preserve the reading position across history prepends: shift scrollTop
  // by the height the older batch added.
  const prevHeightRef = useRef<number | null>(null)
  const prevCountRef = useRef(initialMessages.length)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prevHeightRef.current !== null && messages.length > prevCountRef.current) {
      // Content grew at the TOP (history prepend): keep the viewport anchored.
      const delta = el.scrollHeight - prevHeightRef.current
      if (el.scrollTop < 50) el.scrollTop += delta
      prevCountRef.current = messages.length
      prevHeightRef.current = el.scrollHeight
      return
    }
    // Direct scrollTop — NOT scrollIntoView(). scrollIntoView() propagates
    // to ALL scrollable ancestors (body/html). When the page is even 1px
    // taller than the viewport (common — borders, safe-area, keyboard),
    // the algorithm recalculates and RESETS this container's scroll to the
    // top, causing messages to "jump up" on every send. Setting scrollTop
    // directly scopes the scroll to this container only.
    el.scrollTop = el.scrollHeight
    prevCountRef.current = messages.length
    prevHeightRef.current = el.scrollHeight
  }, [messages])

  const onHistoryScroll = useCallback(() => {
    const el = scrollRef.current
    if (el && el.scrollTop < 60) void loadOlderHistory()
  }, [loadOlderHistory])

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
      const result = await post<{ ok: true; message: { id: string; createdAt: string } }>(
        '/api/messages/' + conversationId + '/send',
        { content: text },
      )
      if (!result.ok || !result.data?.message?.id) throw new Error()
      // The response carries the server message identity — replace the
      // optimistic bubble directly instead of guessing by client clock.
      // The RECEIVE boundary is NOT advanced here: the send response proves
      // only that THIS message committed, not that incoming messages up to
      // it were consumed. pollNow drains (incoming + this message by id)
      // in order and advances the boundary to what was actually shown.
      const serverMessage: ChatMessage = {
        id: result.data.message.id,
        senderId: currentUserId,
        content: text,
        createdAt: result.data.message.createdAt,
      }
      setMessages((m) =>
        m.some((msg) => msg.id === serverMessage.id) // poll already delivered it
          ? m.filter((msg) => msg.id !== optimistic.id)
          : m.map((msg) => (msg.id === optimistic.id ? serverMessage : msg)),
      )
      // Drain now: incoming messages between the boundary and our send are
      // fetched in order; the boundary advances only over consumed ranges.
      await pollNow()
    } catch {
      // Send failed: drop the optimistic bubble and restore the draft ONLY
      // if the user has not typed new content while the request was in
      // flight — their newer text always wins.
      setMessages((m) => m.filter((msg) => msg.id !== optimistic.id))
      setDraft((current) => (current.trim().length > 0 ? current : text))
      showToast(t.messages.messageFailed, 'error')
    } finally {
      setSending(false)
    }
  }, [draft, sending, conversationId, currentUserId, showToast, pollNow])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onHistoryScroll} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-1">
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
                {t.messages.sayHelloToStart}
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
