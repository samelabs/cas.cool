import { redirect } from 'next/navigation'
import { t } from '@/lib/i18n'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import { InfinitePostList } from '@/components/posts/InfinitePostList'
import { getTimelinePage } from '@/lib/services/post.service'

export const metadata = { title: t.bookmarks.title }

export default async function BookmarksPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/login')

  const result = await getTimelinePage({ tab: 'latest', bookmarkedBy: me.id, userId: me.id })

  return (
    <>
      <PageHeader title={t.bookmarks.title} subtitle={t.bookmarks.saved(result.posts.length)} backHref="/" />

      <InfinitePostList
        basePath={`/api/posts?bookmarkedBy=${me.id}`}
        initialPosts={result.posts}
        initialNextCursor={result.nextCursor}
        emptyMessage={t.bookmarks.empty}
      />
    </>
  )
}
