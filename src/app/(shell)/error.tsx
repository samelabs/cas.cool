'use client'

import { FlaskIcon } from '@/components/icons'
import { t } from '@/lib/i18n'

/**
 * Shell error boundary — friendly error UI with a retry button.
 * Catches any uncaught exception from server components in the (shell) group.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="mb-4 text-brand"><FlaskIcon className="h-14 w-14" /></div>
      <h1 className="text-2xl font-extrabold text-ink">{t.errors.somethingWrong}</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-faint">
        An unexpected error occurred while loading this page. Please try again.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-xs text-ink-faint">Error ID: {error.digest}</p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-full bg-brand px-6 py-2.5 text-sm font-bold text-white transition-colors hover:bg-brand-strong"
      >
        Try again
      </button>
    </div>
  )
}
