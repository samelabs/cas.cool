'use client'

import { useRef, useEffect, useCallback, type TextareaHTMLAttributes, type ChangeEvent } from 'react'
import { cn } from '@/lib/cn'

/**
 * AutoResizeTextarea — the single shared textarea for all user-input surfaces
 * (ComposeBox, MobileReplyBar, MessageThread draft, CAS input, etc.).
 *
 * **Why this exists:**
 * The previous textareas used fixed `rows={N}` + `resize-none`. When content
 * exceeded the visible area, the browser created an internal scrollbar inside
 * the textarea. On mobile, this caused:
 *  - Janky cursor movement (the scroll offset fought with touch positioning)
 *  - Text appearing to "jump" when lines wrapped
 *  - Inconsistent heights between compose contexts
 *
 * **How it works:**
 * On every input change, the textarea height is reset to `auto` (collapsing
 * it), then immediately set to `scrollHeight` (the full content height). This
 * makes the textarea grow/shrink to exactly fit its content, with a `maxHeight`
 * cap beyond which a native scrollbar appears. The resize is synchronous in
 * the same frame as the React state update, so there's no visual flicker.
 *
 * **iOS Safari note:**
 * `text-base` (16px) is used to prevent iOS Safari's auto-zoom-on-focus.
 * Never reduce below 16px for input elements.
 */

export interface AutoResizeTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> {
  /** Minimum height in pixels (default: 44 — comfortable touch target). */
  minRows?: number
  /** Maximum height in pixels before scrolling kicks in (default: 200). */
  maxHeight?: number
}

export function AutoResizeTextarea({
  minRows = 2,
  maxHeight = 200,
  className,
  value,
  onChange,
  ...rest
}: AutoResizeTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Compute minHeight from minRows (line-height ~24px at text-base/16px).
  const minHeight = minRows * 24 + 16 // rows × line-height + padding

  const resize = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto' // Reset to allow shrink
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [maxHeight])

  // Resize on mount and whenever value changes externally (e.g. reset, clear).
  useEffect(() => {
    resize()
  }, [value, resize])

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(e)
    resize()
  }

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={handleChange}
      style={{ minHeight: `${minHeight}px`, maxHeight: `${maxHeight}px` }}
      className={cn(
        'w-full resize-none overflow-y-auto bg-transparent text-base text-ink placeholder:text-ink-faint focus:outline-none',
        'transition-[height] duration-75 ease-out',
        className,
      )}
      {...rest}
    />
  )
}

export default AutoResizeTextarea
