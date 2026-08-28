'use client'

import { useRef, useCallback, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PostCard, ImagesGrid, renderContent } from '@/components/posts/PostCard'
import { PostMenu } from '@/components/posts/PostMenu'
import { PostActions } from '@/components/posts/PostActions'
import { ImageModal } from '@/components/posts/ImageModal'
import ReplyBox from '@/components/posts/ReplyBox'
import MobileReplyBar from '@/components/posts/MobileReplyBar'
import { InfinitePostList, type InfinitePostListHandle } from '@/components/posts/InfinitePostList'
import { Avatar } from '@/components/ui/Avatar'
import FollowButton from '@/components/profile/FollowButton'
import { VerifiedBadge, FlaskIcon, RepostIcon, CommentIcon } from '@/components/icons'
import { useCurrentUser } from '@/components/Providers'
import { postUrl } from '@/lib/shortCode'
import { cn } from '@/lib/cn'
import type { SafePost, SafeUser } from '@/lib/types'
import { t } from '@/lib/i18n'

/** Format full timestamp: "3:45:30 PM · Jun 22, 2026" */
function fullTimestamp(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
  const dateStr = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  return `${time} · ${dateStr}`
}

/** Main post — full-width detail layout (not a card).
 *  Visually distinct from feed cards: larger avatar, vertical name/username,
 *  Follow button + menu on the right, full timestamp at the bottom.
 *  No card border — flows seamlessly from the PageHeader above. */
