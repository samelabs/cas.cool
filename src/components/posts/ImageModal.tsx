'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { XIcon, ChevronLeftIcon, ChevronRightIcon } from '@/components/icons'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'

export interface ImageModalProps {
  /** List of image URLs to view. */
  images: string[]
  /** Index in `images` to show first. */
  startIndex?: number
  /** Called when the user dismisses the modal (backdrop, X, Escape). */
  onClose: () => void
}

const Z = 9999

/**
 * Full-screen image viewer / lightbox.
 *
 * - Renders into document.body via a portal so it is immune to the app's
 *   stacking-context / layering issues.
 * - Keyboard: Esc closes, ←/→ navigate.
 * - Touch: swipe left/right to navigate on mobile.
 * - Body scroll is locked while open.
 */
export function ImageModal({ images, startIndex = 0, onClose }: ImageModalProps) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(startIndex, 0), Math.max(images.length - 1, 0)),
  )
  const touchStartX = useRef<number | null>(null)

  const count = images.length
  const hasPrev = index > 0
  const hasNext = index < count - 1

  const goPrev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1))
  }, [])
  const goNext = useCallback(() => {
    setIndex((i) => Math.min(count - 1, i + 1))
  }, [count])

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goPrev, goNext])

  // Lock body scroll while the modal is mounted; restore on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  if (typeof document === 'undefined') return null

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return
    const delta = e.changedTouches[0]?.clientX - touchStartX.current
    if (delta <= -50) goNext()
    else if (delta >= 50) goPrev()
    touchStartX.current = null
  }

  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.common.imageViewer}
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="fixed inset-0 flex items-center justify-center bg-black/90 p-4 animate-in fade-in"
      style={{ zIndex: Z }}
    >
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        aria-label={t.common.close}
        className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white/40"
        style={{ zIndex: Z + 1 }}
      >
        <XIcon className="h-6 w-6" />
      </button>

      {/* Prev arrow */}
      {count > 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            goPrev()
          }}
          disabled={!hasPrev}
          aria-label={t.common.previous}
          className={cn(
            'absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white/40 sm:left-5',
            !hasPrev && 'cursor-default opacity-30 hover:bg-white/10',
          )}
          style={{ zIndex: Z + 1 }}
        >
          <ChevronLeftIcon className="h-7 w-7" />
        </button>
      )}

      {/* Next arrow */}
      {count > 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            goNext()
          }}
          disabled={!hasNext}
          aria-label={t.common.next}
          className={cn(
            'absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white/40 sm:right-5',
            !hasNext && 'cursor-default opacity-30 hover:bg-white/10',
          )}
          style={{ zIndex: Z + 1 }}
        >
          <ChevronRightIcon className="h-7 w-7" />
        </button>
      )}

      {/* The image itself — click does NOT close (stopPropagation). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={images[index]}
        src={images[index]}
        alt={`Image ${index + 1} of ${count}`}
        onClick={stop}
        className="max-h-[100dvh] max-w-[100vw] select-none object-contain [touch-action:pan-y]"
        draggable={false}
      />

      {/* Counter */}
      {count > 1 && (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-sm font-medium text-white tabular-nums"
          style={{ zIndex: Z + 1 }}
        >
          {index + 1} / {count}
        </div>
      )}
    </div>,
    document.body,
  )
}

export default ImageModal
