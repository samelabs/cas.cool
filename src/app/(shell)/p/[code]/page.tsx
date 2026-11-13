import { notFound } from 'next/navigation'
import { cache } from 'react'
import { t } from '@/lib/i18n'
import { getCurrentUser } from '@/lib/auth'
import PageHeader from '@/components/layout/PageHeader'
import { PostDetailClient } from '@/components/posts/PostDetailClient'
import ViewIncrement from '@/components/posts/ViewIncrement'
import type { Metadata } from 'next'
import { getPostByShortCode, getPostChain, getPostReplies, checkFollow } from '@/lib/services/post.service'
import { jsonLdScript } from '@/lib/utils'
import { getSiteConfig } from '@/lib/site'

// Request-scoped dedupe: generateMetadata and the page body both read the
// post — React cache() collapses them into ONE query per (code, viewer)
// within a single request. Per-request scope only; never shared across
// users or requests, so personalized state (liked/bookmarked/viewer flags
// inside the include) stays isolated.
const getPost = cache((code: string, userId?: string | null) => getPostByShortCode(code, userId))

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>
}): Promise<Metadata> {
  const { code } = await params
  // Same (code, userId) tuple as the page body so the request-scoped cache
  // dedupes the post read across metadata + page. getCurrentUser() is
  // itself React-cache()d (src/lib/auth.ts), so this adds no extra query.
  const me = await getCurrentUser()
  const post = await getPost(code, me?.id)
  const site = await getSiteConfig()
  if (!post) return { title: t.seo.postNotFound }
  // Soft-deleted post: tombstone page renders "deleted" notice with HTTP 200.
  // 200 tombstone preserves reply chain stability, conversation context, and client
  // API contracts without breaking linked UI trees or causing churn.
  if (post.deletedAt) {
    return { title: t.postCard.deleted }
  }
  const author = post.author.displayName || post.author.username
  const preview = post.content.slice(0, 120) || t.common.openInNew
  const chem = post.chemicals[0]
  const title = chem
    ? t.seo.postWithCas(author, chem.casNumber)
    : `${author} on ${site.name}`

  return {
    title,
    description: preview,
    alternates: {
      canonical: `${site.origin}/p/${code}`,
    },
    openGraph: {
      title,
      description: preview,
      url: `${site.origin}/p/${code}`,
      type: 'article',
      siteName: site.name,
      ...(post.images?.[0]
        ? { images: post.images.map((img) => ({ url: img.startsWith('http') ? img : `${site.origin}${img}` })) }
        : {}),
    },
    twitter: {
      card: post.images?.[0] ? 'summary_large_image' : 'summary',
      title,
      description: preview,
      ...(post.images?.[0]
        ? { images: post.images.map((img) => (img.startsWith('http') ? img : `${site.origin}${img}`)) }
        : {}),
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
  const site = await getSiteConfig()
  const me = await getCurrentUser()
  const isLoggedIn = !!me

  const post = await getPost(code, me?.id)
  if (!post) notFound()

  const main = post

  // Chain, replies and follow-state are independent of each other once the
  // post is loaded (chain/replies key off post ids; follow keys off the
  // viewer + authorId) — fetch them in parallel instead of sequentially.
  // (chain only exists for replies; follow only for logged-in viewers
  // looking at someone else's post.)
  const [chainResult, replyResult, authorFollowed] = await Promise.all([
    post.parentId
      ? getPostChain(post.id, post.conversationId || post.parentId, me?.id)
      : Promise.resolve(null),
    getPostReplies(post.id, me?.id, isLoggedIn ? undefined : 5),
    me && me.id !== post.authorId ? checkFollow(me.id, post.authorId) : Promise.resolve(false),
  ])
  const chainPosts = chainResult ? chainResult.ancestors : []
  const replyFeed = replyResult.posts

  const publicImages = (post.images ?? []).map((img) =>
    img.startsWith('http') ? img : `${site.origin}${img}`
  )

  const jsonLd = post.deletedAt
    ? null
    : {
        '@context': 'https://schema.org',
        '@type': 'SocialMediaPosting',
        text: post.content,
        author: {
          '@type': 'Person',
          name: post.author.displayName || post.author.username,
          url: `${site.origin}/u/${post.author.username}`,
        },
        url: `${site.origin}/p/${code}`,
        datePublished:
          post.createdAt instanceof Date ? post.createdAt.toISOString() : new Date(post.createdAt).toISOString(),
        ...(post.editedAt
          ? {
              dateModified:
                post.editedAt instanceof Date ? post.editedAt.toISOString() : new Date(post.editedAt).toISOString(),
            }
          : {}),
        ...(publicImages.length > 0 ? { image: publicImages } : {}),
        ...(post.chemicals?.[0]
          ? {
              about: {
                '@type': 'ChemicalSubstance',
                identifier: `CAS ${post.chemicals[0].casNumber}`,
                name: `CAS ${post.chemicals[0].casNumber}`,
                url: `${site.origin}/cas/${post.chemicals[0].casNumber}`,
              },
            }
          : {}),
      }

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
        />
      )}
      <PageHeader title={t.common.post} backHref="/" />

      <PostDetailClient
        postId={post.id}
        mainPost={main}
        chainPosts={chainPosts}
        initialHasMoreAncestors={chainResult?.hasMoreAncestors ?? false}
        initialAncestorCursor={chainResult?.nextAncestorCursor ?? null}
        initialReplies={replyFeed}
        initialReplyCursor={isLoggedIn ? replyResult.nextCursor : null}
        authorFollowed={authorFollowed}
        currentUser={me}
      />
      <ViewIncrement code={code} />
    </>
  )
}
