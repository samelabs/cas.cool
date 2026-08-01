import { notFound } from 'next/navigation'
import { t } from '@/lib/i18n'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import VerificationPanel from '@/components/verify/VerificationPanel'
import PageHeader from '@/components/layout/PageHeader'
import { VerifiedBadge } from '@/components/icons'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: t.seo.verifyTitle,
  description: t.seo.verifyDescription,
}

export default async function VerifyPage() {
  const user = await getCurrentUser()
  if (!user) notFound()

  const submission = await prisma.verificationSubmission.findUnique({
    where: { userId: user.id },
  })

  // Verified but no approved submission on file (admin-assigned without documents)
  const needsDocuments =
    user.verificationStatus === 'verified' &&
    (!submission || submission.status !== 'approved')

  const fmtDate = (d: Date | null | undefined) =>
    d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null

  return (
    <>
      <PageHeader title={t.verify.title} backHref="/" />

      <div className="px-4 py-4">

        {/* ── Status banner ── */}
        {user.verificationStatus === 'verified' && (
          <div className="mb-6 rounded-xl border border-brand/20 bg-brand-tint p-5">
            <div className="flex items-center gap-2">
              <VerifiedBadge className="h-6 w-6 text-brand" />
              <h2 className="text-lg font-bold text-brand-ink">{t.verify.verified}</h2>
            </div>
            <p className="mt-2 text-sm text-brand-ink/80">
              {t.verify.confirmed}
              {user.verifiedAt && <> {t.verify.verifiedOn(fmtDate(new Date(user.verifiedAt)) ?? '')}</>}
            </p>
            {user.verificationExpiresAt && (
              <p className="mt-1 text-sm text-brand-ink/60">
                {t.verify.validUntil(fmtDate(new Date(user.verificationExpiresAt)) ?? '')}
              </p>
            )}

            {/* Documents incomplete warning */}
            {needsDocuments && (
              <div className="mt-3 rounded-lg border border-warning/40 bg-warning-tint px-4 py-3">
                <p className="text-sm font-semibold text-warning">
                  {t.verify.documentsRequired}
                </p>
                <p className="mt-1 text-sm text-warning">
                  {t.verify.adminGrantedL1} {t.verify.adminGrantedL2}
                </p>
              </div>
            )}
          </div>
        )}

        {user.verificationStatus === 'pending' && submission && (
          <div className="mb-6 rounded-xl border border-warning/30 bg-warning-tint p-5">
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5 text-warning">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <h2 className="text-lg font-bold text-warning">{t.verify.underReview}</h2>
            </div>
            <p className="mt-2 text-sm text-warning">
              {t.verify.submissionReceived(fmtDate(new Date(submission.submittedAt)) ?? '')} {t.verify.reviewPending}
            </p>
          </div>
        )}

        {/* ── Permission comparison ── */}
        <section className="mb-6">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-faint">
            {t.verify.benefits}
          </h3>
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-hover">
                  <th className="px-4 py-2.5 text-left font-semibold text-ink">{t.verify.capability}</th>
                  <th className="px-4 py-2.5 text-center font-semibold text-ink-faint">{t.verify.unverifiedCol}</th>
                  <th className="px-4 py-2.5 text-center font-semibold text-brand">{t.verify.verifiedCol}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <tr>
                  <td className="px-4 py-2.5 text-ink">{t.verify.postLength}</td>
                  <td className="px-4 py-2.5 text-center text-ink-faint">{t.verify.charLimitUnverified}</td>
                  <td className="px-4 py-2.5 text-center font-semibold text-brand">{t.verify.charLimitVerified}</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 text-ink">{t.verify.postImages}</td>
                  <td className="px-4 py-2.5 text-center text-ink-faint">{t.verify.none}</td>
                  <td className="px-4 py-2.5 text-center font-semibold text-brand">{t.verify.upTo4}</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 text-ink">{t.verify.avatarBanner}</td>
                  <td className="px-4 py-2.5 text-center text-ink-faint">{t.verify.none}</td>
                  <td className="px-4 py-2.5 text-center font-semibold text-brand">✓</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 text-ink">{t.verify.search}</td>
                  <td className="px-4 py-2.5 text-center text-ink-faint">{t.verify.none}</td>
                  <td className="px-4 py-2.5 text-center font-semibold text-brand">✓</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 text-ink">{t.verify.dm}</td>
                  <td className="px-4 py-2.5 text-center text-ink-faint">{t.verify.dmUnverified}</td>
                  <td className="px-4 py-2.5 text-center font-semibold text-brand">{t.verify.dmVerified}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Annual review explanation ── */}
        <section className="mb-6 rounded-xl border border-line bg-surface p-4">
          <h3 className="mb-2 text-sm font-bold text-ink">{t.verify.annualReview}</h3>
          <p className="text-sm leading-relaxed text-ink-muted">
            {t.verify.annualReviewDesc}
          </p>
        </section>

        {/* ── Form (unverified, or verified-but-needs-documents) ── */}
        {(user.verificationStatus === 'unverified' || needsDocuments) && (
          <VerificationPanel
            variant={needsDocuments ? 'supplemental' : 'initial'}
            existingSubmission={
              submission
                ? {
                    idName: submission.idName,
                    idNumber: submission.idNumber,
                    idFrontImage: submission.idFrontImage,
                    idBackImage: submission.idBackImage,
                    reviewNote: submission.reviewNote,
                  }
                : null
            }
          />
        )}

        {/* ── Pending: show submitted info ── */}
        {user.verificationStatus === 'pending' && submission && (
          <section className="rounded-xl border border-line bg-surface p-5">
            <h3 className="mb-3 text-base font-bold text-ink">{t.verify.submittedInfo}</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-faint">{t.verify.legalName}</dt>
                <dd className="font-medium text-ink">{submission.idName}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-faint">{t.verify.idNumber}</dt>
                <dd className="font-mono text-ink">{submission.idNumber}</dd>
              </div>
            </dl>
          </section>
        )}
      </div>
    </>
  )
}
