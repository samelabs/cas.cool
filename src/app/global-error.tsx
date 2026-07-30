'use client'

import { FlaskIcon } from '@/components/icons'
import { t } from '@/lib/i18n'

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="flex min-h-[100dvh] items-center justify-center bg-canvas text-ink">
        <div className="mx-auto max-w-md px-6 text-center">
          <FlaskIcon className="mx-auto mb-4 h-12 w-12 text-brand" />
          <h1 className="mb-2 text-2xl font-bold">{t.errors.somethingWrong}</h1>
          <p className="mb-6 text-ink-muted">
            An unexpected error occurred. Please try again.
          </p>
          <button
            onClick={reset}
            className="rounded-full bg-brand px-6 py-2.5 font-medium text-white transition-colors hover:bg-brand-strong"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
