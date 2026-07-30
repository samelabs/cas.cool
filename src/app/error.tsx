'use client'

import { FlaskIcon } from '@/components/icons'
import { t } from '@/lib/i18n'

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <FlaskIcon className="mb-4 h-10 w-10 text-brand" />
      <h2 className="mb-2 text-xl font-bold text-ink">{t.errors.somethingWrong}</h2>
      <p className="mb-6 text-sm text-ink-muted">
        An error occurred while loading this page.
      </p>
      <button
        onClick={reset}
        className="rounded-full bg-brand px-6 py-2.5 font-medium text-white transition-colors hover:bg-brand-strong"
      >
        Try again
      </button>
    </div>
  )
}
