import { notFound } from 'next/navigation'
import { t } from '@/lib/i18n'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import { PostDetailClient } from '@/components/posts/PostDetailClient'
import ViewIncrement from '@/components/posts/ViewIncrement'
import type { Metadata } from 'next'
import { getPostByShortCode, getPostChain, getPostReplies, checkFollow } from '@/lib/services/post.service'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>
}): Promise<Metadata> {
  const { code } = await params
  const post = await getPostByShortCode(code)
  if (!post) return { title: t.seo.postNotFound }
  // Soft-deleted post: tombstone page renders "deleted" content.
  // No noindex — Google indexes the tombstone naturally; no need to
  // send an explicit exclusion signal that triggers Search Console alerts.
  if (post.deletedAt) {
    return { title: t.postCard.deleted }
  }
  const author = post.author.displayName || post.author.username
  const preview = post.content.slice(0, 120) || t.common.openInNew
  const chem = post.chemicals[0]
  const title = chem
    ? t.seo.postWithCas(author, chem.casNumber)
    : t.seo.postByAuthor(author)

  return {
    title,
    description: preview,
    openGraph: {
      title,
      description: preview,
      type: 'article',
      siteName: t.seo.siteName,
      ...(post.images?.[0] ? { images: [{ url: post.images[0] }] } : {}),
    },
    twitter: {
      card: post.images?.[0] ? 'summary_large_image' : 'summary',
      title,
      description: preview,
      ...(post.images?.[0] ? { images: [post.images[0]] } : {}),
    },
  }
}

/**
 * Post detail page — /p/[shortCode]
 *
 * SSR behaviour differs for logged-in vs guest visitors:
 *
 * **Logged-in**: full FEED_PAGE_SIZE (20) replies + cursor → client-side
 * infinite scroll works.
 *
 * **Guest (SEO/crawler)**: only 5 replies, cursor=null → no infinite
 * scroll, no client-side API calls. This keeps the SSR HTML lightweight
 * for crawlers and reduces resource usage. A login prompt replaces the
 * reply box, guiding visitors to authenticate.
 *
 * OG/Twitter metadata is built from the post content for social sharing.
 */
export default async function ShortPostPage({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  const me = await getCurrentUser()
  const isLoggedIn = !!me

  const post = await getPostByShortCode(code, me?.id)
  if (!post) notFound()

  const main = post

  // Build the ancestor chain for replies (root → ... → parent of current).
  // Two-phase fetch: first lightweight id+parentId for chain walk, then
  // hydrate only the actual ancestors (typically 1-10 posts, not all replies).
  const chainPosts = post.parentId
    ? await getPostChain(post.id, post.conversationId || post.parentId, me?.id)
    : []

  // Guest: 5 replies, no cursor (disables infinite scroll).
  // Logged-in: 20 replies + cursor (full pagination).
  const replyResult = await getPostReplies(post.id, me?.id, isLoggedIn ? undefined : 5)
  const replyFeed = replyResult.posts

  // Check if current user follows the post author (for the Follow button).
  const authorFollowed =
    me && me.id !== post.authorId ? await checkFollow(me.id, post.authorId) : false

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SocialMediaPosting',
    headline: post.content.slice(0, 100),
    author: {
      '@type': 'Person',
      name: post.author.displayName || post.author.username,
      url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://cas.cool'}/${post.author.username}`,
    },
    url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://cas.cool'}/p/${code}`,
    datePublished: post.createdAt,
    ...(post.images?.[0] ? { image: post.images[0] } : {}),
    ...(post.chemicals?.[0] ? { about: { '@type': 'ChemicalSubstance', identifier: `CAS ${post.chemicals[0].casNumber}` } } : {}),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PageHeader title={t.common.post} backHref="/" />

      <PostDetailClient
        postId={post.id}
        mainPost={main}
        chainPosts={chainPosts}
        initialReplies={replyFeed}
        initialReplyCursor={isLoggedIn ? replyResult.nextCursor : null}
        authorFollowed={authorFollowed}
        currentUser={me}
      />
      <ViewIncrement code={code} />
    </>
  )
}
