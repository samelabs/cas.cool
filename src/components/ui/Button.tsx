import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  isLoading?: boolean
  fullWidth?: boolean
  href?: string
  children: ReactNode
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-strong active:bg-brand-ink',
  secondary: 'bg-surface border border-line-strong text-ink hover:bg-surface-hover',
  outline: 'bg-surface border border-brand text-brand hover:bg-brand-tint',
  ghost: 'text-ink hover:bg-surface-hover',
  danger: 'bg-danger text-white hover:bg-danger-strong',
}

const SIZES: Record<Size, string> = {
  sm: 'h-9 px-4 text-sm',
  md: 'h-11 px-5 text-[15px]',
  lg: 'h-12 px-6 text-base',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    isLoading,
    fullWidth = false,
    href,
    disabled,
    className,
    children,
    type,
    ...rest
  },
  ref,
) {
  const busy = loading || isLoading
  const classes = cn(
    'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors select-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
    'disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
    VARIANTS[variant],
    SIZES[size],
    fullWidth && 'w-full',
    className,
  )

  const content = (
    <>
      {busy && <Spinner />}
      {children}
    </>
  )

  if (href) {
    if (disabled) {
      return (
        <span className={cn(classes, 'opacity-50 pointer-events-none')} aria-disabled>
          {content}
        </span>
      )
    }
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    )
  }

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || busy}
      {...rest}
    >
      {content}
    </button>
  )
})

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  )
}

export default Button
