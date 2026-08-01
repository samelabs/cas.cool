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

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params

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
  const identity = await resolveIdentity()

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
