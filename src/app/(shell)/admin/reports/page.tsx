'use client'

import { useState, useEffect, useTransition } from 'react'
import { t } from '@/lib/i18n'
import Link from 'next/link'
import { Avatar } from '@/components/ui/Avatar'
import { useToast } from '@/components/ui/Toast'
import { VerifiedBadge } from '@/components/icons'
import { cn } from '@/lib/cn'
import { timeAgo } from '@/lib/utils'
import { get, post } from '@/lib/api-client'

function reportsUrl(status: string): string {
  return `/api/admin/reports?status=${encodeURIComponent(status)}`
}

interface AdminReport {
  id: string
  targetType: 'POST' | 'USER'
  reason: string
  detail: string | null
  status: 'PENDING' | 'RESOLVED' | 'DISMISSED'
  adminNote: string | null
  createdAt: string
  handledAt: string | null
  reporter: {
    id: string
    username: string
    displayName: string | null
    avatar: string | null
    verificationStatus: string
  }
  reportedUser: {
    id: string
    username: string
    displayName: string | null
    avatar: string | null
    verificationStatus: string
    status: string
  }
  post: {
    id: string
    shortCode: string | null
    content: string
    images: string[]
    createdAt: string
    author: {
      id: string
      username: string
      displayName: string | null
      avatar: string | null
      verificationStatus: string
    }
  } | null
  handledByUser: {
    id: string
    username: string
    displayName: string | null
  } | null
}

const REASON_LABELS: Record<string, string> = {
  spam: t.report.reasonLabels.spam,
  harassment: t.report.reasonLabels.harassment,
  misinformation: t.report.reasonLabels.misinformation,
  illegal_substance: t.report.reasonLabels.illegal_substance,
  scam_fraud: t.report.reasonLabels.scam_fraud,
  impersonation: t.report.reasonLabels.impersonation,
  other: t.report.reasonLabels.other,
}

