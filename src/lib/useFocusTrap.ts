'use client'

import { useEffect, useRef } from 'react'

/**
 * Shared focus-trap + scroll-lock + focus-restore hook for modal overlays.
 *
 * Standardises the a11y behaviour that ReportDialog implemented inline:
 *   - Escape closes
 *   - Tab / Shift+Tab stay inside the overlay (focus trap)
 *   - focus moves into the overlay on open, back to the trigger on close
 *   - body scroll is locked while open
 *
 * The overlay element must carry `role="dialog" aria-modal="true"`.
 */
export function useFocusTrap(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) return

    // Save the element that had focus before opening (restore on close).
    const previouslyFocused = document.activeElement as HTMLElement | null

    const FOCUSABLE =
      'button:not([disabled]), textarea, input, [href], [tabindex]:not([tabindex="-1"])'

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      // Focus trap: keep Tab/Shift+Tab within the overlay.
      if (e.key === 'Tab' && ref.current) {
        const focusable = ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handler)

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Move focus into the overlay when it opens.
    requestAnimationFrame(() => {
      const focusable = ref.current?.querySelector<HTMLElement>(FOCUSABLE)
      focusable?.focus()
    })

    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus()
    }
  }, [active, onClose])

  return ref
}
