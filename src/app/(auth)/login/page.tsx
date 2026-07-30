'use client'

import { useState, type FormEvent } from 'react'
import { t } from '@/lib/i18n'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/components/Providers'
import { useToast } from '@/components/ui/Toast'
import { login } from '@/actions/auth'

export default function LoginPage() {
  const router = useRouter()
  const { login: setAuthUser } = useAuth()
  const { showToast } = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await login(email.trim(), password)
      if (!result.ok) throw new Error(result.error || t.auth.invalidCredentials)
      setAuthUser(result.data.user)
      showToast(t.auth.welcomeBack, 'success', 2000)
      router.push('/')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.somethingWrong)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-extrabold text-ink">{t.auth.loginTitle}</h1>
        <p className="mt-1 text-sm text-ink-faint">
          {t.auth.loginSubtitle}
        </p>
      </div>

      <form
        onSubmit={submit}
        className="space-y-4 rounded-2xl border border-line bg-canvas/80 p-6 backdrop-blur"
      >
        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-ink-muted">{t.auth.emailOrUsername}</label>
          <input
            type="text"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            placeholder={t.auth.emailOrUsernamePlaceholder}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-ink-muted">{t.auth.password}</label>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            placeholder={t.auth.passwordPlaceholder}
          />
        </div>

        <Button type="submit" fullWidth size="lg" loading={loading}>
          {t.auth.signIn}
        </Button>

        <p className="text-center text-sm text-ink-faint">
          {t.auth.newToCascool}{' '}
          <Link href="/register" className="font-semibold text-brand hover:underline">
            {t.auth.createAccount}
          </Link>
        </p>
      </form>
    </div>
  )
}
