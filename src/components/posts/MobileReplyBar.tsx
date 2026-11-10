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
  // Keyboard geometry, dual-model:
  //   keyboardPx > 0  → visual-resize model (stock Chromium / iOS): the
  //                     layout viewport is intact and the bar must be lifted
  //                     by exactly the keyboard height.
  //   contentResize   → resizes-content model (vendor Android browsers):
  //                     the layout viewport itself shrank, so the viewport
  //                     bottom already sits on the keyboard top — the bar
  //                     must stay at bottom:0 and must NOT be lifted again.
  // Both signals are needed: computing the keyboard height from a live
  // window.innerHeight fails on the content model because innerHeight
  // shrinks together with the visual viewport, yielding a constant 0 —
  // the exact bug that let the bottom nav float above the keyboard.
  const [keyboardPx, setKeyboardPx] = useState(0)
  const [contentResize, setContentResize] = useState(false)

  // No-keyboard geometry captured at mount (keyboard guaranteed closed)
  // and refreshed whenever we observe a keyboard-less state — self-heals
  // across rotation and URL-bar show/hide.
  const baselineRef = useRef({ inner: 0, vv: 0 })

  useEffect(() => {
    const vv = window.visualViewport
    baselineRef.current = vv
      ? { inner: window.innerHeight, vv: vv.height }
      : { inner: window.innerHeight, vv: window.innerHeight }
  }, [])

  // Keypresses below this are treated as keyboard-less geometry drift
  // (URL bar collapse/expand ≈ ≤80px); real soft keyboards are ≳200px.
  const KEYBOARD_MIN = 120

  useEffect(() => {
    if (!expanded) return
    const vv = window.visualViewport
    if (!vv) return

    let rafId = 0
    const update = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const b = baselineRef.current
        const innerShrink = b.inner - window.innerHeight
        const isContentResize = innerShrink > KEYBOARD_MIN
        // Visual-model keyboard height. On the content model this value is
        // meaningless (it equals the shrink itself), which is why the model
        // is detected first and the height is only used when !isContentResize.
        const visualKb = Math.max(0, b.inner - vv.height - vv.offsetTop)

        if (!isContentResize && visualKb <= KEYBOARD_MIN) {
          // No keyboard — absorb URL-bar/rotation drift into the baseline.
          baselineRef.current = { inner: window.innerHeight, vv: vv.height }
          setKeyboardPx(0)
          setContentResize(false)
          return
        }

        if (isContentResize) {
          setContentResize(true)
          setKeyboardPx(0)
        } else {
          setContentResize(false)
          setKeyboardPx(Math.round(visualKb))
          // Counter-pan: iOS auto-scrolls the page to reveal the caret when
          // the textarea gains focus (before the bar is lifted). Since the
          // bar rides fully above the keyboard, that pan is never needed —
          // snap it back so the underlying page stays put.
          if (vv.offsetTop > 0) window.scrollBy(0, -vv.offsetTop)
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

  // Derived: keyboard signals are only meaningful while expanded — a stale
  // reading from a previous session must not leak into the collapsed state.
  const activeKeyboardPx = expanded ? keyboardPx : 0
  const activeContentResize = expanded && contentResize
  const keyboardOn = expanded && (contentResize || keyboardPx > 0)

  // Hide the mobile bottom nav while the keyboard is open so it can never
  // float above the keyboard (visual model) or ride the shrunken viewport
  // bottom (content model).
  useEffect(() => {
    if (keyboardOn) {
      document.body.dataset.replyBarOpen = 'true'
    } else {
      delete document.body.dataset.replyBarOpen
    }
    return () => { delete document.body.dataset.replyBarOpen }
  }, [keyboardOn])

  // Freeze page scroll while the keyboard is open — the page below must
  // not move; restore the previous overflow state when it closes.
  useEffect(() => {
    if (!keyboardOn) return
    const prevHtml = document.documentElement.style.overflow
    const prevBody = document.body.style.overflow
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.overflow = prevHtml
      document.body.style.overflow = prevBody
    }
  }, [keyboardOn])

  if (!currentUser) return null

  const charLimit = maxPostLength(currentUser)
  const canSubmit = content.trim().length > 0 && !submitting

  const closeBar = () => {
    setExpanded(false)
    setKeyboardPx(0)
    setContentResize(false)
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
    // Keyboard-aware anchor:
    //   content model  → viewport bottom already sits on the keyboard top
    //                    (layout viewport shrank), so pin to bottom:0
    //   visual model   → lift by the measured keyboard height
    //   keyboard closed→ default slot above the (restored) bottom nav
    const keyboardStyle =
      contentResize
        ? { bottom: 0 }
        : keyboardPx > 0
          ? { bottom: `${keyboardPx}px` }
          : undefined
    return (
      <div
        className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-40 md:hidden"
        style={keyboardStyle}
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
