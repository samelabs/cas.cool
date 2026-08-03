'use client'

import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useToast } from '@/components/ui/Toast'
import { postUrl } from '@/lib/shortCode'
import type { SafePost } from '@/lib/types'
import { t } from '@/lib/i18n'

/**
 * Share button with social platform modal.
 *
 * Renders a share icon that opens a centered overlay with direct links to
 * major social platforms + native Web Share API + copy link.
 *
 * Uses a fixed-position centered overlay (not an absolute dropdown) so the
 * panel is always fully visible regardless of where the trigger button sits
 * in the layout — critical because this button is the rightmost item in the
 * PostActions bar, near the viewport edge on mobile.
 */

import { SITE_URL } from '@/lib/site'

interface ShareTarget {
  key: string
  label: string
  icon: React.ReactNode
  href: (url: string, text: string) => string
}

/** WeChat target (special: opens QR code view instead of a link).
 *  Declared after icons below. */

// ── Icons ──

const ShareIcon = ({ className = 'h-4 w-4' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
    <polyline points="16 6 12 2 8 6" />
    <line x1="12" y1="2" x2="12" y2="15" />
  </svg>
)

const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
)

const FacebookIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
  </svg>
)

const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
    <path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.945C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z" />
  </svg>
)

const TelegramIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
    <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
)

const LinkedInIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
)

const WeiboIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
    <path d="M10.098 20.323c-3.977.391-7.414-1.406-7.672-4.02-.259-2.609 2.759-5.047 6.74-5.441 3.979-.394 7.413 1.404 7.671 4.018.259 2.6-2.759 5.049-6.737 5.439v.004h-.002zM9.05 17.219c-.384.616-1.208.884-1.829.602-.612-.279-.793-.991-.406-1.593.379-.595 1.176-.861 1.793-.601.624.267.82.973.442 1.592zm1.27-1.627c-.141.237-.449.353-.689.253-.236-.09-.313-.361-.177-.586.138-.227.436-.346.672-.24.239.09.315.36.18.601l.014-.028zm.176-2.719c-1.893-.493-4.033.45-4.857 2.118-.836 1.704-.026 3.591 1.886 4.21 1.983.64 4.318-.341 5.132-2.179.8-1.793-.201-3.642-2.161-4.149zm7.563-1.224c-.346-.105-.57-.18-.405-.615.375-.977.42-1.804.014-2.404-.773-1.139-2.889-1.079-5.335-.014 0-.004-.762.331-.566-.27.372-1.197.315-2.202-.27-2.776-1.338-1.301-4.895.06-8.013 3.04C1.026 11.684 0 14.237 0 16.435c0 4.214 5.348 6.766 10.576 6.766 6.855 0 11.424-4.014 11.424-7.181 0-1.921-1.631-3.013-3.066-3.453l-.014-.014.014.005zm1.852-5.094c.038.038.058.086.072.134.024.067.043.142.043.226 0 .27-.165.575-.42.81-.195.181-.435.301-.667.301-.195 0-.359-.075-.47-.21-.12-.135-.166-.301-.12-.47.045-.21.195-.39.375-.526-.015 0-.015-.014-.015-.014-.195-.166-.285-.436-.21-.676.075-.24.27-.405.51-.405.09 0 .18.03.246.075l.014.014c.18.165.48.165.66-.029.18-.196.18-.48-.014-.66-.33-.301-.766-.481-1.216-.481-.93 0-1.686.756-1.686 1.686 0 .314.09.614.24.866-.42.345-.705.846-.705 1.41 0 .989.81 1.798 1.799 1.798.525 0 .99-.224 1.32-.585.435.345.99.555 1.596.555 1.395 0 2.521-1.125 2.521-2.521 0-.93-.495-1.739-1.245-2.184l-.015-.014c-.15-.09-.314-.135-.48-.135-.42 0-.786.276-.93.66-.135.39-.045.81.255 1.095l.014.014z" />
  </svg>
)

const LinkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
  </svg>
)

