import { t } from '@/lib/i18n'
import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import PageHeader from '@/components/layout/PageHeader'
import { InfinitePostList } from '@/components/posts/InfinitePostList'
import { ChemicalHero } from '@/components/chem/ChemicalHero'
import { CasQuickCompose } from '@/components/chem/CasQuickCompose'
import { getTimelinePage } from '@/lib/services/post.service'
import { jsonLdScript } from '@/lib/utils'
import type { Metadata } from 'next'

import { getSiteConfig } from '@/lib/site'
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
    select: { name: true, postCount: true, molecularFormula: true, averageMass: true },
  })

  const primaryName = chemical?.name?.split(';')[0]?.split(' · ')[0]?.trim() || null
  const site = await getSiteConfig()
  const url = `${site.origin}/cas/${decoded}`

  const descriptionParts = [
    primaryName ? t.cas.primaryCasName(primaryName, decoded) : t.cas.casRegistryNumber(decoded),
    chemical?.molecularFormula ?? null,
    chemical?.averageMass != null ? t.cas.averageMassLabel(chemical.averageMass) : null,
    chemical?.postCount ? t.common.postsCount(chemical.postCount) : null,
    t.cas.metaDiscussions(site.name),
  ].filter(Boolean)
  const description = descriptionParts.join(' · ').slice(0, 160)

  return {
    title: primaryName ? `${primaryName} (CAS ${decoded})` : `CAS ${decoded}`,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      title: primaryName ? `${primaryName} — CAS ${decoded}` : `CAS ${decoded}`,
      description,
      url,
      siteName: site.name,
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

  // Chemical detail query (name, smiles, banned, postCount + stock-import
  // fields) has no service equivalent — kept as direct prisma. The feed is
  // served by the service.
  const [chemical, result] = await Promise.all([
    prisma.chemical.findUnique({
      where: { casNumber: decoded },
      select: {
        name: true, smiles: true, banned: true, postCount: true,
        hcid: true, molecularFormula: true, averageMass: true,
        structureSvgAt: true,
      },
    }),
    getTimelinePage({ tab: 'latest', cas: decoded, userId: me?.id }),
  ])
  const initialPosts = result.posts
  const totalPosts = chemical?.postCount ?? 0
  const isEmpty = initialPosts.length === 0 && totalPosts === 0

  // Parse semicolon-separated multi-name into individual display names.
  const names: string[] = chemical?.name
    ? chemical.name.split(';').map((n) => n.trim()).filter(Boolean)
    : []
  const primaryName = names[0] || null

  const site = await getSiteConfig()
  const descriptionParts = [
    primaryName ? t.cas.primaryCasName(primaryName, decoded) : t.cas.casRegistryNumber(decoded),
    chemical?.molecularFormula ?? null,
    chemical?.averageMass != null ? t.cas.averageMassLabel(chemical.averageMass) : null,
    totalPosts > 0 ? t.common.postsCount(totalPosts) : null,
    t.cas.metaDiscussions(site.name),
  ].filter(Boolean)
  const description = descriptionParts.join(' · ').slice(0, 160)

  // JSON-LD structured data for SEO — Schema.org ChemicalSubstance
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ChemicalSubstance',
    identifier: `CAS ${decoded}`,
    name: primaryName || `CAS ${decoded}`,
    description,
    url: `${site.origin}/cas/${decoded}`,
    ...(chemical?.molecularFormula ? { molecularFormula: chemical.molecularFormula } : {}),
    ...(chemical?.averageMass != null ? { molecularWeight: `${chemical.averageMass.toFixed(2)} g/mol` } : {}),
    ...(names.length > 1 ? { alternateName: names.slice(1) } : {}),
    ...(chemical?.smiles ? { hasRepresentation: chemical.smiles } : {}),
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <PageHeader title={`CAS ${decoded}`} heading={false} />

      {/* Hero: identity, structure, core properties, aliases — all from the
          stock import; renders identically whether or not posts exist. */}
      <ChemicalHero
        casNumber={decoded}
        names={names}
        banned={chemical?.banned ?? false}
        hcid={chemical?.hcid ?? null}
        hasStructureSvg={chemical?.structureSvgAt != null}
        molecularFormula={chemical?.molecularFormula ?? null}
        averageMass={chemical?.averageMass ?? null}
        postCount={totalPosts}
      />

      {/* Empty state — quick compose pre-attached to this CAS.
          The hero above already carries the stock-import info (names,
          structure, formula/mass, HCID badge), so "empty" only means
          no community posts yet. */}
      {isEmpty && me && (
        <section className="border-b border-line bg-surface/60 px-4 py-5">
          <h2 className="text-base font-bold text-ink">{t.cas.noPostsTitle(decoded)}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t.cas.noPostsBody}</p>
          <div className="mt-3">
            <CasQuickCompose casNumber={decoded} />
          </div>
        </section>
      )}

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
