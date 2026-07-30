import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import { ApiKeysClient } from '@/components/settings/ApiKeysClient'
import { t } from '@/lib/i18n'

export const metadata: Metadata = { title: t.api.title }

export default async function ApiKeysPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/login')

  return (
    <>
      <PageHeader title={t.api.title} backHref="/settings" />
      <ApiKeysClient verificationStatus={me.verificationStatus} />
    </>
  )
}
