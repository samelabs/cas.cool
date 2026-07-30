'use client'

import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { t } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { useToast } from '@/components/ui/Toast'
import { VerifiedBadge } from '@/components/icons'
import { canUploadMedia } from '@/lib/permissions'
import { uploadImage as uploadImageAction, updateProfile } from '@/actions/profile'
import { compressImage } from '@/lib/client-image'
import type { SafeUser } from '@/lib/types'

export function ProfileForm({ currentUser }: { currentUser: SafeUser }) {
  const router = useRouter()
  const { showToast } = useToast()

  const [displayName, setDisplayName] = useState(currentUser.displayName ?? '')
  const [bio, setBio] = useState(currentUser.bio ?? '')
  const [avatar, setAvatar] = useState(currentUser.avatar ?? '')
  const [banner, setBanner] = useState(currentUser.banner ?? '')
  const [location, setLocation] = useState(currentUser.location ?? '')
  const [website, setWebsite] = useState(currentUser.website ?? '')
  const [savingProfile, setSavingProfile] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [uploadingBanner, setUploadingBanner] = useState(false)

  // Banner preview modal state: a pending file awaits user confirmation
  // before it is actually uploaded. `pendingBannerPreview` is an object URL.
  const [pendingBannerPreview, setPendingBannerPreview] = useState<string | null>(null)
  const [bannerModalMounted, setBannerModalMounted] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)

  const isVerified = canUploadMedia(currentUser)

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault()
    setSavingProfile(true)
    try {
      const result = await updateProfile({
        displayName: displayName.trim() || null,
        bio: bio.trim() || null,
        avatar: avatar.trim() || null,
        banner: banner.trim() || null,
        location: location.trim() || null,
        website: website.trim() || null,
      })
      if (!result.ok) throw new Error(result.error || t.settings.profileSaveFailed)
      showToast(t.settings.profileUpdated, 'success', 2000)
      router.refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.errors.somethingWrong, 'error')
    } finally {
      setSavingProfile(false)
    }
  }

  const uploadFile = async (file: File, purpose: 'avatar' | 'banner'): Promise<string | null> => {
    try {
      const compressed = await compressImage(file)
      if (!compressed) return null
      const blob = compressed.blob
      const ext = blob.type === 'image/gif' ? 'gif' : blob.type === 'image/png' ? 'png' : 'webp'
      const compressedFile = new File([blob], `upload.${ext}`, { type: blob.type })
      const result = await uploadImageAction(compressedFile, purpose)
      if (!result.ok) return null
      return result.data.url
    } catch {
      return null
    }
  }

  const patchUser = async (patch: Record<string, string | null>) => {
    const result = await updateProfile(patch)
    if (!result.ok) throw new Error(result.error || t.errors.somethingWrong)
  }

  // ── Banner preview modal lifecycle ──
  // When a file is chosen, create an object URL and open the modal.
  const openBannerPreview = useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    setPendingBannerPreview(url)
    setBannerModalMounted(true)
  }, [])

  // Confirm: upload the canvas-cropped Blob. The modal stays open during
  // upload (spinner on the ✓ button), then closes on success.
  const confirmBannerUpload = useCallback(async (croppedBlob: Blob) => {
    if (!pendingBannerPreview) return
    setUploadingBanner(true)
    try {
      // Use the blob's actual MIME type — Safari may ignore a requested
      // 'image/webp' and output PNG, so we must not hard-code webp or the
      // server's magic-byte cross-check will reject the file.
      const mime = croppedBlob.type || 'image/png'
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
      const file = new File([croppedBlob], `banner.${ext}`, { type: mime })
      const url = await uploadFile(file, 'banner')
      if (!url) throw new Error()
      setBanner(url)
      await patchUser({ banner: url })
      showToast(t.settings.bannerUpdated, 'success', 2000)
      // Close after success.
      URL.revokeObjectURL(pendingBannerPreview)
      setPendingBannerPreview(null)
      setBannerModalMounted(false)
    } catch {
      showToast(t.settings.bannerUploadFailed, 'error')
    } finally {
      setUploadingBanner(false)
      if (bannerInputRef.current) bannerInputRef.current.value = ''
    }
  }, [pendingBannerPreview, showToast])

  // Cancel: discard the pending file, close modal, revoke object URL.
  const cancelBannerPreview = useCallback(() => {
    if (pendingBannerPreview) URL.revokeObjectURL(pendingBannerPreview)
    setPendingBannerPreview(null)
    setBannerModalMounted(false)
    if (bannerInputRef.current) bannerInputRef.current.value = ''
  }, [pendingBannerPreview])

  // Cleanup any leaked object URL on unmount.
  useEffect(() => {
    return () => {
      if (pendingBannerPreview) URL.revokeObjectURL(pendingBannerPreview)
    }
  }, [pendingBannerPreview, showToast])

  const inputCls =
    'w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'
  const labelCls = 'mb-1 block text-sm font-medium text-ink-muted'

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      {/* Banner upload — verified only.
          Clicking opens a file picker; selecting a file opens a preview
          modal (with the exact h-48 + object-cover crop the profile page
          uses) for the user to confirm before any upload happens. */}
      <div className="mb-4">
        {isVerified ? (
          <>
            <div
              className="group relative h-48 w-full cursor-pointer overflow-hidden rounded-xl bg-surface-hover ring-1 ring-line"
              onClick={() => !uploadingBanner && bannerInputRef.current?.click()}
            >
              {banner ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={banner} alt={t.settings.banner} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-ink-faint">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  <span className="text-xs">{t.settings.clickToUploadBanner}</span>
                </div>
              )}
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                {uploadingBanner ? (
                  <span className="text-xs font-semibold text-white">{t.common.uploading}</span>
                ) : (
                  <span className="text-xs font-semibold text-white">{t.settings.changeBanner}</span>
                )}
              </div>
            </div>
            <input
              ref={bannerInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                // Open the preview modal — do NOT upload yet.
                openBannerPreview(file)
              }}
            />
            {banner && (
              <button
                type="button"
                onClick={() => {
                  setBanner('')
                  patchUser({ banner: null }).then(
                    () => showToast(t.settings.bannerRemoved, 'info', 2000),
                    () => showToast(t.settings.bannerRemoveFailed, 'error'),
                  )
                }}
                className="pill pill-danger mt-2"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3">
                  <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t.settings.removeBanner}
              </button>
            )}
          </>
        ) : (
          <div className="flex items-center justify-between rounded-xl border border-line bg-canvas px-4 py-3">
            <div className="text-sm text-ink-muted">
              {t.settings.bannerVerificationRequired}
            </div>
            <Link href="/verify" className="text-sm font-semibold text-brand hover:underline">
              {t.settings.getVerified}
            </Link>
          </div>
        )}
      </div>

      <form onSubmit={saveProfile} className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="relative group">
            <Avatar
              src={avatar || currentUser.avatar}
              name={displayName || currentUser.username}
              username={currentUser.username}
              size="lg"
            />
            {isVerified && (
              <>
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-xs font-semibold text-white transition-opacity hover:opacity-100 opacity-0 group-hover:opacity-100 disabled:opacity-50"
                  aria-label={t.settings.uploadAvatar}
                />
                {!uploadingAvatar && (
                  <span className="pointer-events-none absolute bottom-0 right-0 flex h-6 w-6 items-center justify-center rounded-full bg-brand text-white ring-2 ring-surface">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                  </span>
                )}
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setUploadingAvatar(true)
                    try {
                      const url = await uploadFile(file, 'avatar')
                      if (!url) throw new Error()
                      setAvatar(url)
                      await patchUser({ avatar: url })
                      showToast(t.settings.avatarUpdated, 'success', 2000)
                    } catch {
                      showToast(t.settings.avatarUploadFailed, 'error')
                    } finally {
                      setUploadingAvatar(false)
                      if (avatarInputRef.current) avatarInputRef.current.value = ''
                    }
                  }}
                />
              </>
            )}
          </div>
          <div className="text-sm text-ink-muted">
            <p className="flex items-center gap-1.5 font-semibold text-ink">
              @{currentUser.username}
              {currentUser.verificationStatus === 'verified' && (
                <VerifiedBadge className="h-4 w-4 text-brand" />
              )}
            </p>
            {isVerified ? (
              <p>{t.settings.avatarHint}</p>
            ) : (
              <Link href="/verify" className="text-brand hover:underline">
                {t.settings.avatarVerifyHint} →
              </Link>
            )}
          </div>
        </div>

        <div>
          <label className={labelCls}>{t.settings.displayName}</label>
          <input className={inputCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={50} />
        </div>
        <div>
          <label className={labelCls}>{t.settings.bio}</label>
          <textarea className={inputCls} rows={3} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={280} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>{t.settings.location}</label>
            <input className={inputCls} value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t.settings.locationPlaceholder} />
          </div>
          <div>
            <label className={labelCls}>{t.settings.website}</label>
            <input className={inputCls} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={t.settings.websitePlaceholder} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={savingProfile}>{t.settings.saveProfile}</Button>
        </div>
      </form>

      {/* Banner crop modal */}
      {bannerModalMounted && pendingBannerPreview && typeof document !== 'undefined' && createPortal(
        <BannerPreviewModal
          previewUrl={pendingBannerPreview}
          uploading={uploadingBanner}
          onConfirm={confirmBannerUpload}
          onCancel={cancelBannerPreview}
          onCloseComplete={() => setBannerModalMounted(false)}
        />,
        document.body,
      )}
    </div>
  )
}

