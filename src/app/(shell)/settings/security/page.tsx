import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import { SecurityForm } from '@/components/settings/SecurityForm'
import { t } from '@/lib/i18n'

export const metadata: Metadata = { title: t.settings.security }

export default async function SecuritySettingsPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/login')

  return (
    <>
      <PageHeader title={t.settings.security} backHref="/settings" />
      <SecurityForm />
    </>
  )
}
