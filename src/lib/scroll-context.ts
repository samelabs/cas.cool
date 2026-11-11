/**
 * Scroll context — mobile app-shell layering.
 *
 * On mobile (< md) the shell pins the app to the viewport and the feed
 * column (#feed-scroller) is the scrolling container: the document itself
 * never scrolls, so the soft keyboard can only crop the viewport — it can
 * never push page content. On desktop (>= md) the document scrolls as
 * before (window.scroll* APIs).
 *
 * Every scroll read/write must go through these helpers so components work
 * identically in both contexts. Touch events still bubble to window;
 * listeners there need no changes — only scrollY reads and scrollTo calls.
 */

function feedScroller(): HTMLElement | null {
  if (typeof window === 'undefined') return null
  if (window.matchMedia('(min-width: 768px)').matches) return null
  return document.getElementById('feed-scroller')
}

export function getScrollY(): number {
  if (typeof window === 'undefined') return 0
  const el = feedScroller()
  return el ? el.scrollTop : window.scrollY
}

/** Height of the scrolled content (not the viewport). */
export function getScrollHeight(): number {
  if (typeof window === 'undefined') return 0
  const el = feedScroller()
  return el ? el.scrollHeight : document.documentElement.scrollHeight
}

export function scrollToY(y: number, behavior: ScrollBehavior = 'auto'): void {
  if (typeof window === 'undefined') return
  const el = feedScroller()
  if (el) el.scrollTo({ top: y, behavior })
  else window.scrollTo({ top: y, behavior })
}

/**
 * Subscribe to scrolling in the ACTIVE context: the feed-scroller element
 * on mobile (element scroll events do NOT bubble to window), the window on
 * desktop. Handles the context swap if the viewport crosses the md
 * breakpoint. Returns an unsubscribe function.
 */
export function onScroll(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('scroll', handler, { passive: true })
  let current = feedScroller()
  current?.addEventListener('scroll', handler, { passive: true })

  const mql = window.matchMedia('(min-width: 768px)')
  const onChange = () => {
    const next = feedScroller()
    if (next === current) return
    current?.removeEventListener('scroll', handler)
    next?.addEventListener('scroll', handler, { passive: true })
    current = next
  }
  mql.addEventListener('change', onChange)

  return () => {
    window.removeEventListener('scroll', handler)
    current?.removeEventListener('scroll', handler)
    mql.removeEventListener('change', onChange)
  }
}
