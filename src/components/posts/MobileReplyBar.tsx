'use client'

import { useEffect, useRef, useState } from 'react'
import { t } from '@/lib/i18n'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { AutoResizeTextarea } from '@/components/ui/AutoResizeTextarea'
import { useAuth } from '@/components/Providers'
import { useToast } from '@/components/ui/Toast'
import { extractCASNumber } from '@/lib/utils'
import { maxPostLength } from '@/lib/permissions'
import type { SafePost } from '@/lib/types'
import { post } from '@/lib/api-client'

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
  // Distance from the TOP of the layout viewport to the bottom edge of the
  // visual viewport (= the soft-keyboard top edge) while the keyboard is
  // open; null = keyboard closed, bar stays in its default slot.
  const [kbBottomPx, setKbBottomPx] = useState<number | null>(null)

  // Lift the bar onto the soft keyboard. One standard geometric truth, no
  // browser-model branching: visualViewport.offsetTop + height IS where the
  // keyboard begins — identical semantics in every browser and PWA. The bar
  // anchors there via `bottom: calc(100dvh - <kbBottom>px)`, which resolves
  // to the keyboard top in both viewport behaviours (window shrinks under
  // the keyboard, or the keyboard overlays the layout).
  // Keyboard presence is detected ONLY from the visual viewport shrinking
  // during an expanded session (threshold: drift like URL-bar show/hide is
  // ~80px, real keyboards are ~200px+). window.innerHeight is deliberately
  // never used — on iOS PWAs it moves together with the keyboard and turns
  // any formula built on it into a constant zero.
  // rAF-throttled: the resize event fires dozens of times during the
  // keyboard-open animation.
  const KEYBOARD_MIN = 120
  const maxVhRef = useRef(0)

  useEffect(() => {
    if (!expanded) return
    const vv = window.visualViewport
    if (!vv) return

    maxVhRef.current = 0
    let rafId = 0
    const update = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        maxVhRef.current = Math.max(maxVhRef.current, vv.height)
        if (maxVhRef.current - vv.height > KEYBOARD_MIN) {
          setKbBottomPx(Math.round(vv.offsetTop + vv.height))
        } else {
          setKbBottomPx(null)
        }
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

  const keyboardOn = expanded && kbBottomPx != null

  // Hide the mobile bottom nav while the keyboard is open so it can never
  // float above the keyboard.
  useEffect(() => {
    if (keyboardOn) {
      document.body.dataset.replyBarOpen = 'true'
    } else {
      delete document.body.dataset.replyBarOpen
    }
    return () => { delete document.body.dataset.replyBarOpen }
  }, [keyboardOn])

  if (!currentUser) return null

  const charLimit = maxPostLength(currentUser)
  const canSubmit = content.trim().length > 0 && !submitting

  const closeBar = () => {
    setExpanded(false)
    setKbBottomPx(null)
  }

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const casNumber = extractCASNumber(content)
      const result = await post<SafePost>('/api/posts', {
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
      const created = result.data!
      onReply?.(created)
      setContent('')
      closeBar()
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
        className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-40 md:hidden"
        style={kbBottomPx != null ? { bottom: `calc(100dvh - ${kbBottomPx}px)` } : undefined}
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
            <Button variant="ghost" size="sm" onClick={() => { closeBar(); setContent('') }}>
              {t.common.cancel}
            </Button>
            <Button size="sm" loading={submitting} disabled={!canSubmit} onClick={submit}>
              {t.compose.reply}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-40 md:hidden">
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
          {t.messages.replyPlaceholder}
        </span>
      </button>
    </div>
  )
}
