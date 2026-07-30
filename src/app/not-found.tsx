import { permanentRedirect } from 'next/navigation'
import { randomPostPath } from '@/lib/random-post'
import type { Metadata } from 'next'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  robots: { index: false, follow: true },
}

export default async function NotFound() {
  permanentRedirect(await randomPostPath())
}
