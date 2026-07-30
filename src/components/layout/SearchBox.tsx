'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useRef, useEffect } from 'react'
import { SearchIcon } from '@/components/icons'
import { t } from '@/lib/i18n'

export interface SearchBoxProps {
  initialQuery?: string
}

/**
 * Search input with explicit submit. No debounce — search runs on Enter or
 * button click. Shows a spinner while the route transition is in-flight so
 * the user knows their action was received.
 */
export default function SearchBox({ initialQuery = '' }: SearchBoxProps) {
  const router = useRouter()
  const params = useSearchParams()
  const [q, setQ] = useState(initialQuery || params.get('q') || '')
  const [loading, setLoading] = useState(false)
  // Track the navigation so we can clear the spinner when it completes.
  const navRef = useRef(false)

  const go = () => {
    const trimmed = q.trim()
    const url = trimmed ? `/explore?q=${encodeURIComponent(trimmed)}` : '/explore'
    setLoading(true)
    navRef.current = true
    router.push(url)
  }

  // Clear the spinner when the URL changes (search resolved) or when the
  // component re-syncs from server (initialQuery updated by the page).
  // Safety: 5s timeout in case the navigation callback never fires.
  useEffect(() => {
    if (!navRef.current) return
    // Clear on next tick — params has updated by now.
    const clear = () => {
      navRef.current = false
      setLoading(false)
    }
    clear()
    // Fallback: force-clear after 5s so navigation failures don't leave a stuck spinner.
    const timer = setTimeout(() => {
      navRef.current = false
      setLoading(false)
    }, 5000)
    return () => clearTimeout(timer)
  }, [params])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        go()
      }}
      className="relative min-w-0"
    >
      <span className="absolute inset-y-0 left-0 grid place-items-center pl-3.5 text-ink-muted">
        <SearchIcon className="w-5 h-5" />
      </span>
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t.explore.searchPlaceholder}
        className="w-full rounded-full bg-surface border border-transparent focus:border-brand/60 focus:bg-canvas focus:ring-1 focus:ring-brand/40 outline-none py-2.5 pl-12 pr-12 text-base text-ink placeholder:text-ink-faint transition-colors"
      />
      {/* Submit button / spinner */}
      <div className="absolute inset-y-0 right-0 grid place-items-center pr-2">
        {loading ? (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
        ) : (
          <button
            type="submit"
            aria-label={t.common.search}
            className="flex h-8 w-8 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-hover hover:text-brand active:scale-95"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>
    </form>
  )
}
