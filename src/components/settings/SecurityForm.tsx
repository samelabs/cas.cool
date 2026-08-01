'use client'

import { useState, type FormEvent } from 'react'
import { t } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { changePassword } from '@/actions/profile'

export function SecurityForm() {
  const { showToast } = useToast()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

  const savePassword = async (e: FormEvent) => {
    e.preventDefault()
    if (newPassword.length < 8) {
      showToast(t.settings.passwordShort, 'error')
      return
    }
    if (newPassword.length > 128) {
      showToast(t.settings.passwordTooLong, 'error')
      return
    }
    setSavingPassword(true)
    try {
      const result = await changePassword(currentPassword, newPassword)
      if (!result.ok) throw new Error(result.error || t.settings.passwordChangeFailed)
      setCurrentPassword('')
      setNewPassword('')
      showToast(t.settings.passwordChanged, 'success', 2000)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.errors.somethingWrong, 'error')
    } finally {
      setSavingPassword(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'
  const labelCls = 'mb-1 block text-sm font-medium text-ink-muted'

  return (
    <div className="px-4 py-4">
      <form onSubmit={savePassword} className="max-w-md space-y-4">
        <div>
          <label className={labelCls}>{t.settings.currentPassword}</label>
          <input
            type="password"
            className={inputCls}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div>
          <label className={labelCls}>{t.settings.newPassword}</label>
          <input
            type="password"
            className={inputCls}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={savingPassword} disabled={!currentPassword || !newPassword}>
            {t.settings.changePassword}
          </Button>
        </div>
      </form>
    </div>
  )
}
