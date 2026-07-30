
import { t } from '@/lib/i18n'
import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import PageHeader from '@/components/layout/PageHeader'
import { InfinitePostList } from '@/components/posts/InfinitePostList'
import { FlaskIcon } from '@/components/icons'
import { ChemicalInfo } from '@/components/chem/ChemicalInfo'
import { getTimelinePage } from '@/lib/services/post.service'
import type { Metadata } from 'next'

import { SITE_URL } from '@/lib/site'
const CAS_VALIDATE = /^\d{2,7}-\d{2}-\d$/

export async function generateMetadata({
  params,
}: {
  params: Promise<{ casNumber: string }>
}): Promise<Metadata> {
  const { casNumber } = await params
  const decoded = decodeURIComponent(casNumber)
  if (!CAS_VALIDATE.test(decoded)) return { title: t.seo.casInvalid }

  const chemical = await prisma.chemical.findUnique({
    where: { casNumber: decoded },
    select: { name: true, banned: true, postCount: true },
  })

  const primaryName = chemical?.name?.split(';')[0]?.trim() || null
  const url = `${SITE_URL}/cas/${decoded}`

  const descriptionParts = [
    primaryName ? `${primaryName} (CAS ${decoded})` : `CAS Registry Number ${decoded}`,
    chemical?.postCount ? `${chemical.postCount} ${chemical.postCount === 1 ? 'post' : 'posts'}` : null,
    'discussions, properties, and community knowledge on CAS.cool',
  ].filter(Boolean)
  const description = descriptionParts.join(' · ').slice(0, 160)

  return {
    title: primaryName ? `${primaryName} (CAS ${decoded})` : `CAS ${decoded}`,
    description,
    alternates: { canonical: url },
    robots: chemical?.banned
      ? { index: false, follow: true }
      : { index: true, follow: true },
    openGraph: {
      title: primaryName ? `${primaryName} — CAS ${decoded}` : `CAS ${decoded}`,
      description,
      url,
      siteName: t.seo.siteName,
      type: 'article',
    },
    twitter: {
      card: 'summary',
      title: primaryName ? `${primaryName} — CAS ${decoded}` : `CAS ${decoded}`,
      description,
    },
  }
}

export default async function CASPage({
  params,
}: {
  params: Promise<{ casNumber: string }>
}) {
  const { casNumber } = await params
  const decoded = decodeURIComponent(casNumber)

  if (!CAS_VALIDATE.test(decoded)) notFound()

  const me = await getCurrentUser()

  // Chemical detail query (name, smiles, banned, postCount) has no service
  // equivalent — kept as direct prisma. The feed is served by the service.
  const [chemical, result] = await Promise.all([
    prisma.chemical.findUnique({
      where: { casNumber: decoded },
      select: { name: true, smiles: true, banned: true, postCount: true },
    }),
    getTimelinePage({ tab: 'latest', cas: decoded, userId: me?.id }),
  ])
  const initialPosts = result.posts
  const totalPosts = chemical?.postCount ?? 0

  // Parse semicolon-separated multi-name into individual display names.
  const names: string[] = chemical?.name
    ? chemical.name.split(';').map((n) => n.trim()).filter(Boolean)
    : []
  const primaryName = names[0] || null

  // JSON-LD structured data for SEO — Schema.org ChemicalSubstance
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ChemicalSubstance',
    identifier: `CAS ${decoded}`,
    name: primaryName || decoded,
    url: `${SITE_URL}/cas/${decoded}`,
    ...(names.length > 1 ? { alternateName: names.slice(1).join(', ') } : {}),
    ...(chemical?.smiles ? { smiles: chemical.smiles } : {}),
    ...(totalPosts > 0 ? { commentCount: totalPosts } : {}),
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PageHeader title={`CAS ${decoded}`} />

      {/* Chemical hero header */}
      <div className="border-b border-line bg-gradient-to-b from-brand-tint/40 to-transparent px-4 py-5">
        <div className="flex items-start gap-4">
          {/* Flask icon badge */}
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand-tint ring-1 ring-brand/20">
            <FlaskIcon className="h-7 w-7 text-brand-ink" />
          </span>

          <div className="min-w-0 flex-1">
            {/* Primary name (h1 for SEO) or fallback to CAS number */}
            {primaryName ? (
              <>
                <h1 className="text-xl font-bold text-ink leading-tight">
                  {primaryName}
                </h1>
                <p className="mt-0.5 font-mono text-sm text-ink-muted">
                  CAS {decoded}
                </p>
              </>
            ) : (
              <h1 className="font-mono text-xl font-bold text-brand-ink">
                CAS {decoded}
              </h1>
            )}

            {/* Chemical metadata (names, SMILES, banned, molecule) */}
            <ChemicalInfo
              names={names}
              smiles={chemical?.smiles ?? null}
              banned={chemical?.banned ?? false}
            />

            {/* Stats bar */}
            <div className="mt-3 flex items-center gap-3 text-sm">
              <span className="font-semibold text-ink">
                {totalPosts.toLocaleString()} {totalPosts === 1 ? 'post' : 'posts'}
              </span>
              {chemical?.smiles && (
                <span className="text-ink-muted">· SMILES available</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Posts */}
      <InfinitePostList
        basePath={`/api/posts?tab=latest&cas=${encodeURIComponent(decoded)}`}
        initialPosts={initialPosts}
        initialNextCursor={result.nextCursor}
        emptyMessage={t.explore.noPosts}
      />
    </>
  )
}
