'use client'

import { cn } from '@/lib/cn'

export interface TabItem {
  id: string
  label: string
  /** Optional count badge (e.g. number of posts). */
  count?: number
}

export interface TabsProps {
  tabs: TabItem[]
  /** Controlled active tab id. */
  value: string
  onChange: (id: string) => void
  className?: string
}

export function Tabs({ tabs, value, onChange, className }: TabsProps) {
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const next = (index + dir + tabs.length) % tabs.length
    onChange(tabs[next].id)
    // Move focus to the newly-selected tab button.
    const container = e.currentTarget.parentElement
    const btns = container?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
    btns?.[next]?.focus()
  }

  return (
    <div
      role="tablist"
      className={cn('flex border-b border-line', className)}
    >
      {tabs.map((tab, index) => {
        const active = tab.id === value
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            type="button"
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              'relative flex-1 flex items-center justify-center gap-2 py-4 text-[15px] font-medium transition-colors',
              'hover:bg-surface-hover',
              active ? 'text-ink' : 'text-ink-faint',
            )}
          >
            <span>{tab.label}</span>
            {typeof tab.count === 'number' && (
              <span
                className={cn(
                  'inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-xs font-semibold',
                  active ? 'bg-brand/20 text-brand-ink' : 'bg-surface-hover text-ink-muted',
                )}
              >
                {tab.count}
              </span>
            )}
            {active && (
              <span className="absolute bottom-0 left-1/2 -translate-x-1/2 h-1 w-12 rounded-full bg-brand" />
            )}
          </button>
        )
      })}
    </div>
  )
}

export default Tabs
