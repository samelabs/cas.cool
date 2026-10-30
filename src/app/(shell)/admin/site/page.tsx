'use client'

import { useState, useEffect, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { t } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { get, patch } from '@/lib/api-client'

interface SiteConfigData {
  origin: string
  name: string
  shortName: string
  keyPrefix: string
  description: string
  tagline: string
  analyticsId: string | null
  githubUrl: string | null
  updatedAt: string
}

export default function AdminSitePage() {
  const router = useRouter()
  const { showToast } = useToast()

  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [origin, setOrigin] = useState('')
  const [keyPrefix, setKeyPrefix] = useState('')
  const [name, setName] = useState('')
  const [shortName, setShortName] = useState('')
  const [tagline, setTagline] = useState('')
  const [description, setDescription] = useState('')
  const [analyticsId, setAnalyticsId] = useState('')
  const [githubUrl, setGithubUrl] = useState('')

  const [, startTransition] = useTransition()

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const result = await get<{ site: SiteConfigData }>('/api/admin/site')
        if (!result.ok || !result.data) {
          throw new Error(result.error || t.admin.siteProfile.loadFailed)
        }
        if (active) {
          const site = result.data.site
          setOrigin(site.origin)
          setKeyPrefix(site.keyPrefix)
          setName(site.name)
          setShortName(site.shortName)
          setTagline(site.tagline)
          setDescription(site.description)
          setAnalyticsId(site.analyticsId ?? '')
          setGithubUrl(site.githubUrl ?? '')
          setLoading(false)
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : t.admin.siteProfile.loadFailed)
          setLoading(false)
        }
      }
    }
    load()
    return () => {
      active = false
    }
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const result = await patch<{ site: SiteConfigData }>('/api/admin/site', {
        name: name.trim(),
        shortName: shortName.trim(),
        tagline: tagline.trim(),
        description: description.trim(),
        analyticsId: analyticsId.trim() || null,
        githubUrl: githubUrl.trim() || null,
      })

      if (!result.ok || !result.data) {
        throw new Error(result.error || t.admin.siteProfile.saveFailed)
      }

      showToast(t.admin.siteProfile.savedToast, 'success')
      startTransition(() => {
        router.refresh()
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : t.admin.siteProfile.saveFailed
      setError(msg)
      showToast(msg, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-base text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'
  const labelCls = 'mb-1 block text-sm font-medium text-ink-muted'

  if (loading) {
    return (
      <div className="px-4 py-8 text-center text-ink-muted">
        {t.common.loadingEllipsis}
      </div>
    )
  }

  return (
    <div className="px-4 py-4">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-ink">{t.admin.siteProfile.title}</h2>
        <p className="text-sm text-ink-muted">{t.admin.siteProfile.description}</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-xl border border-line bg-surface p-4"
      >
        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="site-name" className={labelCls}>
              {t.admin.siteProfile.name} <span className="text-danger">*</span>
            </label>
            <input
              id="site-name"
              type="text"
              required
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="site-short-name" className={labelCls}>
              {t.admin.siteProfile.shortName} <span className="text-danger">*</span>
            </label>
            <input
              id="site-short-name"
              type="text"
              required
              maxLength={30}
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label htmlFor="site-tagline" className={labelCls}>
            {t.admin.siteProfile.tagline} <span className="text-danger">*</span>
          </label>
          <input
            id="site-tagline"
            type="text"
            required
            maxLength={200}
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="site-description" className={labelCls}>
            {t.admin.siteProfile.siteDescription} <span className="text-danger">*</span>
          </label>
          <textarea
            id="site-description"
            required
            rows={3}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputCls}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="site-github-url" className={labelCls}>{t.admin.siteProfile.githubUrl}</label>
            <input
              id="site-github-url"
              type="url"
              maxLength={200}
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              placeholder="https://github.com/..."
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="site-analytics-id" className={labelCls}>{t.admin.siteProfile.analyticsId}</label>
            <input
              id="site-analytics-id"
              type="text"
              maxLength={100}
              value={analyticsId}
              onChange={(e) => setAnalyticsId(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        {/* Read-only infrastructure settings */}
        <div className="rounded-lg bg-canvas px-4 py-3 text-sm">
          <p className="text-xs text-ink-faint">{t.admin.siteProfile.originNotice}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 text-xs">
            <div>
              <span className="font-semibold text-ink-muted">{t.admin.siteProfile.origin}:</span>{' '}
              <span className="font-mono text-ink">{origin}</span>
            </div>
            <div>
              <span className="font-semibold text-ink-muted">{t.admin.siteProfile.keyPrefix}:</span>{' '}
              <span className="font-mono text-ink">{keyPrefix}</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <Button type="submit" loading={submitting}>
            {t.admin.siteProfile.saveChanges}
          </Button>
        </div>
      </form>
    </div>
  )
}
