'use client'

import { useState, useEffect, useTransition } from 'react'
import { t } from '@/lib/i18n'
import { Avatar } from '@/components/ui/Avatar'
import { useToast } from '@/components/ui/Toast'
import {
  adminListVerifications,
  adminApproveVerification,
  adminRejectVerification,
} from '@/actions/admin'

interface SubmissionUser {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  email: string
  verificationStatus: string
}

interface Submission {
  id: string
  userId: string
  idName: string
  idNumber: string
  idFrontImage: string
  idBackImage: string
  status: string
  reviewedBy: string | null
  reviewedAt: string | null
  expiresAt: string | null
  reviewNote: string | null
  submittedAt: string
  user: SubmissionUser
}

export default function AdminVerificationsPage() {
  const { showToast } = useToast()
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [filter, setFilter] = useState('pending')
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [acting, setActing] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [initialLoaded, setInitialLoaded] = useState(false)

  const [, startTransition] = useTransition()
  const loading = !initialLoaded

  useEffect(() => {
    startTransition(async () => {
      try {
        const result = await adminListVerifications({
          status: filter,
          q: searchQuery || undefined,
        })
        if (!result.ok) throw new Error()
        setSubmissions(result.data.submissions as Submission[])
      } catch {
        showToast(t.admin.verificationsLoadFailed, 'error')
      } finally {
        setInitialLoaded(true)
      }
    })
  }, [filter, searchQuery, showToast, startTransition])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setSearchQuery(searchInput.trim())
  }

  const approve = async (id: string) => {
    setActing(id)
    try {
      const result = await adminApproveVerification(id)
      if (!result.ok) throw new Error()
      showToast(t.admin.approveToast, 'success')
      startTransition(async () => {
        try {
          const result = await adminListVerifications({ status: filter, q: searchQuery || undefined })
          if (!result.ok) throw new Error()
          setSubmissions(result.data.submissions as Submission[])
        } catch {
          showToast(t.admin.verificationsLoadFailed, 'error')
        }
      })
    } catch {
      showToast(t.admin.approveFailed, 'error')
    } finally {
      setActing(null)
    }
  }

  const reject = async (id: string) => {
    setActing(id)
    try {
      const result = await adminRejectVerification(id, rejectNote.trim() || undefined)
      if (!result.ok) throw new Error()
      showToast(t.admin.rejectToast, 'info')
      startTransition(async () => {
        try {
          const result = await adminListVerifications({ status: filter, q: searchQuery || undefined })
          if (!result.ok) throw new Error()
          setSubmissions(result.data.submissions as Submission[])
        } catch {
          showToast(t.admin.verificationsLoadFailed, 'error')
        }
      })
    } catch {
      showToast(t.admin.rejectFailed, 'error')
    } finally {
      setActing(null)
      setRejectingId(null)
      setRejectNote('')
    }
  }

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })

  const tabs = [
    { id: 'pending', label: t.admin.pendingTab },
    { id: 'approved', label: t.admin.approvedTab },
    { id: 'rejected', label: t.admin.rejectedTab },
    { id: 'all', label: t.admin.allTab },
  ]

  return (
    <div className="px-4 py-4">
      {/* Search + filters — same layout as admin/users */}
      <div className="mb-4 space-y-2">
        <form onSubmit={handleSearch}>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t.admin.searchUsername}
            className="w-full max-w-sm rounded-full border border-line-strong bg-canvas px-4 py-1.5 text-base text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
          />
        </form>
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold transition-colors ${
                filter === tab.id
                  ? 'bg-brand text-white'
                  : 'bg-surface-hover text-ink-muted hover:text-ink'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <p className="py-8 text-center text-ink-muted">Loading…</p>
      ) : submissions.length === 0 ? (
        <p className="py-8 text-center text-ink-muted">{t.admin.noSubmissions}</p>
      ) : (
        <div className="space-y-4">
          {submissions.map((sub) => (
            <div key={sub.id} className="rounded-xl border border-line bg-surface p-4">
              {/* User header */}
              <div className="mb-3 flex items-center gap-3">
                <Avatar
                  src={sub.user.avatar}
                  name={sub.user.displayName || sub.user.username}
                  username={sub.user.username}
                  size="md"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-ink">
                    {sub.user.displayName || sub.user.username}
                  </p>
                  <p className="truncate text-sm text-ink-faint">@{sub.user.username} · {sub.user.email}</p>
                </div>
                <div className="text-right text-xs text-ink-faint">
                  <p>{t.admin.submittedLabel}</p>
                  <p>{fmtDate(sub.submittedAt)}</p>
                </div>
              </div>

              {/* ID info */}
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg bg-canvas px-3 py-2">
                  <p className="text-xs text-ink-faint">{t.verify.legalName}</p>
                  <p className="font-medium text-ink">{sub.idName}</p>
                </div>
                <div className="rounded-lg bg-canvas px-3 py-2">
                  <p className="text-xs text-ink-faint">ID number</p>
                  <p className="font-mono text-sm text-ink">{sub.idNumber}</p>
                </div>
              </div>

              {/* ID photos */}
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                <a href={sub.idFrontImage} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-lg border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={sub.idFrontImage} alt={t.admin.idFront} className="h-40 w-full object-cover" />
                </a>
                <a href={sub.idBackImage} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-lg border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={sub.idBackImage} alt={t.admin.idBack} className="h-40 w-full object-cover" />
                </a>
              </div>

              {/* Review info for non-pending */}
              {sub.status !== 'pending' && sub.reviewedAt && (
                <div className="mb-3 rounded-lg bg-canvas px-3 py-2 text-sm text-ink-muted">
                  {sub.status === 'approved' ? '✓ Approved' : '✗ Rejected'} on {fmtDate(sub.reviewedAt)}
                  {sub.reviewNote && <span className="block text-ink-faint">Note: {sub.reviewNote}</span>}
                  {sub.expiresAt && <span className="block text-ink-faint">Expires: {fmtDate(sub.expiresAt)}</span>}
                </div>
              )}

              {/* Actions */}
              {sub.status === 'pending' && (
                <div className="flex flex-col gap-2">
                  {rejectingId === sub.id ? (
                    <>
                      <textarea
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                        placeholder={t.report.detailsPlaceholder}
                        rows={2}
                        className="w-full rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-brand/60 focus:ring-1 focus:ring-brand/40"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => reject(sub.id)}
                          disabled={acting === sub.id}
                          className="flex-1 rounded-lg bg-danger py-2 text-sm font-semibold text-white transition-colors hover:bg-danger/90 disabled:opacity-50"
                        >
                          {t.admin.confirmReject}
                        </button>
                        <button
                          onClick={() => { setRejectingId(null); setRejectNote('') }}
                          disabled={acting === sub.id}
                          className="flex-1 rounded-lg border border-line-strong py-2 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
                        >
                          {t.common.cancel}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => approve(sub.id)}
                        disabled={acting === sub.id}
                        className="flex-1 rounded-lg bg-brand py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-ink disabled:opacity-50"
                      >
                        {t.admin.approve}
                      </button>
                      <button
                        onClick={() => setRejectingId(sub.id)}
                        disabled={acting === sub.id}
                        className="flex-1 rounded-lg border border-danger py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50"
                      >
                        {t.admin.reject}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
