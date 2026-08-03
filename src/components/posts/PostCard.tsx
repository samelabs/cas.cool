'use client'

import { useState, memo } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Avatar } from '@/components/ui/Avatar'
import { PostActions } from '@/components/posts/PostActions'
import { PostMenu } from '@/components/posts/PostMenu'
import { VerifiedBadge, FlaskIcon, RepostIcon, CommentIcon } from '@/components/icons'
import { timeAgo } from '@/lib/utils'
import { cn } from '@/lib/cn'
import { postUrl } from '@/lib/shortCode'
import type { SafePost } from '@/lib/types'
import type { ReactNode } from 'react'
import { t } from '@/lib/i18n'

// Lazy-load ImageModal — only needed when user clicks an image.
// Saves ~175 lines of JS from the initial bundle for every post card.
const ImageModal = dynamic(
  () => import('@/components/posts/ImageModal').then(m => ({ default: m.ImageModal })),
  { ssr: false },
)

export interface PostCardProps {
  post: SafePost
  hideComment?: boolean
  /** When set, shows "Replying to @username" above the content. Used for
   *  replies in the post detail page to provide thread context (Twitter-style). */
  replyingTo?: string | null
  /** Called after a successful delete so the parent list can remove the post.
   *  Receives the post ID so callers can pass a stable useCallback reference
   *  (not an inline arrow), which is required for React.memo to work. */
  onDeleted?: (postId: string) => void
  /** Visual variant:
   *  - 'feed' (default): standard timeline card with bottom border separator.
   *  - 'thread': ancestor card in a post-detail thread chain. No bottom border;
   *    z-10 so it paints above the vertical connector line from the card above. */
  variant?: 'feed' | 'thread'
}

