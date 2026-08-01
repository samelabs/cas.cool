'use client'

import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/Providers'
import { useToast } from '@/components/ui/Toast'
import { useReport } from '@/components/ReportDialog'
import { cn } from '@/lib/cn'
import { postUrl } from '@/lib/shortCode'
import type { SafePost } from '@/lib/types'
import { t } from '@/lib/i18n'
import { del } from '@/lib/api-client'

/**
 * Post ellipsis menu — shown at the top-right of each PostCard.
 *
 * Items (top to bottom):
 *   - Edit     (author, within 60 min)
 *   - Delete   (author, admin)
 *   - Copy link (everyone)
 *   - Report   (non-author)
 *
 * Uses a lightweight popover + outside-click dismiss. The popover reuses
 * the same visual style as the PostActions popover.
 */
export function PostMenu({
  post,
  onDeleted,
}: {
  post: SafePost
  onDeleted?: (postId: string) => void
}) {
  const { currentUser } = useAuth()
  const { showToast } = useToast()
  const { openReport } = useReport()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const isAdmin = currentUser?.role === 'admin'
  const isAuthor = currentUser?.id === post.authorId

  // Client-only canEdit — Date.now() is only available on the client.
  // useSyncExternalStore with empty subscribe = compute once on client, never on server.
  const canEdit = useSyncExternalStore(
    () => () => {},
    () => isAuthor && Date.now() - new Date(post.createdAt).getTime() < 60 * 60 * 1000,
    () => false, // server snapshot — always false (no edit button during SSR)
  )

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onEsc)

    // Elevate stacking context so the dropdown paints above sibling cards.
    const article = ref.current?.closest('article')
    if (article) {
      ;(article as HTMLElement).style.zIndex = '50'
      ;(article as HTMLElement).style.position = 'relative'
    }

    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onEsc)
      if (article) {
        ;(article as HTMLElement).style.zIndex = ''
        ;(article as HTMLElement).style.position = ''
      }
    }
  }, [open])

  const copyLink = useCallback(() => {
    const url = `${window.location.origin}${postUrl(post)}`
    navigator.clipboard.writeText(url).then(
      () => { showToast(t.postMenu.linkCopied, 'success', 2000); setOpen(false) },
      () => { showToast(t.postMenu.copyFailed, 'error'); setOpen(false) },
    )
  }, [post, showToast])

  const deletePost = useCallback(async () => {
    setDeleting(true)
    try {
      const result = await del('/api/posts/' + post.shortCode)
      if (!result.ok) throw new Error(result.error ?? undefined)
      showToast(t.postMenu.postDeleted, 'success', 2000)
      onDeleted?.(post.id)
      setOpen(false)
      setConfirmingDelete(false)
    } catch {
      showToast(t.postMenu.failedToDelete, 'error')
    } finally {
      setDeleting(false)
    }
  }, [post.shortCode, post.id, onDeleted, showToast])

  const requestDelete = useCallback(() => {
    setConfirmingDelete(true)
  }, [])

  const report = useCallback(() => {
    setOpen(false)
    const snippet = post.content.slice(0, 60) || t.postMenu.postBy(post.author.username)
    openReport({ type: 'POST', targetId: post.id, label: snippet })
  }, [openReport, post])

  const edit = useCallback(() => {
    setOpen(false)
    router.push(`/compose?edit=${post.id}`)
  }, [router, post.id])

  // No items to show (not logged in — show nothing; can still copy link)
  const showEdit = canEdit
  const showDelete = isAuthor || isAdmin
  const showReport = currentUser && !isAuthor
  const showCopy = true

  if (!showEdit && !showDelete && !showReport && !showCopy) return null

  return (
    <div ref={ref} className="relative z-20 shrink-0">
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v) }}
        className="grid h-9 w-9 place-items-center rounded-full text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
        aria-label={t.common.moreOptions}
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 min-w-[200px] overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-xl shadow-black/10 animate-[popoverIn_120ms_ease-out]">
          {confirmingDelete ? (
            <div className="px-4 py-3">
              <p className="text-sm font-semibold text-ink">{t.postMenu.deleteConfirm}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{t.postMenu.deleteWarning}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmingDelete(false) }}
                  className="flex-1 rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-hover"
                >
                  {t.common.cancel}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); deletePost() }}
                  disabled={deleting}
                  className="flex-1 rounded-lg bg-danger px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-danger-strong disabled:opacity-50"
                >
                  {deleting ? t.common.deleting : t.common.delete}
                </button>
              </div>
            </div>
          ) : (
            <>
              {showEdit && <Item icon={<EditIcon/>} label={t.postMenu.editPost} onClick={edit} />}
              {showDelete && <Item icon={<TrashIcon/>} label={t.postMenu.deletePost} variant="danger" onClick={requestDelete} />}
              {showCopy && <Item icon={<LinkIcon/>} label={t.postMenu.copyLink} onClick={copyLink} />}
              {showReport && <Item icon={<FlagIcon/>} label={t.postMenu.reportPost} variant="danger" onClick={report} />}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Item({
  icon, label, onClick, variant = 'default',
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  variant?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick() }}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-2.5 text-sm font-medium transition-colors active:bg-surface-hover',
        variant === 'danger' ? 'text-danger hover:bg-danger-tint' : 'text-ink hover:bg-surface-hover',
      )}
    >
      <span className={cn('shrink-0', variant === 'danger' ? 'text-danger' : 'text-ink-muted')}>{icon}</span>
      {label}
    </button>
  )
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="4" y1="22" x2="4" y2="15" strokeLinecap="round" />
    </svg>
  )
}
export default PostMenu
