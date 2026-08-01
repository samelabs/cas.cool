/**
 * /api/posts/[code]/like
 * /api/posts/[code]/bookmark
 * /api/posts/[code]/repost
 *
 * POST   → activate (like / bookmark / repost)
 * DELETE → deactivate
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { generateShortCode } from '@/lib/shortCode'
import { upsertNotification } from '@/lib/notification'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

async function findPostId(code: string): Promise<string | null> {
  const post = await prisma.post.findFirst({
    where: { shortCode: code, deletedAt: null },
    select: { id: true },
  })
  return post?.id ?? null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string; action: string }> },
) {
  const { code, action } = await params
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!
  const postId = await findPostId(code)
  if (!postId) return jsonError(404, 'not_found', 'Post not found.')

  switch (action) {
    case 'like': {
      const post = await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true } })
      const existing = await prisma.like.findUnique({ where: { postId_userId: { postId, userId: user.id } } })
      if (!existing) {
        try {
          await prisma.$transaction([
            prisma.like.create({ data: { postId, userId: user.id } }),
            prisma.post.update({ where: { id: postId }, data: { likeCount: { increment: 1 } } }),
          ])
        } catch (e: unknown) {
          if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) throw e
        }
        if (post && post.authorId !== user.id) {
          await upsertNotification({ userId: post.authorId, fromId: user.id, type: 'LIKE', postId })
        }
      }
      return Response.json({ liked: true })
    }

    case 'bookmark': {
      const existing = await prisma.bookmark.findUnique({ where: { postId_userId: { postId, userId: user.id } } })
      if (!existing) {
        try {
          await prisma.$transaction([
            prisma.bookmark.create({ data: { postId, userId: user.id } }),
            prisma.post.update({ where: { id: postId }, data: { bookmarkCount: { increment: 1 } } }),
          ])
        } catch (e: unknown) {
          if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) throw e
        }
      }
      return Response.json({ bookmarked: true })
    }

    case 'repost': {
      const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } })
      const existing = await prisma.repost.findUnique({ where: { postId_userId: { postId, userId: user.id } } })
      if (!existing) {
        await prisma.$transaction([
          prisma.repost.create({ data: { postId, userId: user.id } }),
          prisma.post.create({
            data: {
              authorId: user.id,
              content: '',
              quotePostId: postId,
              images: [],
              shortCode: generateShortCode(),
            },
          }),
          prisma.post.update({ where: { id: postId }, data: { repostCount: { increment: 1 } } }),
          prisma.user.update({ where: { id: user.id }, data: { postCount: { increment: 1 } } }),
        ])
        if (post && post.authorId !== user.id) {
          await upsertNotification({ userId: post.authorId, fromId: user.id, type: 'REPOST', postId })
        }
      }
      return Response.json({ reposted: true })
    }

    default:
      return jsonError(404, 'not_found', 'Unknown action.')
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string; action: string }> },
) {
  const { code, action } = await params
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const user = auth.identity.user!
  const postId = await findPostId(code)
  if (!postId) return jsonError(404, 'not_found', 'Post not found.')

  switch (action) {
    case 'like': {
      await prisma.$transaction(async (tx) => {
        const deleted = await tx.like.deleteMany({ where: { postId, userId: user.id } })
        if (deleted.count > 0) {
          await tx.post.update({ where: { id: postId }, data: { likeCount: { decrement: deleted.count } } })
        }
      })
      return Response.json({ liked: false })
    }

    case 'bookmark': {
      await prisma.$transaction(async (tx) => {
        const deleted = await tx.bookmark.deleteMany({ where: { postId, userId: user.id } })
        if (deleted.count > 0) {
          await tx.post.update({ where: { id: postId }, data: { bookmarkCount: { decrement: deleted.count } } })
        }
      })
      return Response.json({ bookmarked: false })
    }

    case 'repost': {
      const existing = await prisma.repost.findUnique({ where: { postId_userId: { postId, userId: user.id } } })
      if (existing) {
        await prisma.$transaction(async (tx) => {
          await tx.repost.delete({ where: { id: existing.id } })
          const deleted = await tx.post.deleteMany({ where: { authorId: user.id, quotePostId: postId, content: '' } })
          if (deleted.count > 0) {
            await tx.post.update({ where: { id: postId }, data: { repostCount: { decrement: 1 } } })
            await tx.user.update({ where: { id: user.id }, data: { postCount: { decrement: 1 } } })
          }
        })
      }
      return Response.json({ reposted: false })
    }

    default:
      return jsonError(404, 'not_found', 'Unknown action.')
  }
}
