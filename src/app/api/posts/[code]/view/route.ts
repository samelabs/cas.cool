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
import { resolveIdentity, writeAccessError } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params
  const authHeader = request.headers.get('authorization')

  // Explicit Bearer authorization gate:
  // - Invalid Bearer cannot fall back to anonymous counting (401).
  // - Programmatic Key without write permission cannot record views or increment counters (403).
  // - Anonymous visitors and browser sessions retain standard view telemetry.
  const identity = await resolveIdentity()
  if (authHeader !== null) {
    if (!identity.authenticated || !identity.user) {
      return jsonError(401, 'unauthorized', 'Invalid API key.')
    }
    if (identity.method === 'apikey') {
      const writeErr = writeAccessError(identity)
      if (writeErr) {
        return jsonError(writeErr.status, writeErr.code, writeErr.message)
      }
    }
  }

  // Rate limit: IP-keyed for anonymous, per-user/key for sessions and authenticated keys.
  const limited = checkRateLimit(identity, identity.method === 'apikey' ? 'write' : 'read')
  if (limited) return limited

  const post = await prisma.post.findFirst({
    where: { shortCode: code, deletedAt: null },
    select: { id: true, authorId: true },
  })
  if (!post) {
    return jsonError(404, 'not_found', 'Post not found.')
  }

  const postId = post.id

  if (identity.authenticated && identity.user) {
    const userId = identity.user.id
    // The post's author viewing their own post does not increment views or create view records.
    if (post.authorId === userId) {
      return Response.json({ ok: true })
    }

    try {
      await prisma.$transaction(async (tx) => {
        const inserted = await tx.postView.createMany({
          data: [{ postId, userId }],
          skipDuplicates: true,
        })
        if (inserted.count > 0) {
          await tx.post.update({
            where: { id: postId },
            data: { views: { increment: 1 } },
          })
        }
      })
    } catch (e: unknown) {
      console.error('PostView transaction error:', e)
      return jsonError(500, 'internal_error', 'Failed to record post view.')
    }
  } else {
    try {
      await prisma.post.update({
        where: { id: postId },
        data: { views: { increment: 1 } },
      })
    } catch (e: unknown) {
      console.error('Anonymous view increment error:', e)
      return jsonError(500, 'internal_error', 'Failed to record post view.')
    }
  }

  return Response.json({ ok: true })
}