export default function AdminReportsPage() {
  const { showToast } = useToast()
  const [reports, setReports] = useState<AdminReport[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [acting, setActing] = useState<string | null>(null)
  const [filter, setFilter] = useState<'PENDING' | 'RESOLVED' | 'DISMISSED' | 'all'>('PENDING')
  const [initialLoaded, setInitialLoaded] = useState(false)

  // useTransition manages the loading spinner for filter-change refetches.
  // initialLoaded gates the empty-list message vs. spinner on first load.
  const [, startTransition] = useTransition()
  const loading = !initialLoaded

  useEffect(() => {
    startTransition(async () => {
      try {
        const result = await get<{ reports: AdminReport[]; pendingCount: number }>(
          reportsUrl(filter),
        )
        if (!result.ok) throw new Error(result.error ?? undefined)
        setReports(result.data!.reports)
        setPendingCount(result.data!.pendingCount)
      } catch {
        showToast(t.admin.loadingFailed, 'error')
      } finally {
        setInitialLoaded(true)
      }
    })
  }, [filter, showToast, startTransition])

  const resolve = async (id: string, action: string) => {
    setActing(id)
    try {
      const result = await post(`/api/admin/reports/${id}/resolve`, { action })
      if (!result.ok) throw new Error(result.error ?? undefined)
      showToast(t.admin.resolvedToast, 'success')
      // Refetch without loading state (avoid list flicker)
      startTransition(async () => {
        try {
          const result = await get<{ reports: AdminReport[]; pendingCount: number }>(
            reportsUrl(filter),
          )
          if (!result.ok) throw new Error(result.error ?? undefined)
          setReports(result.data!.reports)
          setPendingCount(result.data!.pendingCount)
        } catch {
          showToast(t.admin.loadingFailed, 'error')
        }
      })
    } catch {
      showToast(t.admin.resolveFailed, 'error')
    } finally {
      setActing(null)
    }
  }

  const dismiss = async (id: string) => {
    setActing(id)
    try {
      const result = await post(`/api/admin/reports/${id}/dismiss`)
      if (!result.ok) throw new Error(result.error ?? undefined)
      showToast(t.admin.dismissedToast, 'success')
      startTransition(async () => {
        try {
          const result = await get<{ reports: AdminReport[]; pendingCount: number }>(
            reportsUrl(filter),
          )
          if (!result.ok) throw new Error(result.error ?? undefined)
          setReports(result.data!.reports)
          setPendingCount(result.data!.pendingCount)
        } catch {
          showToast(t.admin.loadingFailed, 'error')
        }
      })
    } catch {
      showToast(t.admin.dismissFailed, 'error')
    } finally {
      setActing(null)
    }
  }

  const filters = [
    { id: 'PENDING' as const, label: t.admin.pending },
    { id: 'RESOLVED' as const, label: t.admin.resolved },
    { id: 'DISMISSED' as const, label: t.admin.dismissed },
    { id: 'all' as const, label: t.admin.all },
  ]

  return (
    <div className="px-4 py-4">
      {/* Filter tabs */}
      <div className="mb-4 flex gap-1">
        {filters.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'shrink-0 rounded-full px-3 py-1 text-sm font-semibold transition-colors',
              filter === f.id ? 'bg-brand text-white' : 'bg-surface-hover text-ink-muted hover:text-ink',
            )}
          >
            {f.label}
            {f.id === 'PENDING' && pendingCount > 0 && (
              <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-xs text-white">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="py-8 text-center text-ink-muted">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="py-8 text-center text-ink-muted">{t.admin.noReports}</p>
      ) : (
        <div className="space-y-3">
          {reports.map((r) => {
            const reportName = r.reportedUser.displayName || r.reportedUser.username
            return (
              <div key={r.id} className="rounded-xl border border-line bg-surface p-4">
                {/* Header: reason + status */}
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-danger-tint px-2 py-0.5 text-xs font-bold text-danger">
                      {REASON_LABELS[r.reason] ?? r.reason}
                    </span>
                    {r.targetType === 'POST' ? (
                      <span className="text-xs text-ink-faint">{t.admin.postReport}</span>
                    ) : (
                      <span className="text-xs text-ink-faint">{t.admin.userReport}</span>
                    )}
                  </div>
                  <span className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold',
                    r.status === 'PENDING' ? 'bg-warning-tint text-warning' :
                    r.status === 'RESOLVED' ? 'bg-success-tint text-success' :
                    'bg-surface-hover text-ink-muted',
                  )}>
                    {r.status.toLowerCase()}
                  </span>
                </div>

                {/* Detail */}
                {r.detail && (
                  <p className="mb-3 rounded-lg bg-canvas px-3 py-2 text-sm text-ink">
                    &ldquo;{r.detail}&rdquo;
                  </p>
                )}

                {/* Post preview (if POST report) */}
                {r.targetType === 'POST' && r.post && (
                  <Link
                    href={r.post.shortCode ? `/p/${r.post.shortCode}` : '#'}
                    className="mb-3 block rounded-lg border border-line bg-canvas p-3 transition-colors hover:bg-surface-hover"
                  >
                    <div className="mb-1 flex items-center gap-1.5 text-xs">
                      <Avatar
                        src={r.post.author.avatar}
                        name={r.post.author.displayName || r.post.author.username}
                        username={r.post.author.username}
                        size="sm"
                      />
                      <span className="font-semibold text-ink">
                        {r.post.author.displayName || r.post.author.username}
                      </span>
                      {r.post.author.verificationStatus === 'verified' && (
                        <VerifiedBadge className="h-3 w-3 text-brand" />
                      )}
                      <span className="text-ink-faint">@{r.post.author.username}</span>
                      <span className="text-ink-faint">·</span>
                      <span className="text-ink-faint">{timeAgo(r.post.createdAt)}</span>
                    </div>
                    <p className="text-sm text-ink line-clamp-2">{r.post.content || '(no text)'}</p>
                    {r.post.images.length > 0 && (
                      <div className="mt-1.5 flex gap-1">
                        {r.post.images.slice(0, 3).map((img, i) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={i} src={img} alt="" className="h-12 w-12 rounded object-cover" />
                        ))}
                      </div>
                    )}
                  </Link>
                )}

                {/* Reported user info */}
                <div className="mb-3 flex items-center gap-2 text-sm">
                  <span className="text-ink-faint">{t.admin.reportedUser}</span>
                  <Link href={`/u/${r.reportedUser.username}`} className="flex items-center gap-1 font-semibold text-ink hover:underline">
                    <Avatar
                      src={r.reportedUser.avatar}
                      name={reportName}
                      username={r.reportedUser.username}
                      size="sm"
                    />
                    {reportName}
                    {r.reportedUser.verificationStatus === 'verified' && (
                      <VerifiedBadge className="h-3 w-3 text-brand" />
                    )}
                  </Link>
                  <span className={cn(
                    'rounded px-1.5 text-xs font-medium',
                    r.reportedUser.status === 'active' ? 'bg-success-tint text-success' :
                    r.reportedUser.status === 'restricted' ? 'bg-warning-tint text-warning' :
                    'bg-danger-tint text-danger',
                  )}>
                    {r.reportedUser.status}
                  </span>
                </div>

                {/* Reporter + time */}
                <div className="mb-3 flex items-center gap-1.5 text-xs text-ink-faint">
                  <span>{t.admin.reportedBy}</span>
                  <Link href={`/u/${r.reporter.username}`} className="font-medium text-ink-muted hover:underline">
                    @{r.reporter.username}
                  </Link>
                  <span>·</span>
                  <span>{timeAgo(r.createdAt)}</span>
                  {r.handledByUser && (
                    <>
                      <span>·</span>
                      <span>by @{r.handledByUser.username}</span>
                    </>
                  )}
                </div>

                {/* Actions */}
                {r.status === 'PENDING' && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    {r.targetType === 'POST' && (
                      <button
                        onClick={() => resolve(r.id, 'delete')}
                        disabled={acting === r.id}
                        className="rounded-lg bg-danger px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-danger-strong disabled:opacity-50"
                      >
                        Delete post
                      </button>
                    )}
                    <button
                      onClick={() => resolve(r.id, 'suspend')}
                      disabled={acting === r.id}
                      className="rounded-lg bg-danger/10 px-3 py-1.5 text-xs font-bold text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
                    >
                      Suspend user
                    </button>
                    <button
                      onClick={() => resolve(r.id, 'warn')}
                      disabled={acting === r.id}
                      className="rounded-lg border border-line-strong px-3 py-1.5 text-xs font-bold text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
                    >
                      Warn only
                    </button>
                    <button
                      onClick={() => dismiss(r.id)}
                      disabled={acting === r.id}
                      className="ml-auto rounded-lg px-3 py-1.5 text-xs font-bold text-ink-faint transition-colors hover:bg-surface-hover disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