function MainPost({ post, onDeleted, authorFollowed = false }: { post: SafePost; onDeleted?: (id: string) => void; authorFollowed?: boolean }) {
  const author = post.author
  const displayName = author.displayName || author.username
  const currentUser = useCurrentUser()
  const isOwnPost = currentUser?.id === author.id
  const [openImage, setOpenImage] = useState(-1)

  const renderedContent = post.content ? renderContent(post.content) : null
  const renderedQuotedContent = post.quotedPost?.content ? renderContent(post.quotedPost.content) : null

  // Soft-deleted main post → tombstone
  if (post.deletedAt) {
    return (
      <article className="px-4 py-3">
        <div className="flex items-start gap-3">
          <Avatar src={author.avatar} name={displayName} username={author.username} size="md" className="opacity-50" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink-muted">{displayName}</p>
            <p className="text-sm text-ink-faint">@{author.username}</p>
            <p className="mt-2 text-base italic leading-relaxed text-ink-faint">
              {t.postCard.deleted}
            </p>
          </div>
        </div>
      </article>
    )
  }

  return (
    <article className="relative px-4 py-3">
      {/* Repost / Quote indicator (same logic as feed PostCard) */}
      {post.quotedPost && (
        <div className="mb-2 flex items-center gap-1 text-xs font-medium text-ink-faint">
          {post.content ? (
            <><CommentIcon className="h-3 w-3" /> {t.postCard.quoted}</>
          ) : (
            <><RepostIcon className="h-3 w-3" /> {t.postCard.reposted}</>
          )}
        </div>
      )}

      {/* Header row: avatar left, name/username vertically stacked, follow+menu right */}
      <div className="flex items-start gap-3">
        <Avatar src={author.avatar} name={displayName} username={author.username} size="lg" href={`/u/${author.username}`} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Link href={`/u/${author.username}`} prefetch={false} className="font-bold text-ink hover:underline truncate">
              {displayName}
            </Link>
            {author.verificationStatus === 'verified' && <VerifiedBadge className="h-4 w-4 text-brand shrink-0" />}
          </div>
          <Link href={`/u/${author.username}`} prefetch={false} className="text-sm text-ink-muted hover:underline">
            @{author.username}
          </Link>
        </div>

        {/* Right side: Follow button (when not self) + menu */}
        <div className="flex items-center gap-2 shrink-0">
          {!isOwnPost && (
            <FollowButton targetUser={author} initialFollowing={authorFollowed} size="sm" />
          )}
          <PostMenu post={post} onDeleted={onDeleted} />
        </div>
      </div>

      {/* Content */}
      <div className="mt-3">
        {post.content && (
          <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-ink">
            {renderedContent}
          </p>
        )}

        {post.chemicals.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {post.chemicals.map((chem) => (
              <Link
                key={chem.id}
                href={`/cas/${chem.casNumber}`}
                prefetch={false}
                className="inline-flex items-center gap-1 font-mono text-xs text-brand-ink hover:text-brand"
              >
                CAS {chem.casNumber}
              </Link>
            ))}
          </div>
        )}

        {/* Images — reuse PostCard's ImagesGrid with full click-to-zoom */}
        {post.images?.length > 0 && (
          <ImagesGrid images={post.images} onOpen={setOpenImage} />
        )}
        {openImage >= 0 && post.images && post.images.length > 0 && (
          <ImageModal images={post.images} startIndex={openImage} onClose={() => setOpenImage(-1)} />
        )}

      </div>

      {/* Quoted post — clickable card linking to the original post */}
      {post.quotedPost && (
        <Link
          href={postUrl(post.quotedPost)}
          scroll={false}
          prefetch={false}
          className="mt-3 block rounded-xl border border-line/60 p-3 transition-colors hover:bg-surface-hover"
        >
          {post.quotedPost.deletedAt ? (
            <p className="text-base italic leading-relaxed text-ink-faint">
              {t.postCard.deleted}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-1.5 text-sm">
                <Avatar src={post.quotedPost.author.avatar} name={post.quotedPost.author.displayName || post.quotedPost.author.username} username={post.quotedPost.author.username} size="sm" className="shrink-0" />
                <span className="font-semibold text-ink hover:underline">{post.quotedPost.author.displayName || post.quotedPost.author.username}</span>
                {post.quotedPost.author.verificationStatus === 'verified' && <VerifiedBadge className="h-3.5 w-3.5 text-brand" />}
                <span className="text-ink-faint hover:underline">@{post.quotedPost.author.username}</span>
              </div>
              {post.quotedPost.content && (
                <p className="mt-1 whitespace-pre-wrap break-words text-base leading-relaxed text-ink-muted">
                  {renderedQuotedContent}
                </p>
              )}
              {post.quotedPost.chemicals.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {post.quotedPost.chemicals.map((chem) => (
                    <span key={chem.id} className="inline-flex items-center gap-1 font-mono text-xs text-brand-ink">
                      <FlaskIcon className="h-3.5 w-3.5" /> {t.postCard.cas(chem.casNumber)}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </Link>
      )}

      {/* Timestamp — no border separator. When edited, show only the edit time. */}
      <div className="mt-3 text-sm text-ink-faint">
        {post.editedAt
          ? t.common.editedAt(fullTimestamp(post.editedAt))
          : fullTimestamp(post.createdAt)}
      </div>

      {/* Actions bar */}
      <div className="mt-3">
        <PostActions post={post} hideComment hideRepost={!!post.quotedPost} />
      </div>
    </article>
  )
}

export interface PostDetailClientProps {
  postId: string
  mainPost: SafePost
  /** Ancestor chain (root → ... → parent) shown above MainPost for replies.
   *  Empty array for root posts. */
  chainPosts?: SafePost[]
  initialReplies: SafePost[]
  initialReplyCursor: string | null
  currentUser: SafeUser | null
  /** Whether the current user follows the main post's author. */
  authorFollowed?: boolean
}

/**
 * Client-side wrapper for the post detail page.
 *
 * Layout (Twitter-style):
 *  1. Parent post (if this post is a reply) — shown above with a divider
 *  2. Main post (the one being viewed)
 *  3. Reply box (desktop) / login prompt (guest)
 *  4. Reply list (infinite scroll for logged-in, static for guests)
 *
 * Optimistic reply: InfinitePostList exposes its SWR infinite `mutate`
 * via `onReady`. When a reply is posted, we call `inject(newReply)` which
 * appends it to the first page of the SWR cache — no refetch needed.
 *
 * Non-logged-in (guest) visitors: `initialReplyCursor` is null from SSR,
 * which disables infinite scroll entirely. A login prompt replaces the
 * reply box.
 */
export function PostDetailClient({
  postId,
  mainPost,
  chainPosts = [],
  initialReplies,
  initialReplyCursor,
  currentUser,
  authorFollowed = false,
}: PostDetailClientProps) {
  const router = useRouter()
  const listRef = useRef<InfinitePostListHandle | null>(null)
  // Tracks whether the main post has at least one reply. Initialized from
  // the SSR reply list and kept current as replies are injected client-side.
  const hasRepliesRef = useRef(initialReplies.length > 0)

  const handleReady = useCallback((handle: InfinitePostListHandle) => {
    listRef.current = handle
  }, [])

  const handleReply = useCallback((newReply: SafePost) => {
    hasRepliesRef.current = true
    listRef.current?.inject(newReply)
  }, [])

  // When the main post is deleted:
  //  - If it has replies → router.refresh() to re-render as a tombstone
  //    (the soft-deleted record survives, replies stay visible)
  //  - If no replies → redirect home (nothing left to show on this page)
  //
  // The reply count is fetched fresh from the server at delete time — the
  // SSR-prop count is stale if the user replied after page load and would
  // wrongly redirect a live conversation view back to the home feed.
  const handleMainPostDeleted = useCallback(() => {
    if (hasRepliesRef.current) {
      router.refresh()
    } else {
      router.push('/')
    }
  }, [router])

  // Reply list: ONLY direct replies to THIS post (same as root post detail).
  const basePath = `/api/posts?tab=latest&repliesOf=${postId}`

  // Refs for scroll positioning:
  // - mainPostRef: the scroll TARGET (top of MainPost, flush below header)
  // - contentRef: wrapper around ancestors + MainPost — observed by
  //   ResizeObserver to catch ALL layout shifts (ancestor images,
  //   MainPost images, reply injection) and re-scroll accordingly.
  const mainPostRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scrollToMainPost = () => {
      if (chainPosts.length > 0 && mainPostRef.current) {
        // PageHeader inner div h-[53px] + border-b 1px = 54px total.
        // Position MainPost flush below the header (no overlap).
        const y = mainPostRef.current.getBoundingClientRect().top + window.scrollY - 54
        window.scrollTo(0, y)
      } else {
        window.scrollTo(0, 0)
      }
    }

    scrollToMainPost()

    // Images (both ancestor chain and MainPost) may load asynchronously
    // and shift layout. The browser's built-in scroll anchoring is
    // disabled via overflow-anchor:none on the wrapper below, so WE are
    // the sole scroll controller. The ResizeObserver watches the entire
    // content area to catch every layout shift and re-scroll to the
    // correct position.
    //
    // rAF coalescing prevents jitter from multiple callbacks in one frame.
    // Auto-disconnects after 2s (covers slow image loads) or when the
    // user interacts (touchmove / wheel).
    if (!contentRef.current) return

    let userInteracted = false
    let rafId = 0

    const stop = () => {
      userInteracted = true
      cancelAnimationFrame(rafId)
      observer.disconnect()
      window.removeEventListener('touchmove', stop)
      window.removeEventListener('wheel', stop)
    }

    const observer = new ResizeObserver(() => {
      if (userInteracted) return
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(scrollToMainPost)
    })
    observer.observe(contentRef.current)
    window.addEventListener('touchmove', stop, { passive: true })
    window.addEventListener('wheel', stop, { passive: true })

    const timer = setTimeout(stop, 2000)

    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(rafId)
      observer.disconnect()
      window.removeEventListener('touchmove', stop)
      window.removeEventListener('wheel', stop)
    }
  }, [postId, chainPosts.length])

  return (
    <div ref={contentRef}>
      {/* Ancestor thread — PostCards with vertical connector lines (Twitter-style).
          Rendered ABOVE MainPost. On page open the view auto-scrolls past these
          to focus on MainPost; user scrolls up to see the thread context. */}
      {chainPosts.length > 0 && (
        <div>
          {chainPosts.map((post, i) => {
            const isLast = i === chainPosts.length - 1
            return (
              <div key={post.id} className="relative">
                <PostCard post={post} hideComment variant="thread" />
                {/* Vertical connector from this avatar's vertical centre down
                    to the next card's avatar centre.
                      thread → thread (md avatar 40px): next centre is 30px below
                      thread → MainPost (lg avatar 48px): next centre is 36px below */}
                <span className={cn(
                  'pointer-events-none absolute w-px bg-line left-[32px] sm:left-[36px] top-[30px]',
                  isLast ? 'bottom-[-36px]' : 'bottom-[-30px]',
                )} />
              </div>
            )
          })}
        </div>
      )}

      {/* MainPost + content below.

          min-h is ONLY applied for reply pages (ancestors above MainPost).
          Why: reply pages need enough total page height for MainPost to be
          scrollable to the top of the viewport (past the ancestor chain).
          The min-h ensures: pageHeight >= chainHeight + viewport, so
          maxScroll >= chainHeight (= the scroll target).

          Root posts DON'T need min-h — they start at scrollY=0 (top of page).
          Applying min-h to root posts with short content creates a phantom
          1px scroll region (from the 53/54px header-height rounding) that
          makes the page feel micro-jittery. Without min-h, root pages are
          exactly as tall as their content (or 100dvh via <main>'s own
          min-h, whichever is taller) — clean, no phantom scroll.

          54px = PageHeader h-[53px] + border-b 1px. */}
      <div className={cn(chainPosts.length > 0 && 'min-h-[calc(100dvh_-_54px)]')}>
        {/* MainPost — relative z-30 ensures it (and its popover menus)
            paint above the connector-line overflow and the reply list below.
            The PostActions repost popover and PostMenu dropdown both elevate
            their <article> to z-50 at runtime, but that only works if the
            MainPost wrapper creates a stacking context that outranks the
            sibling reply cards (z-10). */}
        <div ref={mainPostRef} className="relative z-20">
          <MainPost post={mainPost} onDeleted={handleMainPostDeleted} authorFollowed={authorFollowed} />
        </div>

        {mainPost.deletedAt ? null : currentUser ? (
          <div className="hidden md:block">
            <ReplyBox parentId={postId} onReply={handleReply} />
          </div>
        ) : (
          <div className="border-b border-line bg-brand-tint/40 px-4 py-3 text-center text-sm text-ink-muted">
            <Link href="/login" className="font-semibold text-brand hover:underline">{t.common.signIn}</Link> to reply and join the conversation.
          </div>
        )}

        <InfinitePostList
          basePath={basePath}
          initialPosts={initialReplies}
          initialNextCursor={initialReplyCursor}
          hideEmpty
          hideEndSeparator
          onReady={handleReady}
        />

        {/* Bottom padding so the last reply isn't hidden behind the fixed mobile nav */}
        <div className="h-20 md:hidden" />
      </div>

      {currentUser && !mainPost.deletedAt && <MobileReplyBar postId={postId} onReply={handleReply} />}
    </div>
  )
}

export default PostDetailClient
