/**
 * /api/posts
 *
 * GET   — read timeline / feed (list posts)
 * POST  — create post / reply / quote
 *
 * GET Auth: optional (API Key, Session, or anonymous).
 *   Query params mirror `getTimelinePage`:
 *   tab (latest|following|foryou), cursor, take, cas, author, scope
 *   (replies|media), likedBy, bookmarkedBy, repliesOf, conversationOf,
 *   since. Returns { posts, nextCursor }.
 *
 * POST Auth: API Key or Session.
 *   Body (JSON): { content, parentId?, quotePostId?, casNumbers?, images? }
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { postInclude, serializePost } from '@/lib/serialize'
import { requireWrite, resolveIdentity } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { maxPostLength } from '@/lib/permissions'
import { generateShortCode } from '@/lib/shortCode'
import { upsertNotification } from '@/lib/notification'
import { getTimelinePage } from '@/lib/services/post.service'
import { extractCASNumber, extractMentions } from '@/lib/utils'

const MAX_IMAGES = 4
const CAS_FORMAT = /^\d{2,7}-\d{2}-\d$/

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

// ── GET /api/posts — read timeline / feed ────────────────────

export async function GET(request: NextRequest) {
  const identity = await resolveIdentity()
  const limited = checkRateLimit(identity, 'read')
  if (limited) return limited

  const sp = request.nextUrl.searchParams

  const tabRaw = sp.get('tab')
  const tab =
    tabRaw === 'following' || tabRaw === 'foryou' ? tabRaw : 'latest'

  const cursor = sp.get('cursor') ?? undefined
  const takeRaw = Number(sp.get('take'))
  const take = Number.isFinite(takeRaw) && takeRaw > 0 ? takeRaw : undefined

  const scopeRaw = sp.get('scope')
  const scope = scopeRaw === 'replies' || scopeRaw === 'media' ? scopeRaw : undefined

  const page = await getTimelinePage({
    tab,
    cursor,
    take,
    userId: identity.user?.id ?? null,
    cas: sp.get('cas') ?? undefined,
    author: sp.get('author') ?? undefined,
    scope,
    likedBy: sp.get('likedBy') ?? undefined,
    bookmarkedBy: sp.get('bookmarkedBy') ?? undefined,
    repliesOf: sp.get('repliesOf') ?? undefined,
    conversationOf: sp.get('conversationOf') ?? undefined,
    since: sp.get('since') ?? undefined,
  })

  return Response.json({ posts: page.posts, nextCursor: page.nextCursor })
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
