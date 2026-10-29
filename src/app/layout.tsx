import type { Metadata, Viewport } from 'next'
import './globals.css'
import { getCurrentUser } from '@/lib/auth'
import Providers from '@/components/Providers'
import Analytics from '@/components/Analytics'
import { t } from '@/lib/i18n'
import { getSiteConfig } from '@/lib/site'

export async function generateMetadata(): Promise<Metadata> {
  const site = await getSiteConfig()
  return {
    metadataBase: new URL(site.origin),
    title: { default: site.name, template: `%s · ${site.name}` },
    description: site.description,
    keywords: [...t.seo.keywords],
    authors: [{ name: site.name }],
    manifest: '/manifest.webmanifest',
    openGraph: { title: site.name, description: site.description, siteName: site.name, type: 'website', images: ['/og-default.png'] },
    twitter: { card: 'summary_large_image', title: site.name, description: site.description, images: ['/og-default.png'] },
  }
}

export const viewport: Viewport = {
  themeColor: '#10b981',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [currentUser, site] = await Promise.all([getCurrentUser(), getSiteConfig()])

  return (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        {/* Agent discovery: point AI agents to the machine-readable API manifest */}
        <link rel="llms-txt" href="/llms.txt" />
      </head>
      <body className="bg-canvas text-ink">
        <Providers currentUser={currentUser} site={site}>{children}</Providers>
        <Analytics />
      </body>
    </html>
  )
}
