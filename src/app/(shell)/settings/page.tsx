import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import { SettingsHub } from '@/components/settings/SettingsHub'
import { t } from '@/lib/i18n'
import { getUserById, getUserCounts } from '@/lib/services/user.service'
import type { SafeUser } from '@/lib/types'

export const metadata: Metadata = { title: t.settings.title }

export default async function SettingsPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/login')

  const [user, counts] = await Promise.all([
    getUserById(me.id),
    getUserCounts(me.id),
  ])
  if (!user) redirect('/login')

  const safeUser = { ...user, _count: counts } as SafeUser

  return (
    <>
      <PageHeader title={t.settings.title} backHref="/" />
      <SettingsHub user={safeUser} />
    </>
  )
}