const URL_RE = /https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?]/g
const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/g
// Mention: @username (1-20 chars). Must be at start of text or preceded by
// whitespace/punctuation — excludes email addresses (user@domain.com).
const MENTION_RE = /(?:^|(?<=[\s/(\[{:;,]))@[A-Za-z0-9_]{1,20}/g

function combineRegexes(): RegExp {
  return new RegExp(
    [
      `(${URL_RE.source})`,
      `(${CAS_RE.source})`,
      `(${MENTION_RE.source})`,
    ].join('|'),
    'g',
  )
}

const TOKEN_RE = combineRegexes()

export function renderContent(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  let match: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const [full, url, cas, mention] = match
    const idx = match.index
    if (idx > last) nodes.push(text.slice(last, idx))
    if (url) {
      nodes.push(
        <a key={`u-${key}`} href={url} target="_blank" rel="noopener noreferrer" className="relative z-10 text-brand hover:underline break-all">
          {url.replace(/^https?:\/\//, '')}
        </a>,
      )
    } else if (cas) {
      nodes.push(
        <Link key={`c-${key}`} href={`/cas/${cas}`} prefetch={false} className="relative z-10 inline-flex items-center rounded-md bg-brand-tint px-1.5 py-0.5 font-mono text-sm text-brand-ink hover:bg-brand/20">
          {cas}
        </Link>,
      )
    } else if (mention) {
      nodes.push(
        <Link key={`m-${key}`} href={`/u/${mention.slice(1)}`} prefetch={false} className="relative z-10 text-brand hover:underline">
          {mention}
        </Link>,
      )
    }
    last = idx + full.length
    key++
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const MAX_IMAGES = 4

const imgClass =
  'h-full w-full object-cover transition-opacity duration-150 hover:opacity-90'
const cellClass =
  'relative block w-full cursor-pointer overflow-hidden focus:outline-none focus:ring-2 focus:ring-brand/60'

/**
 * Multi-image grid (Twitter/X style).
 *  1 image  → single large image (max-height ~500px)
 *  2 images → side by side, equal width, square crops
 *  3 images → one large on the left (full height) + two stacked on the right
 *  4 images → 2×2 grid
 *  Images beyond MAX_IMAGES are ignored server-side; we render at most 4.
 */
export function ImagesGrid({
  images,
  onOpen,
}: {
  images: string[]
  onOpen: (index: number) => void
}) {
  const shown = images.slice(0, MAX_IMAGES)
  if (!shown.length) return null

  const handleClick = (index: number) => (e: React.MouseEvent) => {
    // The card has a full-cover link overlay (z-0); stop it so we can open the modal.
    e.preventDefault()
    e.stopPropagation()
    onOpen(index)
  }

  // --- 1 image: large, capped height, cover-cropped ---
  // min-h reserves vertical space before the image loads, preventing
  // layout shift (up to 500px jump) that breaks scroll positioning.
  if (shown.length === 1) {
    return (
      <button type="button" onClick={handleClick(0)} className={cn(cellClass, 'mt-3 aspect-[4/3] max-h-[500px] rounded-2xl')} aria-label={t.postCard.viewImage}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={shown[0]} alt={t.postCard.postImage} width={800} height={600} loading="lazy" draggable={false} className={cn(imgClass, 'max-h-[500px]')} />
      </button>
    )
  }

  // --- 3 images: 1 large left (spans 2 rows) + 2 stacked right ---
  if (shown.length === 3) {
    return (
      <div className="mt-3 grid aspect-square grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-2xl">
        <button type="button" onClick={handleClick(0)} className={cn(cellClass, 'row-span-2')} aria-label={t.postCard.viewImageN(1)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shown[0]} alt={t.postCard.postImageN(1)} loading="lazy" draggable={false} className={imgClass} />
        </button>
        <button type="button" onClick={handleClick(1)} className={cn(cellClass, 'aspect-square')} aria-label={t.postCard.viewImageN(2)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shown[1]} alt={t.postCard.postImageN(2)} loading="lazy" draggable={false} className={imgClass} />
        </button>
        <button type="button" onClick={handleClick(2)} className={cn(cellClass, 'aspect-square')} aria-label={t.postCard.viewImageN(3)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shown[2]} alt={t.postCard.postImageN(3)} loading="lazy" draggable={false} className={imgClass} />
        </button>
      </div>
    )
  }

  // --- 2 or 4 images: equal square grid ---
  return (
    <div className={cn('mt-3 grid grid-cols-2 gap-0.5 overflow-hidden rounded-2xl')}>
      {shown.map((src, i) => (
        <button key={i} type="button" onClick={handleClick(i)} className={cn(cellClass, 'aspect-square')} aria-label={t.postCard.viewImageN(i + 1)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={t.postCard.postImageN(i + 1)} loading="lazy" draggable={false} className={imgClass} />
        </button>
      ))}
    </div>
  )
}

export const PostCard = memo(function PostCard({ post, hideComment, replyingTo, onDeleted, variant = 'feed' }: PostCardProps) {
  const author = post.author
  const displayName = author.displayName || author.username
  const [openImage, setOpenImage] = useState(-1)

  // Tokenize content once and cache — the 4-way regex split + React node
  // creation is the most expensive per-card operation, and content never
  // changes between renders for a given post object.
  const renderedContent = post.content ? renderContent(post.content) : null
  const renderedQuotedContent = post.quotedPost?.content ? renderContent(post.quotedPost.content) : null

  // ── Tombstone: soft-deleted post ──
  // The record survives (preserving thread structure) but content is cleared.
  // Show author info + a "deleted" notice instead of the normal card body.
  if (post.deletedAt) {
    return (
      <article className={cn(
        'px-3 py-2.5 sm:px-4 sm:py-3',
        variant === 'thread' ? 'relative z-10' : 'border-b border-line',
      )}>
        <div className="flex items-start gap-2.5 sm:gap-3">
          <Avatar src={author.avatar} name={displayName} username={author.username} size="md" className="opacity-50" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-x-1.5 text-sm">
              <span className="font-semibold text-ink-muted">{displayName}</span>
              <span className="text-ink-faint">@{author.username}</span>
            </div>
            <p className="mt-1 text-base italic leading-relaxed text-ink-faint">
              {t.postCard.deleted}
            </p>
          </div>
        </div>
      </article>
    )
  }

  return (
    <article className={cn(
      'relative px-3 py-2.5 transition-colors hover:bg-surface-hover/40 sm:px-4 sm:py-3',
      variant === 'thread' ? 'z-10' : 'border-b border-line',
    )}>
      <Link href={postUrl(post)} scroll={false} prefetch={false} className="absolute inset-0 z-0" aria-label={t.postCard.openPost} />

      <div className="flex items-start gap-2.5 sm:gap-3">
        <Avatar src={author.avatar} name={displayName} username={author.username} size="md" href={`/u/${author.username}`} className="relative z-10" />

        <div className="min-w-0 flex-1">
          {/* User info row — only name + @username link to the author profile
              (z-10 above the card-wide post-detail overlay at z-0). The
              timestamp is plain text and falls through to the post-detail
              overlay, so empty space in this row goes to the post, not the
              profile. */}

          <div className="relative flex items-center gap-x-1.5 gap-y-0.5 text-sm">
            <Link href={`/u/${author.username}`} prefetch={false} className="relative z-10 font-semibold text-ink hover:underline">
              {displayName}
            </Link>
            {author.verificationStatus === 'verified' && <VerifiedBadge className="h-4 w-4 text-brand" />}
            <Link href={`/u/${author.username}`} prefetch={false} className="relative z-10 text-ink-muted hover:underline">
              @{author.username}
            </Link>
            {/* Original time hidden when edited — the edit marker below
                content carries the timestamp in that case. */}
            {!post.editedAt && (
              <>
                <span className="text-ink-faint">·</span>
                <span className="text-ink-muted">
                  {timeAgo(post.createdAt)}
                </span>
              </>
            )}
            <div className="ml-auto">
              <PostMenu post={post} onDeleted={onDeleted} />
            </div>
          </div>

          {/* Repost / Quote indicator.
              - Pure repost (no content, has quotedPost): "Reposted"
              - Quote post (has content + quotedPost): "Quoted"
              - Regular post: no indicator */}
          {post.quotedPost && (
            <div className="mt-0.5 flex items-center gap-1 text-xs font-medium text-ink-faint">
              {post.content ? (
                <><CommentIcon className="h-3 w-3" /> {t.postCard.quoted}</>
              ) : (
                <><RepostIcon className="h-3 w-3" /> {t.postCard.reposted}</>
              )}
            </div>
          )}

          {/* Thread context — "Replying to @author" (Twitter-style).
              Priority: explicit `replyingTo` prop (post-detail page) > per-post
              `post.replyToUsername` (profile Replies tab). */}
          {(replyingTo || post.replyToUsername) && (
            <p className="mt-0.5 text-xs text-ink-faint">
              Replying to{' '}
              <Link
                href={`/u/${replyingTo ?? post.replyToUsername}`}
                className="relative z-10 text-brand hover:underline"
              >
                @{replyingTo ?? post.replyToUsername}
              </Link>
            </p>
          )}

          {post.chemicals.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {post.chemicals.map((chem) => (
                <Link
                  key={chem.id}
                  href={`/cas/${chem.casNumber}`}
                  prefetch={false}
                  className="relative z-10 inline-flex items-center gap-1 font-mono text-xs text-brand-ink hover:text-brand"
                >
                  <FlaskIcon className="h-3.5 w-3.5" /> {t.postCard.cas(chem.casNumber)}
                </Link>
              ))}
            </div>
          )}

          {renderedContent && (
            <p className="mt-1 whitespace-pre-wrap break-words text-base leading-relaxed text-ink">
              {renderedContent}
            </p>
          )}

          {post.editedAt && (
            <p className="mt-0.5 text-xs text-ink-faint">
              {t.common.editedAt(timeAgo(post.editedAt))}
            </p>
          )}

          {post.images?.length > 0 && (
            <div className="relative z-10">
              <ImagesGrid images={post.images} onOpen={setOpenImage} />
            </div>
          )}

          {openImage >= 0 && post.images && post.images.length > 0 && (
            <ImageModal
              images={post.images}
              startIndex={openImage}
              onClose={() => setOpenImage(-1)}
            />
          )}

          {post.quotedPost && (
            <Link
              href={postUrl(post.quotedPost)}
              scroll={false}
              prefetch={false}
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 mt-3 block rounded-xl border border-line/60 p-3 transition-colors hover:bg-surface-hover"
            >
            {post.quotedPost.deletedAt ? (
              <p className="text-base italic leading-relaxed text-ink-faint">
                {t.postCard.deleted}
              </p>
            ) : (
              <>
              <div className="flex items-center gap-1.5 text-sm">
                <Avatar src={post.quotedPost.author.avatar} name={post.quotedPost.author.displayName || post.quotedPost.author.username} username={post.quotedPost.author.username} size="sm" className="shrink-0" />
                <Link
                  href={`/u/${post.quotedPost.author.username}`}
                  prefetch={false}
                  onClick={(e) => e.stopPropagation()}
                  className="font-semibold text-ink hover:underline"
                >
                  {post.quotedPost.author.displayName || post.quotedPost.author.username}
                </Link>
                {post.quotedPost.author.verificationStatus === 'verified' && <VerifiedBadge className="h-3.5 w-3.5 text-brand" />}
                <Link href={`/u/${post.quotedPost.author.username}`} prefetch={false} onClick={(e) => e.stopPropagation()} className="text-ink-faint hover:underline">@{post.quotedPost.author.username}</Link>
                <span className="text-ink-faint">·</span>
                <span className="text-ink-faint">{timeAgo(post.quotedPost.createdAt)}</span>
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

          <div className="relative z-10 mt-2 text-ink-faint">
            <PostActions post={post} hideComment={hideComment} hideRepost={!!post.quotedPost} />
          </div>
        </div>
      </div>
    </article>
  )
})

PostCard.displayName = 'PostCard'
export default PostCard
