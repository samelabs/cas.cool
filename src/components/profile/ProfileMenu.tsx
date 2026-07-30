'use client'

import { useState, useRef, useEffect } from 'react'
import { t } from '@/lib/i18n'
import { useReport } from '@/components/ReportDialog'
import type { SafeUser } from '@/lib/types'

/**
 * Profile ellipsis menu — shown at the top-right of the profile header.
 *
 * Currently only contains "Report user". Can be extended with Share, etc.
 * Hidden when viewing your own profile (nothing to report about yourself).
 */
export function ProfileMenu({
  user,
  isSelf,
}: {
  user: SafeUser
  isSelf: boolean
}) {
  const { openReport } = useReport()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  if (isSelf) return null

  const handleReport = () => {
    setOpen(false)
    openReport({
      type: 'USER',
      targetId: user.id,
      label: `@${user.username}`,
    })
  }

  return (
    <div ref={ref} className="relative ml-auto shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="grid h-9 w-9 place-items-center rounded-full text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        aria-label={t.common.moreOptions}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 min-w-[180px] overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-xl shadow-black/10 animate-[popoverIn_120ms_ease-out]">
          <button
            type="button"
            onClick={handleReport}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-sm font-medium text-danger transition-colors hover:bg-danger-tint"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 shrink-0">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="4" y1="22" x2="4" y2="15" strokeLinecap="round" />
            </svg>
            Report user
          </button>
        </div>
      )}
    </div>
  )
}

export default ProfileMenu
