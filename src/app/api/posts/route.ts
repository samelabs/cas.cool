/**
 * POST /api/posts          — create post / reply / quote
 *
 * Auth: API Key or Session.
 * Body (JSON): { content, parentId?, quotePostId?, casNumbers?, images? }
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { postInclude, serializePost } from '@/lib/serialize'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { maxPostLength } from '@/lib/permissions'
import { generateShortCode } from '@/lib/shortCode'
import { upsertNotification } from '@/lib/notification'
import { extractCASNumber, extractMentions } from '@/lib/utils'

const MAX_IMAGES = 4
const CAS_FORMAT = /^\d{2,7}-\d{2}-\d$/

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(request: NextRequest) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError(400, 'bad_request', 'Invalid JSON.')

  const user = auth.identity.user!
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null
  const quotePostId = typeof body.quotePostId === 'string' && body.quotePostId ? body.quotePostId : null

  if (!content && !quotePostId) return jsonError(400, 'bad_request', 'Content is required.')
  if (!content && quotePostId) return jsonError(400, 'bad_request', 'Quote posts require text.')

  const limit = maxPostLength(user)
  if (content.length > limit) return jsonError(400, 'bad_request', `Content too long (max ${limit} characters).`)

  const imageUrls = Array.isArray(body.images)
    ? body.images.filter((u: unknown) => typeof u === 'string' && u.startsWith('/uploads/')).slice(0, MAX_IMAGES)
    : []

  // Parent + conversation resolution
  let conversationId: string | null = null
  if (parentId) {
    const parent = await prisma.post.findFirst({
      where: { id: parentId, deletedAt: null },
      select: { id: true, conversationId: true },
    })
    if (!parent) return jsonError(404, 'not_found', 'Parent post not found.')
    conversationId = parent.conversationId ?? parent.id
  }

  // Quote validation
  if (quotePostId) {
    const quoted = await prisma.post.findFirst({
      where: { id: quotePostId, deletedAt: null },
      select: { id: true },
    })
    if (!quoted) return jsonError(404, 'not_found', 'Quoted post not found.')
  }

  // CAS numbers: manual + auto-extracted
  const allCas = new Set<string>()
  const providedCas = Array.isArray(body.casNumbers)
    ? body.casNumbers.filter((c: unknown) => typeof c === 'string')
    : typeof body.casNumbers === 'string'
      ? body.casNumbers.split(',')
      : []
  for (const cas of providedCas) {
    if (CAS_FORMAT.test(cas.trim())) allCas.add(cas.trim())
  }
  const extracted = extractCASNumber(content)
  if (extracted) allCas.add(extracted)

  const post = await prisma.$transaction(async (tx) => {
    const chemicalConnect: { casNumber: string }[] = []
    for (const casNumber of allCas) {
      await tx.chemical.upsert({ where: { casNumber }, create: { casNumber }, update: {} })
      chemicalConnect.push({ casNumber })
    }

    const created = await tx.post.create({
      data: {
        authorId: user.id,
        parentId,
        conversationId,
        quotePostId,
        content,
        images: imageUrls,
        shortCode: generateShortCode(),
        chemicals: { connect: chemicalConnect },
      },
      include: postInclude(user.id),
    })

    for (const casNumber of allCas) {
      await tx.chemical.update({ where: { casNumber }, data: { postCount: { increment: 1 } } })
    }
    if (parentId) {
      await tx.post.update({ where: { id: parentId }, data: { replyCount: { increment: 1 } } })
    }
    await tx.user.update({ where: { id: user.id }, data: { postCount: { increment: 1 } } })
    return created
  })

  // Notifications
  if (parentId) {
    const parent = await prisma.post.findUnique({ where: { id: parentId }, select: { authorId: true } })
    if (parent && parent.authorId !== user.id) {
      await upsertNotification({ userId: parent.authorId, fromId: user.id, type: 'COMMENT', postId: parentId })
    }
  }
  if (quotePostId) {
    const quoted = await prisma.post.findUnique({ where: { id: quotePostId }, select: { authorId: true } })
    if (quoted && quoted.authorId !== user.id) {
      await upsertNotification({ userId: quoted.authorId, fromId: user.id, type: 'REPOST', postId: post.id })
    }
  }
  if (content) {
    const usernames = extractMentions(content)
    if (usernames.length > 0) {
      const mentioned = await prisma.user.findMany({ where: { username: { in: usernames } }, select: { id: true } })
      for (const u of mentioned) {
        if (u.id !== user.id) {
          await upsertNotification({ userId: u.id, fromId: user.id, type: 'MENTION', postId: post.id })
        }
      }
    }
  }

  return Response.json(serializePost(post), { status: 201 })
}
