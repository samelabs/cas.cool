'use client'

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { SWRConfig } from 'swr'

/**
 * Browse-state ownership — one identity, one cache, one scroll memory.
 *
 * The provider is mounted once at the app root (inside AuthProvider), so it
 * survives every route change: home → post detail → back keeps the SWR
 * cache entry (`$inf$<firstPageKey>` holds the loaded pages, their cursors
 * and the page count) AND the scroll position the user left at.
 *
 * Identity is explicit: `identityKey` remounts the inner provider
 * (`key=`), so logout / login / account switch drops the previous
 * identity's pages and scroll positions wholesale — they are never
 * readable by the next identity. All state lives per provider instance;
 * there is no module-level cache to leak across identities.
 *
 * First pages are seeded into this cache by `SWRInfiniteSeed` (SSR data,
 * only when absent) so a fresh visit renders page 0 without a duplicate
 * fetch, while a back-navigation keeps the newer pages already cached.
 */

/** The SWR cache Map owned by the current identity (same instance the
 *  SWRConfig provider returns). Seeding writes here — never to SWR's
 *  module-global default cache, which is shared across SSR requests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BrowseCache = Map<any, any>

export const BrowseCacheContext = createContext<BrowseCache | null>(null)

/** Keep the active list and the five most recently visited inactive lists.
 * Older lists restart from their SSR first page and the top when revisited. */
export const MAX_INACTIVE_BROWSE_LISTS = 5

/** Scroll memory and cache lifetime for one identity. */
export interface BrowseScrollStore {
  open(key: string): void
  close(key: string): void
  save(key: string, y: number): void
  /** One-shot: removes the remembered position as it hands it out. */
  take(key: string): number | null
}

const ScrollContext = createContext<BrowseScrollStore | null>(null)

/** Owns the SWR cache and the scroll position for a bounded set of lists.
 * An evicted list loses its infinite metadata, every cursor page, and its
 * scroll position together. Non-list SWR entries remain SWR's own concern. */
export function createBrowseMemory(inactiveLimit = MAX_INACTIVE_BROWSE_LISTS) {
  const cache: BrowseCache = new Map()
  const scrollMap = new Map<string, number>()
  const active = new Map<string, number>()
  const inactive = new Map<string, true>()

  const evict = (key: string) => {
    scrollMap.delete(key)
    const cursorPrefix = `${key}${key.includes('?') ? '&' : '?'}cursor=`
    for (const cacheKey of cache.keys()) {
      if (
        typeof cacheKey === 'string' &&
        (cacheKey === key || cacheKey === `$inf$${key}` || cacheKey.startsWith(cursorPrefix))
      ) {
        cache.delete(cacheKey)
      }
    }
  }

  const trim = () => {
    while (inactive.size > inactiveLimit) {
      const oldest = inactive.keys().next().value
      if (oldest === undefined) break
      inactive.delete(oldest)
      evict(oldest)
    }
  }

  const scrollStore: BrowseScrollStore = {
    open(key) {
      inactive.delete(key)
      active.set(key, (active.get(key) ?? 0) + 1)
    },
    close(key) {
      const mounted = active.get(key)
      if (mounted === undefined) return
      if (mounted > 1) {
        active.set(key, mounted - 1)
        return
      }
      active.delete(key)
      inactive.delete(key)
      inactive.set(key, true)
      trim()
    },
    save(key, y) {
      if (y >= 0) scrollMap.set(key, Math.round(y))
    },
    take(key) {
      const y = scrollMap.get(key)
      scrollMap.delete(key)
      return y ?? null
    },
  }

  return { cache, scrollStore }
}

/** Inner instance — remounted (fresh Maps) whenever identityKey changes. */
function BrowseStateInner({ children }: { children: ReactNode }) {
  const [memory] = useState(createBrowseMemory)
  const { cache, scrollStore } = memory
  // SWRConfig reads `provider` once per mount; it must return this
  // instance's stable cache.
  const [provider] = useState(() => () => cache)

  return (
    <BrowseCacheContext.Provider value={cache}>
      <ScrollContext.Provider value={scrollStore}>
        <SWRConfig value={{ provider }}>{children}</SWRConfig>
      </ScrollContext.Provider>
    </BrowseCacheContext.Provider>
  )
}

export function BrowseStateProvider({
  identityKey,
  children,
}: {
  /** Current identity ('anon' when signed out). Changing it clears all
   *  browse state of the previous identity by remounting this subtree. */
  identityKey: string
  children: ReactNode
}) {
  return (
    <BrowseStateInner key={identityKey}>{children}</BrowseStateInner>
  )
}

/**
 * Scroll position lifecycle for one list.
 *
 * While mounted, every scroll frame is saved under `key`. On mount, a
 * remembered position (if any) is taken and restored as soon as the
 * document is tall enough for it — with the persistent SWR cache the
 * previously loaded pages render synchronously, so this typically applies
 * in the first commit after back-navigation. `contentTick` (e.g. rendered
 * post count) retries the apply as content grows; a key change (tab
 * switch) drops the pending restore.
 */
export function useBrowseScroll(key: string | null, contentTick: number) {
  const store = useContext(ScrollContext)
  const pendingRef = useRef<{ key: string; y: number } | null>(null)
  // Keys whose remembered position was already consumed — a key may remount
  // (back-navigation) and must restore once, while a key CHANGE mid-session
  // (tab adoption on remount, tab switch) must not trigger a jump.
  const tookKeysRef = useRef<Set<string>>(new Set())

  // ── Save (throttled to one write per frame) + per-key restore take. ──
  // The remembered position for `key` is consumed strictly before this
  // effect's own initial save can overwrite it with the current
  // (top-of-page) scroll. Mounting with a soon-to-be-corrected key (the
  // timeline adopts the URL tab before paint) takes that stale key once —
  // its pending restore is then dropped by the apply guard below, and the
  // corrected key still consumes its own memory.
  useEffect(() => {
    if (!store || !key) return
    store.open(key)
    if (!tookKeysRef.current.has(key)) {
      tookKeysRef.current.add(key)
      const y = store.take(key)
      // Below ~one viewport of scroll, restoring is noise — skip.
      if (y != null && y > 400) pendingRef.current = { key, y }
    }
    let raf = 0
    const save = () => {
      raf = 0
      store.save(key, window.scrollY)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(save)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    save()
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
      // Final save on unmount — the position the user left at when
      // navigating into a post detail page.
      store.save(key, window.scrollY)
      store.close(key)
    }
  }, [store, key])

  // ── Apply the pending restore once the document is tall enough. ──
  // With the persistent SWR cache the pages render synchronously, so this
  // fires on the first post-mount tick; contentTick retries while content
  // grows. A key change drops the pending restore.
  useEffect(() => {
    const pending = pendingRef.current
    if (!pending || pending.key !== key) return
    if (document.documentElement.scrollHeight >= pending.y + window.innerHeight) {
      pendingRef.current = null
      window.scrollTo(0, pending.y)
    }
  }, [contentTick, key])
}
