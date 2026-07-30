'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useToast } from '@/components/ui/Toast'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/cn'
import { listApiKeys, createApiKey, revokeApiKey } from '@/actions/account'
import { AlertIcon, XIcon } from '@/components/icons'

interface ApiKey {
  id: string
  name: string
  prefix: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
}

interface CreatedKey extends ApiKey {
  rawKey: string
}

export function ApiKeysClient({
  verificationStatus,
}: {
  verificationStatus: string
}) {
  const { showToast } = useToast()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newKey, setNewKey] = useState<CreatedKey | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const isVerified = verificationStatus === 'verified'

  const loadKeys = useCallback(async () => {
    try {
      const result = await listApiKeys()
      if (result.ok) {
        setKeys(result.data.keys as ApiKey[])
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  // Mount: fetch keys once. setLoading(false) in the finally block
  // is the only state mutation — driven by the async completion, not by effect.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await listApiKeys()
        if (!cancelled && result.ok) {
          setKeys(result.data.keys as ApiKey[])
        }
      } catch {
        // silent
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const result = await createApiKey(name.trim())
      if (!result.ok) {
        showToast(result.error || t.errors.unexpectedError, 'error')
        return
      }
      setNewKey(result.data as CreatedKey)
      setName('')
      showToast(t.api.keyCreated, 'success')
      loadKeys()
    } catch {
      showToast(t.errors.unexpectedError, 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: string) => {
    if (!confirm(t.api.revokeConfirm)) return
    setRevokingId(id)
    try {
      const result = await revokeApiKey(id)
      if (!result.ok) {
        showToast(result.error || t.errors.unexpectedError, 'error')
        return
      }
      showToast(t.api.keyRevoked, 'success')
      loadKeys()
    } catch {
      showToast(t.errors.unexpectedError, 'error')
    } finally {
      setRevokingId(null)
    }
  }

  const handleCopy = async (rawKey: string) => {
    try {
      await navigator.clipboard.writeText(rawKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      showToast(t.postMenu.copyFailed, 'error')
    }
  }

  const formatDate = (date: Date | string | null) => {
    if (!date) return t.api.never
    return new Date(date).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      <p className="mb-6 text-sm text-ink-muted">{t.api.description}</p>

      {/* Verification gate */}
      {!isVerified && (
        <div className="mb-6 rounded-xl border border-warning/40 bg-warning-tint p-4 text-sm text-warning">
          {t.api.verificationRequired}
          <Link href="/verify" className="ml-2 font-medium underline">
            Verify →
          </Link>
        </div>
      )}

      {/* Create form */}
      {isVerified && (
        <div className="mb-6 rounded-xl border border-line bg-surface p-4">
          <label className="mb-2 block text-sm font-medium">{t.api.createKey}</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.api.keyNamePlaceholder}
              maxLength={100}
              className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && !creating) handleCreate()
              }}
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim() || creating}
              className={cn(
                'rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition',
                'hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {creating ? '...' : t.api.create}
            </button>
          </div>
        </div>
      )}

      {/* Raw key display (one-time) */}
      {newKey && (
        <div className="mb-6 rounded-xl border border-brand/40 bg-brand-tint p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-brand-ink">
              {newKey.name}
            </span>
            <button
              onClick={() => setNewKey(null)}
              className="text-ink-muted hover:text-ink"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <p className="mb-3 flex items-center gap-1 text-xs text-warning">
            <AlertIcon className="h-3.5 w-3.5" />
            {t.api.rawKeyWarning}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-surface px-3 py-2 text-sm font-mono">
              {newKey.rawKey}
            </code>
            <button
              onClick={() => handleCopy(newKey.rawKey)}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-hover"
            >
              {copied ? t.api.rawKeyCopied : t.api.copyKey}
            </button>
          </div>
        </div>
      )}

      {/* Key list */}
      {loading ? (
        <p className="text-sm text-ink-muted">...</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-ink-muted">{t.api.noKeys}</p>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => (
            <div
              key={key.id}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{key.name}</p>
                  <p className="mt-1 font-mono text-xs text-ink-muted">
                    cas_{key.prefix}...
                  </p>
                  <div className="mt-2 flex gap-4 text-xs text-ink-muted">
                    <span>
                      {t.api.createdAt}: {formatDate(key.createdAt)}
                    </span>
                    <span>
                      {t.api.lastUsed}: {formatDate(key.lastUsedAt)}
                    </span>
                    {key.expiresAt && (
                      <span>
                        {t.api.expiresAt}: {formatDate(key.expiresAt)}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(key.id)}
                  disabled={revokingId === key.id}
                  className={cn(
                    'shrink-0 rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger',
                    'hover:bg-danger-tint disabled:opacity-50',
                  )}
                >
                  {revokingId === key.id ? '...' : t.api.revoke}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