const BANNER_ASPECT = 3 // width : height

function BannerPreviewModal({
  previewUrl,
  uploading,
  onConfirm,
  onCancel,
  onCloseComplete,
}: {
  previewUrl: string
  uploading: boolean
  onConfirm: (croppedBlob: Blob) => void
  onCancel: () => void
  onCloseComplete: () => void
}) {
  const imgRef = useRef<HTMLImageElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  // posY: vertical crop position 0-100%, maps to CSS object-position-y.
  const [posY, setPosY] = useState(50)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<{ y: number; pos: number; frameH: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (uploading || !frameRef.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { y: e.clientY, pos: posY, frameH: frameRef.current.clientHeight }
    setIsDragging(true)
  }, [posY, uploading])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    // Convert pixel delta to percentage of frame height.
    const deltaPct = ((e.clientY - dragRef.current.y) / dragRef.current.frameH) * 100
    setPosY(Math.min(100, Math.max(0, dragRef.current.pos + deltaPct)))
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      dragRef.current = null
      setIsDragging(false)
    }
  }, [])

  // Bake the visible crop to a canvas Blob. Reads natural dims from the DOM
  // node at apply time — no state dependency.
  const handleApply = useCallback(() => {
    if (uploading || !imgRef.current || !frameRef.current) return
    const img = imgRef.current
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    if (!nw || !nh) return
    const fw = frameRef.current.clientWidth
    const fh = frameRef.current.clientHeight

    const scale = Math.max(fw / nw, fh / nh)
    const dispW = nw * scale
    const dispH = nh * scale
    const visTopPx = ((dispH - fh) * posY) / 100
    const srcX = ((dispW - fw) / 2) / scale
    const srcY = visTopPx / scale
    const srcW = fw / scale
    const srcH = fh / scale

    // Output at the SOURCE crop resolution, capped at 1500px wide (banner
    // preset). Using the display width (fw) here would downscale a 3000px
    // photo to ~672px and look blurry when displayed full-width.
    const outScale = Math.min(1, 1500 / srcW)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(srcW * outScale)
    canvas.height = Math.round(srcH * outScale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => { if (blob) onConfirm(blob) }, 'image/jpeg', 0.92)
  }, [uploading, posY, onConfirm])

  // Close affordances.
  const [leaving, setLeaving] = useState(false)
  const handleClose = useCallback(() => {
    setLeaving(true)
    setTimeout(onCloseComplete, 200)
  }, [onCloseComplete])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !uploading) { handleClose(); onCancel() } }
    document.addEventListener('keydown', onEsc)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onEsc); document.body.style.overflow = prev }
  }, [uploading, handleClose, onCancel])

  return (
    <div className={`fixed inset-0 z-[100] flex flex-col bg-black transition-opacity duration-200 ${leaving ? 'opacity-0' : 'opacity-100'}`}>
      {/* Top bar — icon-only: ✕ cancel / ✓ apply. No text labels. */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <button
          type="button"
          onClick={() => { handleClose(); onCancel() }}
          disabled={uploading}
          className="grid h-9 w-9 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
          aria-label={t.common.cancel}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={uploading}
          className="grid h-9 w-9 place-items-center rounded-full bg-white text-black transition-colors hover:bg-white/90 disabled:opacity-40"
          aria-label={t.settings.bannerConfirmUpload}
        >
          {uploading ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="h-5 w-5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          )}
        </button>
      </div>

      {/* Crop frame — drag up/down to reposition. Cursor signals drag affordance. */}
      <div className="flex flex-1 items-center justify-center px-4 pb-4">
        <div
          ref={frameRef}
          className={`relative w-full max-w-2xl overflow-hidden bg-neutral-900 select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'} touch-none`}
          style={{ aspectRatio: BANNER_ASPECT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={previewUrl}
            alt=""
            draggable={false}
            onLoad={() => setImgLoaded(true)}
            className="h-full w-full object-cover"
            style={{ objectPosition: `center ${posY}%` }}
          />

          {/* Loading spinner — no text */}
          {!imgLoaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
            </div>
          )}

          {/* Upload overlay — spinner only, no text */}
          {uploading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
