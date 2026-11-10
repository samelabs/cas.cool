'use client'

import { useRouter } from 'next/navigation'
import { ComposeBox } from '@/components/posts/ComposeBox'
import { t } from '@/lib/i18n'
import type { SafePost } from '@/lib/types'

/**
 * CAS-page quick compose: appears in the empty state (no posts yet) with
 * this CAS number pre-attached. After a successful post, refresh the route
 * so the server-rendered feed picks it up.
 */
export function CasQuickCompose({
  casNumber,
  placeholder,
}: {
  casNumber: string
  placeholder?: string
}) {
  const router = useRouter()

  const onPosted = (_post: SafePost) => {
    router.refresh()
  }

  return (
    <ComposeBox
      autoFocus
      initialCasNumbers={[casNumber]}
      onPosted={onPosted}
      placeholder={placeholder ?? t.cas.noPostsBody}
    />
  )
}
