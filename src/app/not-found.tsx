import Link from 'next/link'
import { t } from '@/lib/i18n'
import type { Metadata } from 'next'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  robots: { index: false, follow: true },
}

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-4xl font-bold text-ink-faint">{t.errors.notFound404}</h1>
      <p className="text-ink-muted">{t.errors.notFoundMessage}</p>
      <Link href="/" className="text-brand hover:underline">{t.errors.backToHome}</Link>
    </div>
  )
}
