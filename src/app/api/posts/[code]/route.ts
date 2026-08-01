/**
 * /api/posts/[code]
 *
 * GET    /api/posts/:code                      — get single post by shortCode
 * PATCH  /api/posts/:code                      — edit own post (60min window)
 * DELETE /api/posts/:code                      — soft-delete own post (or admin)
 *
 * Interaction actions (like/bookmark/repost) live in
 * /api/posts/[code]/[action]; view counting lives in /api/posts/[code]/view.
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { postInclude, serializePost } from '@/lib/serialize'
import { requireAuth, requireWrite, resolveIdentity } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { maxPostLength } from '@/lib/permissions'
import { generateShortCode } from '@/lib/shortCode'
import { upsertNotification } from '@/lib/notification'

const MAX_IMAGES = 4
const CAS_FORMAT = /^\d{2,7}-\d{2}-\d$/
const EDIT_WINDOW_MS = 60 * 60 * 1000

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

async function findPostByCode(code: string) {
  return prisma.post.findFirst({
    where: { shortCode: code, deletedAt: null },
    select: { id: true, authorId: true, createdAt: true, parentId: true, chemicals: { select: { casNumber: true } } },
  })
}

// ── GET /api/posts/:code ──────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params

  // Read-tier rate limit (per-user for sessions, IP-keyed for anonymous).
  const identity = await resolveIdentity()
  const limited = checkRateLimit(identity, 'read')
  if (limited) return limited

  const userId = identity.authenticated && identity.user ? identity.user.id : null

  const post = await prisma.post.findFirst({
    where: { shortCode: code, deletedAt: null },
    include: postInclude(userId),
  })
  if (!post) return jsonError(404, 'not_found', 'Post not found.')
  return Response.json(serializePost(post))
}

// ── PATCH /api/posts/:code (edit) ─────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!
  const post = await findPostByCode(code)
  if (!post) return jsonError(404, 'not_found', 'Post not found.')
  if (post.authorId !== user.id) return jsonError(403, 'forbidden', 'You can only edit your own posts.')

  const elapsed = Date.now() - new Date(post.createdAt).getTime()
  if (elapsed > EDIT_WINDOW_MS) return jsonError(403, 'forbidden', 'Edit window has expired.')

  const body = await request.json().catch(() => null)
  if (!body) return jsonError(400, 'bad_request', 'Invalid JSON.')

  const content = typeof body.content === 'string' ? body.content.trim() : ''
  const keepImages = Array.isArray(body.images)
    ? body.images.filter((u: unknown) => typeof u === 'string' && u.startsWith('/uploads/')).slice(0, MAX_IMAGES)
    : []
  const casNumbers = Array.isArray(body.casNumbers) ? body.casNumbers : null

  if (!content && keepImages.length === 0) return jsonError(400, 'bad_request', 'Content is required.')
  const limit = maxPostLength(user)
  if (content.length > limit) return jsonError(400, 'bad_request', `Content too long (max ${limit} characters).`)

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.post.update({
      where: { id: post.id },
      data: { content, images: keepImages, editedAt: new Date() },
      include: postInclude(user.id),
    })

    if (casNumbers) {
      const validCas = casNumbers.filter((c: unknown) => typeof c === 'string' && CAS_FORMAT.test(c))
      const oldCas = result.chemicals.map((c) => c.casNumber)
      const newSet = new Set(validCas)
      const oldSet = new Set(oldCas)
      const toAdd = validCas.filter((c: string) => !oldSet.has(c))
      const toRemove = oldCas.filter((c) => !newSet.has(c))

      for (const casNumber of toAdd) {
        await tx.chemical.upsert({ where: { casNumber }, create: { casNumber }, update: {} })
      }
      await tx.post.update({
        where: { id: post.id },
        data: { chemicals: { set: validCas.map((c: string) => ({ casNumber: c })) } },
      })
      for (const casNumber of toAdd) {
        await tx.chemical.update({ where: { casNumber }, data: { postCount: { increment: 1 } } })
      }
      for (const casNumber of toRemove) {
        await tx.chemical.update({ where: { casNumber }, data: { postCount: { decrement: 1 } } })
      }
    }

    return result
  })

  return Response.json(serializePost(updated))
}

// ── DELETE /api/posts/:code (soft-delete) ─────────────────────

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const user = auth.identity.user!
  const post = await findPostByCode(code)
  if (!post) return jsonError(404, 'not_found', 'Post not found.')
  if (post.authorId !== user.id && user.role !== 'admin') {
    return jsonError(403, 'forbidden', 'You can only delete your own posts.')
  }

  await prisma.$transaction(async (tx) => {
    await tx.post.update({
      where: { id: post.id },
      data: { deletedAt: new Date(), content: '', images: [], chemicals: { set: [] } },
    })
    if (post.parentId) {
      await tx.post.update({ where: { id: post.parentId }, data: { replyCount: { decrement: 1 } } })
    }
    await tx.user.update({ where: { id: post.authorId }, data: { postCount: { decrement: 1 } } })
    for (const chem of post.chemicals) {
      await tx.chemical.update({ where: { casNumber: chem.casNumber }, data: { postCount: { decrement: 1 } } })
    }
  })

  return Response.json({ success: true })
}
