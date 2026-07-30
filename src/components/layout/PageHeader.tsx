import Link from 'next/link'
import type { ReactNode } from 'react'

export interface PageHeaderProps {
  title: ReactNode
  subtitle?: string
  backHref?: string
  children?: ReactNode
  right?: ReactNode
}

function ArrowLeft({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  )
}

export default function PageHeader({
  title,
  subtitle,
  backHref,
  children,
  right,
}: PageHeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/80 backdrop-blur-md">
      <div className="relative flex items-center gap-4 px-4 h-[53px]">
        {backHref && (
          <Link
            href={backHref}
            className="grid place-items-center w-9 h-9 -ml-1 rounded-full text-ink hover:bg-surface-hover shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
        )}
        {/* Centered title — absolutely positioned so it's visually centered
            regardless of back button or right slot width. */}
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 max-w-[60%] text-center">
          <h1 className="text-base font-bold text-ink truncate leading-tight">
            {title}
          </h1>
          {subtitle && <p className="text-xs text-ink-muted truncate">{subtitle}</p>}
        </div>
        {right && <div className="ml-auto shrink-0">{right}</div>}
      </div>
      {children}
    </header>
  )
}
