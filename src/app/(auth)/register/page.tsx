'use client'

import { useState, useRef, useEffect, type FormEvent } from 'react'
import { t } from '@/lib/i18n'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/components/Providers'
import { useToast } from '@/components/ui/Toast'
import { sanitizeUsername } from '@/lib/utils'
import { get, post } from '@/lib/api-client'
import type { SafeUser } from '@/lib/types'

type CheckState = 'idle' | 'checking' | 'taken' | 'free'

export default function RegisterPage() {
  const router = useRouter()
  const { login: setAuthUser } = useAuth()
  const { showToast } = useToast()

  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [check, setCheck] = useState<CheckState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track IME composition (Chinese/Japanese/Korean input methods).
  // During composition, the input fires onChange for each keystroke, but
  // the user is still selecting candidate characters — we must NOT sanitize
  // or trigger availability checks until composition ends. Otherwise React's
  // controlled-value writeback hijacks the IME buffer on iOS, causing letters
  // to auto-commit before the user picks a candidate.
  const composingRef = useRef(false)

  // Cleanup debounce timer on unmount to prevent state update on an unmounted component
  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [])

  const checkUsername = (cleaned: string) => {
    if (timer.current) clearTimeout(timer.current)
    if (cleaned.length < 3) {
      setCheck('idle')
      return
    }
    setCheck('checking')
    timer.current = setTimeout(async () => {
      try {
        const result = await get<{ available: boolean }>('/api/auth/check-username?username=' + encodeURIComponent(cleaned))
        if (result.ok && result.data) {
          setCheck(result.data.available ? 'free' : 'taken')
        } else {
          setCheck('idle')
        }
      } catch {
        setCheck('idle')
      }
    }, 350)
  }

  const onUsernameChange = (raw: string) => {
    if (composingRef.current) {
      // IME still composing — pass raw value through without sanitizing
      // so the input method isn't interrupted by React writeback.
      setUsername(raw)
      return
    }
    const cleaned = sanitizeUsername(raw)
    setUsername(cleaned)
    checkUsername(cleaned)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (username.length < 3) return setError(t.auth.errUsernameShort)
    if (check === 'taken') return setError(t.auth.errUsernameTaken)
    if (password.length < 8) return setError(t.auth.errPasswordShort)
    if (password !== confirm) return setError(t.auth.errPasswordMismatch)

    setLoading(true)
    try {
      const result = await post<{ user: SafeUser }>('/api/auth/register', {
        displayName: displayName.trim() || undefined,
        username,
        email: email.trim(),
        password,
      })
      if (!result.ok) throw new Error(result.error || t.auth.errRegisterFailed)
      setAuthUser(result.data!.user)
      showToast(t.auth.accountCreated, 'success', 2500)
      router.push(`/u/${username}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.somethingWrong)
    } finally {
      setLoading(false)
    }
  }

  const usernameHint =
    check === 'checking'
      ? t.auth.checking
      : check === 'taken'
        ? t.auth.usernameTaken
        : check === 'free'
          ? t.auth.usernameAvailable
          : t.auth.usernameHint

  const usernameColor =
    check === 'taken' ? 'text-danger' : check === 'free' ? 'text-brand' : 'text-ink-muted'

  return (
    <div>
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-extrabold text-ink">{t.auth.registerTitle}</h1>
        <p className="mt-1 text-sm text-ink-faint">
          {t.auth.registerSubtitle}
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
          <label className="mb-1 block text-sm font-medium text-ink-muted">
            {t.auth.displayName}
          </label>
          <input
            type="text"
            maxLength={50}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            placeholder={t.auth.displayNamePlaceholder}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-ink-muted">
            {t.auth.username}
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
              @
            </span>
            <input
              type="text"
              required
              maxLength={20}
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={(e) => {
                composingRef.current = false
                // Now that composition is done, sanitize + check
                const cleaned = sanitizeUsername((e.target as HTMLInputElement).value)
                setUsername(cleaned)
                checkUsername(cleaned)
              }}
              className="w-full rounded-lg border border-line-strong bg-canvas py-2.5 pl-8 pr-3 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder={t.auth.usernamePlaceholder}
            />
          </div>
          <p className={`mt-1 text-xs ${usernameColor}`}>{usernameHint}</p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-ink-muted">{t.auth.email}</label>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            placeholder={t.auth.emailPlaceholder}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-ink-muted">{t.auth.password}</label>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            placeholder={t.auth.passwordMin}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-ink-muted">
            {t.auth.confirmPassword}
          </label>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            placeholder={t.auth.confirmPasswordPlaceholder}
          />
        </div>

        <Button type="submit" fullWidth size="lg" loading={loading}>
          {t.auth.createAccountBtn}
        </Button>

        <p className="text-center text-sm text-ink-faint">
          {t.auth.alreadyHaveAccount}{' '}
          <Link href="/login" className="font-semibold text-brand hover:underline">
            {t.auth.signIn}
          </Link>
        </p>
      </form>
    </div>
  )
}
