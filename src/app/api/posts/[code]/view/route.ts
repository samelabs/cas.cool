/**
 * POST /api/posts/[code]/view — increment view count (deduped per user).
 *
 * Logic mirrors posts.ts incrementView:
 *   - If authenticated, create a PostView row (unique per user+post).
 *     P2002 (already viewed) is silently ignored.
 *   - Always increment the Post.views counter via raw SQL.
 *   - If anonymous, just increment views.
 *
 * Auth: optional (works for logged-in and anonymous visitors).
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { resolveIdentity } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params

  // Rate limit: IP-keyed for anonymous, per-user for sessions (read tier).
  // Mirrors the pre-migration proxy rule: /api/posts/*/view → 30/min IP.
  const identity = await resolveIdentity()
  const limited = checkRateLimit(identity, 'read')
  if (limited) return limited

  const post = await prisma.post.findFirst({
    where: { shortCode: code, deletedAt: null },
    select: { id: true },
  })
  if (!post) {
    return Response.json(
      { error: { code: 'not_found', message: 'Post not found.' } },
      { status: 404 },
    )
  }

  const postId = post.id

  if (identity.authenticated && identity.user) {
    try {
      await prisma.postView.create({ data: { postId, userId: identity.user.id } })
      await prisma.$executeRaw`UPDATE "Post" SET views = views + 1 WHERE id = ${postId}`
        .catch((e: unknown) => console.error('View increment error:', e))
    } catch (e: unknown) {
      // P2002 unique-constraint → already viewed by this user; ignore.
      if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) {
        console.error('PostView create error:', e)
      }
    }
  } else {
    await prisma.$executeRaw`UPDATE "Post" SET views = views + 1 WHERE id = ${postId}`
      .catch((e: unknown) => console.error('View increment error:', e))
  }

  return Response.json({ ok: true })
}
