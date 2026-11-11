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
