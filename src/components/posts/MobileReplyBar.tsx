'use client'

import { useEffect, useState } from 'react'
import { t } from '@/lib/i18n'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { AutoResizeTextarea } from '@/components/ui/AutoResizeTextarea'
import { useAuth } from '@/components/Providers'
import { useToast } from '@/components/ui/Toast'
import { extractCASNumber } from '@/lib/utils'
import { maxPostLength } from '@/lib/permissions'
import type { SafePost } from '@/lib/types'
import { createPost } from '@/actions/posts'

export interface MobileReplyBarProps {
  postId: string
  /** Called with the fully-serialized post returned by the API (HTTP 201). */
  onReply?: (post: SafePost) => void
}

/**
 * Floating reply bar shown above the mobile bottom nav.
 *
 * Collapsed state: avatar + single-line placeholder.
 * Expanded state: full textarea + submit.
 *
 * Layout notes:
 * - The outer wrapper is `fixed inset-x-0` (full viewport width) purely for
 *   anchoring; the visible bar lives inside an `mx-auto max-w-[600px]`
 *   container so it can never exceed the app's content column.
 * - The textarea uses a 16px font so iOS Safari does not auto-zoom on focus.
 * - When expanded we track the soft keyboard via the VisualViewport API.
 *   State updates are throttled through requestAnimationFrame so the bar
 *   doesn't jitter frame-by-frame during the keyboard's ~300ms open animation.
 */
export default function MobileReplyBar({ postId, onReply }: MobileReplyBarProps) {
  const { currentUser } = useAuth()
  const { showToast } = useToast()
  const [expanded, setExpanded] = useState(false)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [keyboardInset, setKeyboardInset] = useState(0)

  // Reset inset when collapsed — derived state, not effect setState
  const effectiveInset = expanded ? keyboardInset : 0

  // Lift the bar above the mobile soft keyboard (VisualViewport API).
  // rAF-throttled: the resize event fires dozens of times during the keyboard
  // open animation. Without throttling, each fire triggers a React state
  // update → re-render → layout recalculation, causing the bar to visibly
  // "shake" or "drift" as it tracks the rising keyboard frame by frame.
  useEffect(() => {
    if (!expanded) return
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return

    let rafId = 0
    const update = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const keyboard = window.innerHeight - vv.height - vv.offsetTop
        // Ignore sub-pixel noise; only treat a real keyboard gap as an inset.
        setKeyboardInset(keyboard > 8 ? keyboard : 0)
      })
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      cancelAnimationFrame(rafId)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [expanded])

  // Hide the mobile bottom nav while the keyboard is open so the iOS
  // fixed-position viewport-shift bug can't drag the nav upward.
  useEffect(() => {
    if (expanded && effectiveInset > 0) {
      document.body.dataset.replyBarOpen = 'true'
    } else {
      delete document.body.dataset.replyBarOpen
    }
    return () => { delete document.body.dataset.replyBarOpen }
  }, [expanded, effectiveInset])

  if (!currentUser) return null

  const charLimit = maxPostLength(currentUser)
  const canSubmit = content.trim().length > 0 && !submitting

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const casNumber = extractCASNumber(content)
      const result = await createPost({
        content,
        parentId: postId,
        casNumbers: casNumber ? [casNumber] : [],
        images: [],
      })
      if (!result.ok) {
        throw new Error(result.error || t.messages.failedToReply)
      }
      // Action returns the full serialized post — optimistic update via callback.
      // No router.refresh() — that would destroy the DOM, lose focus, and
      // cause the "input drift" bug on mobile.
      const created = result.data
      onReply?.(created)
      setContent('')
      setExpanded(false)
      showToast(t.messages.replyPosted, 'success', 2000)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.errors.somethingWrong, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  if (expanded) {
    return (
      <div
        className="fixed inset-x-0 bottom-14 z-40 md:hidden"
        style={effectiveInset > 0 ? { bottom: `${effectiveInset}px` } : undefined}
      >
        <div className="mx-auto w-full max-w-[600px] border-t border-line bg-surface p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="flex gap-2">
            <Avatar
              src={currentUser.avatar}
              name={currentUser.displayName || currentUser.username}
              username={currentUser.username}
              size="sm"
            />
            <AutoResizeTextarea
              autoFocus
              value={content}
              onChange={(e) => setContent(e.target.value)}
              minRows={3}
              maxHeight={200}
              placeholder={t.messages.replyPlaceholder}
              maxLength={charLimit + 50}
            />
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setExpanded(false); setContent('') }}>
              Cancel
            </Button>
            <Button size="sm" loading={submitting} disabled={!canSubmit} onClick={submit}>
              Reply
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-x-0 bottom-14 z-40 md:hidden">
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mx-auto flex w-full max-w-[600px] items-center gap-2 border-t border-line bg-surface/95 px-4 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] backdrop-blur-lg"
      >
        <Avatar
          src={currentUser.avatar}
          name={currentUser.displayName || currentUser.username}
          username={currentUser.username}
          size="sm"
        />
        <span className="flex-1 text-left text-sm text-ink-faint">
          Post your reply
        </span>
      </button>
    </div>
  )
}
