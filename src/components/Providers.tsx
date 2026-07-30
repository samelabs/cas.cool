'use client'

import { createContext, useContext, useCallback, useMemo, useState, type ReactNode } from 'react'
import { t } from '@/lib/i18n'
import { useRouter } from 'next/navigation'
import type { SafeUser } from '@/lib/types'
import { ToastProvider, useToast } from '@/components/ui/Toast'
import { ReportProvider } from '@/components/ReportDialog'
import { logout as logoutAction } from '@/actions/auth'

interface AuthContextValue {
  currentUser: SafeUser | null
  loading: boolean
  login: (user: SafeUser) => void
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** Current signed-in user (server-fetched, passed down via <Providers>). */
export function useCurrentUser(): SafeUser | null {
  return useContext(AuthContext)?.currentUser ?? null
}

/** Richer auth hook for interactive components. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    return {
      currentUser: null,
      loading: false,
      login: () => {},
      logout: async () => {},
    }
  }
  return ctx
}

/**
 * Inner provider sits inside ToastProvider so it can use useToast.
 */
function AuthProvider({
  currentUser: initialUser,
  children,
}: {
  currentUser: SafeUser | null
  children: ReactNode
}) {
  const router = useRouter()
  const { showToast } = useToast()
  const [currentUser, setCurrentUser] = useState<SafeUser | null>(initialUser)

  const login = useCallback((user: SafeUser) => {
    setCurrentUser(user)
  }, [])

  const logout = useCallback(async () => {
    await logoutAction().catch(() => {})
    setCurrentUser(null)
    showToast(t.auth.signedOut, 'info', 2000)
    router.push('/login')
    router.refresh()
  }, [router, showToast])

  const value = useMemo<AuthContextValue>(
    () => ({ currentUser, loading: false, login, logout }),
    [currentUser, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export interface ProvidersProps {
  currentUser: SafeUser | null
  children: ReactNode
}

export default function Providers({ currentUser, children }: ProvidersProps) {
  return (
    <ToastProvider>
      <ReportProvider>
        <AuthProvider currentUser={currentUser}>{children}</AuthProvider>
      </ReportProvider>
    </ToastProvider>
  )
}
