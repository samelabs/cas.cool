import Link from 'next/link'
import { t } from '@/lib/i18n'
import PageHeader from '@/components/layout/PageHeader'
import { FlaskIcon, RepostIcon, CommentIcon, SearchIcon } from '@/components/icons'

export const metadata = {
  title: t.about.title,
  description: t.seo.aboutDescription,
}

export default function AboutPage() {
  return (
    <>
      <PageHeader title={t.about.title} />

      <div className="px-4 py-8">
        <div>
          {/* Hero */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-brand-tint text-brand">
              <FlaskIcon className="h-9 w-9" />
            </div>
            <h1 className="text-2xl font-extrabold text-ink">{t.brand.name}</h1>
            <p className="mt-2 text-ink-faint">
              {t.brand.tagline}
            </p>
          </div>

          {/* What is it */}
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-bold text-ink">{t.about.whatIs}</h2>
            <p className="text-base leading-relaxed text-ink-muted">
              {t.about.description}
            </p>
          </section>

          {/* Features */}
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-bold text-ink">{t.about.features}</h2>
            <ul className="space-y-3 text-base text-ink-muted">
              <li className="flex gap-3">
                <span className="text-brand"><FlaskIcon className="h-5 w-5" /></span>
                <div>
                  <strong className="text-ink">{t.about.casNumbered}</strong>
                  <p className="text-sm text-ink-faint">
                    {t.about.casNumberedDesc}
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="text-orange-400"><RepostIcon className="h-5 w-5" /></span>
                <div>
                  <strong className="text-ink">{t.about.quoteRepost}</strong>
                  <p className="text-sm text-ink-faint">
                    {t.about.quoteRepostDesc}
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="text-info"><CommentIcon className="h-5 w-5" /></span>
                <div>
                  <strong className="text-ink">{t.about.directMessaging}</strong>
                  <p className="text-sm text-ink-faint">
                    {t.about.directMessagingDesc}
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="text-brand"><SearchIcon className="h-5 w-5" /></span>
                <div>
                  <strong className="text-ink">{t.about.smartSearch}</strong>
                  <p className="text-sm text-ink-faint">
                    {t.about.smartSearchDesc}
                  </p>
                </div>
              </li>
            </ul>
          </section>

          {/* CTA */}
          <div className="rounded-2xl border border-line bg-canvas/80 p-6 text-center">
            <p className="mb-4 text-ink-muted">
              {t.about.cta}
            </p>
            <div className="flex justify-center gap-3">
              <Link
                href="/register"
                className="rounded-full bg-brand px-6 py-2.5 text-sm font-bold text-white transition-colors hover:bg-brand-strong"
              >
                {t.common.createAccount}
              </Link>
              <Link
                href="/explore"
                className="rounded-full border border-line-strong px-6 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-surface-hover"
              >
                {t.explore.title}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
