import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { t } from '@/lib/i18n'
import { FlaskIcon, HomeIcon, SearchIcon } from '@/components/icons'

/**
 * Standalone layout for auth pages (login, register).
 * Full-screen centered card on desktop. On mobile, a minimal bottom bar
 * keeps the user from being stranded without navigation.
 *
 * Server-side guard: if the user has a GENUINELY valid session (JWT + DB
 * row both present), redirect them to home so they don't see the login
 * form. This is the authoritative check — unlike the proxy's former
 * hasValidJwt() which only checked JWT structure and trapped users whose
 * DB session was deleted (server restart, password change, manual cleanup)
 * but whose cookie was still structurally valid.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (user) redirect('/')

  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-canvas px-4 py-10 md:pb-0">
      {/* Ambient background glow */}
      <div
        className="pointer-events-none absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-brand-tint blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-40 right-0 h-96 w-96 rounded-full bg-info/5 blur-3xl"
        aria-hidden
      />

      {/* Logo */}
      <Link
        href="/"
        className="relative mb-6 flex items-center gap-2 text-brand transition-opacity hover:opacity-80"
      >
        <FlaskIcon className="h-8 w-8" />
        <span className="text-xl font-extrabold tracking-tight text-ink">
          CAS<span className="text-brand">.cool</span>
        </span>
      </Link>

      {/* Content card */}
      <div className="relative w-full max-w-md pb-20 md:pb-0">{children}</div>

      {/* Mobile bottom nav — only public routes (Home, Explore) */}
      <nav className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-around border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-lg md:hidden">
        <Link
          href="/"
          className="flex h-14 w-full items-center justify-center"
          aria-label={t.nav.home}
        >
          <HomeIcon className="h-6 w-6 text-ink-faint" />
        </Link>
        <Link
          href="/explore"
          className="flex h-14 w-full items-center justify-center"
          aria-label={t.nav.explore}
        >
          <SearchIcon className="h-6 w-6 text-ink-faint" />
        </Link>
      </nav>
    </div>
  )
}
