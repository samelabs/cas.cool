import { redirect } from 'next/navigation'
import { t } from '@/lib/i18n'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import { ComposeBox } from '@/components/posts/ComposeBox'
import { getPostById } from '@/lib/services/post.service'

export const metadata = { title: t.compose.title }

/** Check if a post is still within its 60-minute edit window. */
function isWithinEditWindow(createdAt: Date | string): boolean {
  return Date.now() - new Date(createdAt).getTime() < 60 * 60 * 1000
}

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<{ quote?: string; edit?: string }>
}) {
  const me = await getCurrentUser()
  if (!me) redirect('/login')

  const { quote, edit } = await searchParams

  // --- Edit mode ---
  // Only the author can edit, and only within 60 minutes of creation.
  // If the edit window has passed or the post doesn't belong to the user,
  // silently redirect to home (don't reveal whether the post exists).
  if (edit) {
    const post = await getPostById(edit, me.id)
    if (!post || post.authorId !== me.id) redirect('/')
    if (!isWithinEditWindow(post.createdAt)) redirect(`/p/${post.shortCode}`)

    return (
      <>
        <PageHeader title={t.compose.editPost} backHref={`/p/${post.shortCode ?? ''}`} />
        <div className="border-b border-line bg-brand-tint/30">
          <ComposeBox
            autoFocus
            editPost={post}
          />
        </div>
      </>
    )
  }

  // --- Quote mode ---
  let quotePost = null
  if (quote) {
    quotePost = await getPostById(quote, me.id)
  }

  return (
    <>
      <PageHeader title={quotePost ? t.compose.quotePost : t.compose.newPost} backHref="/" />
      <div className="border-b border-line bg-brand-tint/30">
        <ComposeBox
          autoFocus
          quotePostId={quotePost?.id ?? null}
          quotePost={quotePost}
          placeholder={quotePost ? t.compose.quotePlaceholder : t.compose.placeholder}
        />
      </div>
    </>
  )
}
