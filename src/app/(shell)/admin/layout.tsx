import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import Link from 'next/link'
import AdminTabs from './AdminTabs'
import { t } from '@/lib/i18n'

function ArrowLeft() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
    </svg>
  )
}

/**
 * Server-side guard: only admin role can access /admin/*.
 * No second login — the existing session JWT is sufficient.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.role !== 'admin') redirect('/')

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/80 backdrop-blur-md">
        <div className="relative flex h-[53px] items-center gap-4 px-4">
          <Link href="/" className="grid h-9 w-9 place-items-center rounded-full hover:bg-surface-hover">
            <ArrowLeft />
          </Link>
          <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 max-w-[60%] text-center">
            <h1 className="text-base font-bold text-ink truncate leading-tight">{t.admin.panelTitle}</h1>
          </div>
        </div>
        <AdminTabs />
      </header>
      {children}
    </>
  )
}
