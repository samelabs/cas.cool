'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useToast } from '@/components/ui/Toast'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/cn'
import { get, post, del } from '@/lib/api-client'
import { AlertIcon, XIcon } from '@/components/icons'
import { useSite } from '@/components/Providers'

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
  const site = useSite()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newKey, setNewKey] = useState<CreatedKey | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState(false)
  const [copiedMcp, setCopiedMcp] = useState(false)
  const [copiedCurl, setCopiedCurl] = useState(false)
  const [canProgrammaticWrite, setCanProgrammaticWrite] = useState(verificationStatus === 'verified')

  const mcpUrl = `${site.origin}/mcp`
  const exampleCurl = `curl -H "Authorization: Bearer YOUR_API_KEY" "${site.origin}/api/posts"`
  const exampleMcpConfig = JSON.stringify(
    {
      mcpServers: {
        cascool: {
          url: mcpUrl,
          headers: {
            Authorization: 'Bearer YOUR_API_KEY',
          },
        },
      },
    },
    null,
    2,
  )

  const refreshData = useCallback(async () => {
    try {
      const [keyResult, capResult] = await Promise.all([
        get<{ keys: ApiKey[] }>('/api/account/api-keys'),
        get<{ accountQualifications?: { canProgrammaticWrite?: boolean } }>('/api/account/capabilities'),
      ])
      if (keyResult.ok && keyResult.data) {
        setKeys(keyResult.data.keys as ApiKey[])
      }
      if (capResult.ok && capResult.data?.accountQualifications) {
        setCanProgrammaticWrite(Boolean(capResult.data.accountQualifications.canProgrammaticWrite))
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false
    const load = async () => {
      try {
        const [keyResult, capResult] = await Promise.all([
          get<{ keys: ApiKey[] }>('/api/account/api-keys'),
          get<{ accountQualifications?: { canProgrammaticWrite?: boolean } }>('/api/account/capabilities'),
        ])
        if (!ignore) {
          if (keyResult.ok && keyResult.data) {
            setKeys(keyResult.data.keys as ApiKey[])
          }
          if (capResult.ok && capResult.data?.accountQualifications) {
            setCanProgrammaticWrite(Boolean(capResult.data.accountQualifications.canProgrammaticWrite))
          }
        }
      } catch {
        // silent
      } finally {
        if (!ignore) setLoading(false)
      }
    }
    void load()

    const onFocus = () => {
      void refreshData()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshData()
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      ignore = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refreshData])

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const result = await post<CreatedKey>('/api/account/api-keys', { name: name.trim() })
      if (!result.ok) {
        showToast(result.error || t.errors.unexpectedError, 'error')
        return
      }
      setNewKey(result.data as CreatedKey)
      setName('')
      showToast(t.api.keyCreated, 'success')
      refreshData()
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
      const result = await del('/api/account/api-keys/' + id)
      if (!result.ok) {
        showToast(result.error || t.errors.unexpectedError, 'error')
        return
      }
      showToast(t.api.keyRevoked, 'success')
      refreshData()
    } catch {
      showToast(t.errors.unexpectedError, 'error')
    } finally {
      setRevokingId(null)
    }
  }

  const handleCopyKey = async (rawKey: string) => {
    try {
      await navigator.clipboard.writeText(rawKey)
      setCopiedKey(true)
      setTimeout(() => setCopiedKey(false), 2000)
    } catch {
      showToast(t.postMenu.copyFailed, 'error')
    }
  }

  const handleCopyMcp = async () => {
    try {
      await navigator.clipboard.writeText(exampleMcpConfig)
      setCopiedMcp(true)
      setTimeout(() => setCopiedMcp(false), 2000)
    } catch {
      showToast(t.postMenu.copyFailed, 'error')
    }
  }

  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(exampleCurl)
      setCopiedCurl(true)
      setTimeout(() => setCopiedCurl(false), 2000)
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
    <div className="px-4 py-4">
      <p className="mb-4 text-sm text-ink-muted">{t.api.description}</p>

      {/* Dynamic capability status badge */}
      <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 text-sm">
        <span className="font-medium text-ink">{t.api.effectiveCapability}</span>
        <span
          className={cn(
            'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
            canProgrammaticWrite ? 'bg-brand/10 text-brand' : 'bg-line text-ink-muted',
          )}
        >
          {canProgrammaticWrite ? t.api.readWriteCapable : t.api.readOnlyCapable}
        </span>
        {!canProgrammaticWrite && (
          <span className="text-xs text-ink-muted">
            ({t.api.verificationNotice}{' '}
            <Link href="/verify" className="font-medium text-brand underline">
              {t.api.verifyLink}
            </Link>
            )
          </span>
        )}
      </div>

      {/* Create form — available for all active members */}
      <div className="mb-6 rounded-xl border border-line bg-surface p-4">
        <label className="mb-2 block text-sm font-medium text-ink">{t.api.createKey}</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.api.keyNamePlaceholder}
            maxLength={100}
            className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-base outline-none focus:border-brand"
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

      {/* Raw key display (one-time) */}
      {newKey && (
        <div className="mb-6 rounded-xl border border-brand/40 bg-brand-tint p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-brand-ink">
              {newKey.name}
              <span className="ml-2 text-xs font-normal text-ink-muted">
                {canProgrammaticWrite ? t.api.readWriteCapable : t.api.readOnlyCapable}
              </span>
            </span>
            <button onClick={() => setNewKey(null)} className="text-ink-muted hover:text-ink">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <p className="mb-3 flex items-center gap-1 text-xs text-warning">
            <AlertIcon className="h-3.5 w-3.5" />
            {t.api.rawKeyWarning}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-surface px-3 py-2 text-sm font-mono text-ink">
              {newKey.rawKey}
            </code>
            <button
              onClick={() => handleCopyKey(newKey.rawKey)}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-hover"
            >
              {copiedKey ? t.api.rawKeyCopied : t.api.copyKey}
            </button>
          </div>
        </div>
      )}

      {/* REST API Integration Section */}
      <div className="mb-6 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink">{t.api.restTitle}</h3>
            <p className="mt-1 text-xs text-ink-muted">{t.api.restDescription}</p>
          </div>
          <Link
            href="/llms.txt"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs font-medium text-brand hover:underline"
          >
            {t.api.restDocsLink}
          </Link>
        </div>
        <div className="mt-3">
          <span className="text-xs font-medium text-ink-muted">{t.api.restAuthHeader}</span>
          <code className="mt-1 block rounded-lg bg-surface-hover px-3 py-2 text-xs font-mono text-ink">
            Authorization: Bearer YOUR_API_KEY
          </code>
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-muted">{t.api.restExampleTitle}</span>
            <button
              onClick={handleCopyCurl}
              className="text-xs font-medium text-brand hover:underline"
            >
              {copiedCurl ? t.api.rawKeyCopied : t.api.copyCurl}
            </button>
          </div>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-hover p-3 text-xs font-mono text-ink">
            {exampleCurl}
          </pre>
        </div>
      </div>

      {/* MCP Integration Section */}
      <div className="mb-6 rounded-xl border border-line bg-surface p-4">
        <h3 className="text-sm font-semibold text-ink">{t.api.mcpTitle}</h3>
        <p className="mt-1 text-xs text-ink-muted">{t.api.mcpDescription}</p>
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-muted">{t.api.mcpEndpoint}</span>
          </div>
          <code className="mt-1 block rounded-lg bg-surface-hover px-3 py-2 text-xs font-mono text-ink">
            {mcpUrl}
          </code>
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-muted">{t.api.mcpConfigExample}</span>
            <button
              onClick={handleCopyMcp}
              className="text-xs font-medium text-brand hover:underline"
            >
              {copiedMcp ? t.api.rawKeyCopied : t.api.copyConfig}
            </button>
          </div>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-hover p-3 text-xs font-mono text-ink">
            {exampleMcpConfig}
          </pre>
        </div>
      </div>

      {/* Key list */}
      <h3 className="mb-3 text-sm font-semibold text-ink">{t.api.title}</h3>
      {loading ? (
        <p className="text-sm text-ink-muted">...</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-ink-muted">{t.api.noKeys}</p>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => (
            <div key={key.id} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{key.name}</p>
                  <p className="mt-1 font-mono text-xs text-ink-muted">
                    {site.keyPrefix}
                    {key.prefix}...
                  </p>
                  <div className="mt-2 flex flex-wrap gap-4 text-xs text-ink-muted">
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
