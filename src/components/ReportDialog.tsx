'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useToast } from '@/components/ui/Toast'
import { t } from '@/lib/i18n'
import { submitReport } from '@/actions/social'

/**
 * Shared report dialog — used for both POST and USER reports.
 *
 * Renders a modal overlay with preset reason buttons + optional custom text.
 * Submits to POST /api/reports.
 *
 * Controlled entirely by the parent via `open` / `onClose`.
 * The target context (post or user) is passed via `target`.
 */

export interface ReportTarget {
  type: 'POST' | 'USER'
  targetId: string
  /** Display name shown in the dialog header (post snippet or user @handle). */
  label: string
}

const REASONS: { key: string; label: string }[] = [
  { key: 'spam', label: t.report.reasons.spam },
  { key: 'harassment', label: t.report.reasons.harassment },
  { key: 'misinformation', label: t.report.reasons.misinformation },
  { key: 'illegal_substance', label: t.report.reasons.illegal_substance },
  { key: 'scam_fraud', label: t.report.reasons.scam_fraud },
  { key: 'impersonation', label: t.report.reasons.impersonation },
  { key: 'other', label: t.report.reasons.other },
]

export function ReportDialog({
  target,
  open,
  onClose,
}: {
  target: ReportTarget | null
  open: boolean
  onClose: () => void
}) {
  const { showToast } = useToast()
  const [reason, setReason] = useState('')
  const [detail, setDetail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Close on Escape key + lock body scroll while open + focus management.
  useEffect(() => {
    if (!open) return
    // Save the element that had focus before opening (restore on close).
    previouslyFocused.current = document.activeElement as HTMLElement

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      // Focus trap: keep Tab/Shift+Tab within the dialog.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])',
        )
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
    document.body.style.overflow = 'hidden'

    // Move focus into the dialog when it opens.
    requestAnimationFrame(() => {
      const focusable = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), textarea, input',
      )
      focusable?.focus()
    })

    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = ''
      // Restore focus to the trigger element.
      previouslyFocused.current?.focus()
    }
  }, [open, onClose])

  if (!open || !target) return null

  const handleSubmit = async () => {
    if (!reason || submitting) return
    setSubmitting(true)
    try {
      const result = await submitReport({
        targetType: target.type,
        targetId: target.targetId,
        reason,
        detail: detail.trim() || undefined,
      })
      if (!result.ok) {
        throw new Error(result.error || t.report.failed)
      }
      showToast(t.report.submitted, 'success')
      setReason('')
      setDetail('')
      onClose()
    } catch {
      showToast(t.report.failed, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-dialog-title"
      >
        <div className="border-b border-line px-5 py-4">
          <h2 id="report-dialog-title" className="text-lg font-bold text-ink">
            {t.report.title(target.type === 'POST' ? 'post' : 'user')}
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {target.label}
          </p>
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-5 py-4">
          <p className="mb-3 text-sm font-semibold text-ink">{t.report.whyReporting}</p>
          <div className="space-y-1">
            {REASONS.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setReason(r.key)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                  reason === r.key
                    ? 'bg-brand-tint text-brand-ink'
                    : 'text-ink hover:bg-surface-hover'
                }`}
              >
                <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
                  reason === r.key ? 'border-brand' : 'border-line-strong'
                }`}>
                  {reason === r.key && <span className="h-2.5 w-2.5 rounded-full bg-brand" />}
                </span>
                {r.label}
              </button>
            ))}
          </div>

          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder={t.report.detailsPlaceholder}
            maxLength={500}
            rows={3}
            className="mt-4 w-full resize-none rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-base text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-hover"
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!reason || submitting}
            className="rounded-full bg-danger px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-danger-strong disabled:opacity-40"
          >
            {submitting ? t.common.submitting : t.report.submit}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Context provider pattern ──────────────────────────────
// A single ReportDialog instance is mounted at the app root.
// Any component can open it by calling useReport().

interface ReportContextValue {
  openReport: (target: ReportTarget) => void
}

const ReportContext = createContext<ReportContextValue | null>(null)

export function ReportProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ReportTarget | null>(null)
  const [open, setOpen] = useState(false)

  const openReport = useCallback((t: ReportTarget) => {
    setTarget(t)
    setOpen(true)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setTarget(null)
  }, [])

  return (
    <ReportContext.Provider value={{ openReport }}>
      {children}
      <ReportDialog target={target} open={open} onClose={close} />
    </ReportContext.Provider>
  )
}

export function useReport() {
  const ctx = useContext(ReportContext)
  if (!ctx) throw new Error('useReport must be used within ReportProvider')
  return ctx
}