const SHARE_TARGETS: ShareTarget[] = [
  {
    key: 'x',
    label: 'X',
    icon: <XIcon />,
    href: (url, text) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
  },
  {
    key: 'facebook',
    label: 'Facebook',
    icon: <FacebookIcon />,
    href: (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  },
  {
    key: 'whatsapp',
    label: 'WhatsApp',
    icon: <WhatsAppIcon />,
    href: (url, text) => `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`,
  },
  {
    key: 'telegram',
    label: 'Telegram',
    icon: <TelegramIcon />,
    href: (url, text) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    icon: <LinkedInIcon />,
    href: (url) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  },
  {
    key: 'weibo',
    label: '微博',
    icon: <WeiboIcon />,
    href: (url, text) => `https://service.weibo.com/share/share.php?url=${encodeURIComponent(url)}&title=${encodeURIComponent(text)}`,
  },
]

// ── Main component ──

export function ShareButton({
  post,
  variant = 'icon',
}: {
  post: SafePost
  variant?: 'icon' | 'action'
}) {
  const { showToast } = useToast()
  const [open, setOpen] = useState(false)

  const fullUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${postUrl(post)}`
    : `${SITE_URL}${postUrl(post)}`
  const shareText = post.content
    ? post.content.slice(0, 80)
    : t.seo.postByAuthor(post.author.displayName || post.author.username)

  const handlePlatformShare = useCallback((target: ShareTarget) => {
    window.open(target.href(fullUrl, shareText), '_blank', 'noopener,noreferrer,width=600,height=500')
    setOpen(false)
  }, [fullUrl, shareText])

  const handleNativeShare = useCallback(async () => {
    setOpen(false)
    try {
      if (navigator.share) {
        await navigator.share({ title: t.brand.name, text: shareText, url: fullUrl })
      } else {
        await navigator.clipboard.writeText(fullUrl)
        showToast(t.postMenu.linkCopied, 'success', 2000)
      }
    } catch { /* user cancelled */ }
  }, [fullUrl, shareText, showToast])

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(fullUrl).then(
      () => { showToast(t.postMenu.linkCopied, 'success', 2000); setOpen(false) },
      () => { showToast(t.postMenu.copyFailed, 'error'); setOpen(false) },
    )
  }, [fullUrl, showToast])

  const trigger = variant === 'icon' ? (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
      className="group flex items-center gap-1"
      aria-label={t.postMenu.share}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full transition-colors group-hover:bg-brand-tint group-hover:text-brand">
        <ShareIcon className="h-[18px] w-[18px] text-ink-faint group-hover:text-brand" />
      </span>
    </button>
  ) : (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
      className="flex flex-1 min-w-0 items-center justify-center gap-1 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-brand"
      aria-label={t.postMenu.share}
    >
      <ShareIcon className="h-[18px] w-[18px]" />
      <span className="hidden sm:inline">{t.postMenu.share}</span>
    </button>
  )

  return (
    <>
      {trigger}
      {open && typeof document !== 'undefined' && createPortal(
        <ShareOverlay
          targets={SHARE_TARGETS}
          fullUrl={fullUrl}
          onClose={() => setOpen(false)}
          onShare={handlePlatformShare}
          onNativeShare={handleNativeShare}
          onCopyLink={handleCopyLink}
        />,
        document.body,
      )}
    </>
  )
}

// ── Fixed centered overlay ──

function ShareOverlay({
  targets,
  onClose,
  onShare,
  onNativeShare,
  onCopyLink,
}: {
  targets: ShareTarget[]
  fullUrl: string
  onClose: () => void
  onShare: (t: ShareTarget) => void
  onNativeShare: () => void
  onCopyLink: () => void
}) {
  const showNativeShare = typeof navigator !== 'undefined' && !!navigator.share

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEsc)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onEsc)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-[360px] animate-[sharePanelIn_200ms_ease-out] overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-bold text-ink">{t.postMenu.share}</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-full text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
            aria-label={t.common.close}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Social platforms grid */}
        <div className="grid grid-cols-3 gap-1 p-3">
          {targets.map((target) => (
            <button
              key={target.key}
              type="button"
              onClick={() => onShare(target)}
              className="flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-surface-hover active:bg-surface-hover"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-hover text-ink-muted">
                {target.icon}
              </span>
              <span className="text-xs font-medium text-ink-muted">{target.label}</span>
            </button>
          ))}
        </div>

        <div className="mx-3 border-t border-line" />

        {/* Native share + copy link */}
        <div className="p-1.5">
          {showNativeShare && (
            <button
              type="button"
              onClick={onNativeShare}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-hover"
            >
              <span className="shrink-0 text-ink-muted"><ShareIcon className="h-4 w-4" /></span>
              {t.postMenu.share}
            </button>
          )}
          <button
            type="button"
            onClick={onCopyLink}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            <span className="shrink-0 text-ink-muted"><LinkIcon /></span>
            {t.postMenu.copyLink}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ShareButton
