'use client'

import { useState, useEffect, useTransition } from 'react'
import { t } from '@/lib/i18n'
import Link from 'next/link'
import { Avatar } from '@/components/ui/Avatar'
import { useToast } from '@/components/ui/Toast'
import { get, post, patch } from '@/lib/api-client'

function usersUrl(q: string, status: string): string {
  const p = new URLSearchParams()
  if (q) p.set('q', q)
  if (status) p.set('status', status)
  return `/api/admin/users?${p.toString()}`
}

interface AdminUser {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  email: string
  role: string
  verificationStatus: string
  status: string
  createdAt: string
  postCount: number
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-success-tint text-success',
  restricted: 'bg-warning-tint text-warning',
  suspended: 'bg-danger-tint text-danger',
}

export default function AdminUsersPage() {
  const { showToast } = useToast()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [acting, setActing] = useState<string | null>(null)

  const [loading, startTransition] = useTransition()

  // Only fetch when there is an explicit search query or status filter.
  // On initial mount (both empty) the list stays blank — no full-table scan.
  useEffect(() => {
    if (!searchQuery && !statusFilter) return
    startTransition(async () => {
      try {
        const result = await get<{ users: AdminUser[] }>(
          usersUrl(searchQuery, statusFilter),
        )
        if (!result.ok) throw new Error(result.error ?? undefined)
        setUsers(result.data!.users)
      } catch {
        showToast(t.admin.usersLoadFailed, 'error')
      }
    })
  }, [searchQuery, statusFilter, showToast, startTransition])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setSearchQuery(searchInput.trim())
  }

  const changeStatus = async (userId: string, newStatus: string) => {
    setActing(userId)
    try {
      const result = await patch(`/api/admin/users/${userId}`, { status: newStatus })
      if (!result.ok) {
        throw new Error(result.error || t.errors.failed)
      }
      showToast(`Status changed to ${newStatus}`, 'success')
      startTransition(async () => {
        try {
          const result = await get<{ users: AdminUser[] }>(
            usersUrl(searchQuery, statusFilter),
          )
          if (!result.ok) throw new Error(result.error ?? undefined)
          setUsers(result.data!.users)
        } catch {
          showToast(t.admin.usersLoadFailed, 'error')
        }
      })
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.errors.failed, 'error')
    } finally {
      setActing(null)
    }
  }

  const toggleVerify = async (userId: string, currentlyVerified: boolean) => {
    setActing(userId)
    try {
      const result = currentlyVerified
        ? await post(`/api/admin/users/${userId}/revoke-verification`)
        : await post(`/api/admin/users/${userId}/verify`)
      if (!result.ok) {
        throw new Error(result.error || t.errors.failed)
      }
      showToast(currentlyVerified ? t.admin.verificationRevoked : t.admin.userVerified, 'success')
      startTransition(async () => {
        try {
          const result = await get<{ users: AdminUser[] }>(
            usersUrl(searchQuery, statusFilter),
          )
          if (!result.ok) throw new Error(result.error ?? undefined)
          setUsers(result.data!.users)
        } catch {
          showToast(t.admin.usersLoadFailed, 'error')
        }
      })
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.errors.failed, 'error')
    } finally {
      setActing(null)
    }
  }

  const filters = [
    { id: 'active', label: t.common.active },
    { id: 'restricted', label: t.common.restricted },
    { id: 'suspended', label: t.common.suspended },
  ]

  return (
    <div className="px-4 py-4">
      {/* Search + filter */}
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
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold transition-colors ${
                statusFilter === f.id
                  ? 'bg-brand text-white'
                  : 'bg-surface-hover text-ink-muted hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* User list */}
      {loading ? (
        <p className="py-8 text-center text-ink-muted">{t.common.loadingEllipsis}</p>
      ) : users.length === 0 ? (
        <p className="py-8 text-center text-ink-muted">
          {searchQuery || statusFilter  ? t.admin.noUsersFound : t.admin.searchHint }
        </p>
      ) : (
        <div className="space-y-2">
          {users.map((user) => (
            <div key={user.id} className="rounded-xl border border-line bg-surface p-3">
              <div className="flex items-center gap-3">
                <Link href={`/u/${user.username}`} className="shrink-0">
                  <Avatar
                    src={user.avatar}
                    name={user.displayName || user.username}
                    username={user.username}
                    size="md"
                  />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link href={`/u/${user.username}`} className="truncate font-semibold text-ink hover:underline">
                      {user.displayName || user.username}
                    </Link>
                    {user.verificationStatus === 'verified' && (
                      <span className="text-xs text-brand">✓</span>
                    )}
                  </div>
                  <p className="truncate text-sm text-ink-faint">
                    @{user.username} · {user.postCount} posts
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[user.status] ?? ''}`}>
                  {user.status}
                </span>
              </div>

              {/* Actions row */}
              <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
                <button
                  onClick={() => toggleVerify(user.id, user.verificationStatus === 'verified')}
                  disabled={acting === user.id}
                  className={`shrink-0 rounded-lg px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
                    user.verificationStatus === 'verified'
                      ? 'bg-brand-tint text-brand-ink hover:bg-brand hover:text-white'
                      : 'border border-line-strong text-ink-muted hover:border-brand hover:text-brand'
                  }`}
                >
                  {user.verificationStatus === 'verified' ? t.admin.verifiedBtn : t.admin.verifyBtn}
                </button>
                <select
                  value={user.status}
                  disabled={acting === user.id}
                  onChange={(e) => changeStatus(user.id, e.target.value)}
                  className="rounded-lg border border-line-strong bg-canvas px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none disabled:opacity-50"
                >
                  <option value="active">{t.common.active}</option>
                  <option value="restricted">{t.common.restricted}</option>
                  <option value="suspended">{t.common.suspended}</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
