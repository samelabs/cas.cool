'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/cn'
import { XIcon } from '@/components/icons'
import { t as i18n } from '@/lib/i18n'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastItem {
  id: string
  message: string
  type: ToastType
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, durationMs?: number) => void
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // Graceful no-op fallback so components never crash when used
    // outside of the provider (e.g. in isolated tests).
    return {
      showToast: () => {},
      dismiss: () => {},
    }
  }
  return ctx
}

const TYPE_STYLES: Record<ToastType, string> = {
  success: 'border-brand/40 bg-brand-tint text-brand-ink',
  error: 'border-danger/40 bg-danger-tint text-danger',
  info: 'border-line-strong bg-surface-hover/90 text-ink',
}

const TYPE_DOT: Record<ToastType, string> = {
  success: 'bg-brand',
  error: 'bg-danger',
  info: 'bg-info',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const counterRef = useRef(0)

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current[id]
    if (timer) {
      clearTimeout(timer)
      delete timers.current[id]
    }
  }, [])

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', durationMs = 4000) => {
      const id = `toast-${++counterRef.current}`
      setToasts((prev) => [...prev, { id, message, type }])
      if (durationMs > 0) {
        timers.current[id] = setTimeout(() => dismiss(id), durationMs)
      }
    },
    [dismiss],
  )

  useEffect(() => {
    const map = timers.current
    return () => {
      Object.values(map).forEach(clearTimeout)
    }
  }, [])

  return (
    <ToastContext.Provider value={{ showToast, dismiss }}>
      {children}
      {/* Viewport: bottom-center on mobile (above bottom nav), bottom-right on desktop */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 pb-[calc(4rem+env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:pb-4 sm:items-end"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg backdrop-blur',
              'animate-[toast-in_180ms_ease-out]',
              TYPE_STYLES[t.type],
            )}
          >
            <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', TYPE_DOT[t.type])} />
            <p className="flex-1 text-sm leading-snug">{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded p-0.5 text-current/70 hover:text-current"
              aria-label={i18n.common.dismiss}
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export default ToastProvider
