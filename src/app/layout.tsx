import type { Metadata, Viewport } from 'next'
import './globals.css'
import { getCurrentUser } from '@/lib/auth'
import Providers from '@/components/Providers'
import Analytics from '@/components/Analytics'
import { t } from '@/lib/i18n'
import { SITE_URL } from '@/lib/site'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: t.seo.titleDefault,
    template: t.seo.titleTemplate,
  },
  description: t.seo.description,
  keywords: [...t.seo.keywords],
  authors: [{ name: t.seo.siteName }],
  manifest: '/manifest.json',
  openGraph: {
    title: t.seo.og.title,
    description: t.seo.og.description,
    siteName: t.seo.og.siteName,
    type: 'website',
    images: ['/og-default.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: t.seo.twitter.title,
    description: t.seo.twitter.description,
    images: ['/og-default.png'],
  },
}

export const viewport: Viewport = {
  themeColor: '#10b981',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const currentUser = await getCurrentUser()

  return (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        {/* Agent discovery: point AI agents to the machine-readable API manifest */}
        <link rel="llms-txt" href="/llms.txt" />
      </head>
      <body className="bg-canvas text-ink">
        <Providers currentUser={currentUser}>{children}</Providers>
        <Analytics />
      </body>
    </html>
  )
}
