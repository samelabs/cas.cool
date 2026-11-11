'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
  // Top edge of the bar in layout-viewport px while the keyboard is open
  // (null = keyboard closed, bar stays in its default slot).
  const [anchorTopPx, setAnchorTopPx] = useState<number | null>(null)

  // Lift the bar onto the soft keyboard. One standard geometric truth, no
  // browser-model branching: visualViewport.offsetTop + height IS where the
  // keyboard begins — identical semantics in every browser and PWA.
  // The bar is TOP-anchored in pure px (top = keyboard top − bar height,
  // re-measured every update). Never compose two independently animated
  // terms (e.g. bottom: calc(100dvh - Xpx)): dvh is interpolated on the
  // compositor timeline while X updates on the JS/rAF timeline — the
  // per-frame mismatch between them is visible as jitter while the keyboard
  // animates open. A single JS-driven term cannot beat against itself.
  // Keyboard presence is detected ONLY from the visual viewport shrinking
  // during an expanded session (threshold: drift like URL-bar show/hide is
  // ~80px, real keyboards are ~200px+). window.innerHeight is deliberately
  // never used — on iOS PWAs it moves together with the keyboard and turns
  // any formula built on it into a constant zero.
  // rAF-throttled: the resize event fires dozens of times during the
  // keyboard-open animation.
  const KEYBOARD_MIN = 120
  const maxVhRef = useRef(0)
  const barRef = useRef<HTMLDivElement>(null)

  // Single anchor computation — used by BOTH the viewport event loop (rAF-
  // throttled) and the bar's own ResizeObserver. Bar-height changes (textarea
  // growing to multiple lines) fire NO viewport event; without re-anchoring,
  // the stale top lets the keyboard swallow the grown part of the bar.
  const applyAnchor = useCallback(() => {
    const vv = window.visualViewport
    if (!vv) return
    maxVhRef.current = Math.max(maxVhRef.current, vv.height)
    if (maxVhRef.current - vv.height > KEYBOARD_MIN) {
      const keyboardTop = vv.offsetTop + vv.height
      const barH = barRef.current?.offsetHeight ?? 0
      setAnchorTopPx(Math.round(keyboardTop - barH))
    } else {
      setAnchorTopPx(null)
    }
  }, [])

  useEffect(() => {
    if (!expanded) return
    const vv = window.visualViewport
    if (!vv) return

    maxVhRef.current = 0
    let rafId = 0
    const update = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(applyAnchor)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      cancelAnimationFrame(rafId)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [expanded, applyAnchor])

  // Re-anchor when the bar itself resizes (multi-line input growth).
  useEffect(() => {
    if (!expanded || !barRef.current) return
    const ro = new ResizeObserver(applyAnchor)
    ro.observe(barRef.current)
    return () => ro.disconnect()
  }, [expanded, applyAnchor])

  const keyboardOn = expanded && anchorTopPx != null

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
    setAnchorTopPx(null)
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
        ref={barRef}
        className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-40 md:hidden"
        style={anchorTopPx != null ? { top: `${anchorTopPx}px`, bottom: 'auto' } : undefined}
      >
        <div
          className="mx-auto w-full max-w-[600px] border-t border-line bg-surface p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
          style={anchorTopPx != null ? { paddingBottom: '0.75rem' } : undefined}
        >
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
