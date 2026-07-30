import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Prisma } from '@prisma/client'
import type { ApiUser } from './auth'
import { prisma } from './db'
import {
  applyCursor,
  extractCasNumbers,
  extractMentions,
  generateShortCode,
  nextCursor,
  parseTake,
  postInclude,
  serializePost,
  upsertNotification,
  userSelect,
} from './domain'
import { HttpError, json, readJson } from './http'
import { config } from './config'

interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  user: ApiUser
}

type RouteHandler = (context: RouteContext, params: Record<string, string>) => Promise<void>

interface Route {
  method: string
  pattern: RegExp
  parameterNames: string[]
  handler: RouteHandler
}

const routes: Route[] = []

function route(method: string, path: string, handler: RouteHandler): void {
  const parameterNames: string[] = []
  const pattern = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return escapeRegExp(segment)
      parameterNames.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  routes.push({ method, pattern: new RegExp(`^${pattern}/?$`), parameterNames, handler })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function resolveRoute(
  method: string,
  pathname: string,
): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const candidate of routes) {
    if (candidate.method !== method) continue
    const match = candidate.pattern.exec(pathname)
    if (!match) continue
    const params: Record<string, string> = {}
    candidate.parameterNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1])
    })
    return { handler: candidate.handler, params }
  }
  return null
}

route('GET', '/api/v1/me', async ({ res, user }) => {
  const apiKey = await prisma.apiKey.findUnique({
    where: { id: user.apiKeyId },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, expiresAt: true },
  })
  json(res, 200, {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    verificationStatus: user.verificationStatus,
    status: user.status,
    role: user.role,
    apiKey: apiKey
      ? {
          id: apiKey.id,
          name: apiKey.name,
          prefix: apiKey.prefix,
          createdAt: apiKey.createdAt,
          lastUsedAt: apiKey.lastUsedAt,
          expiresAt: apiKey.expiresAt,
        }
      : null,
    profileUrl: `https://cas.cool/u/${user.username}`,
  })
})

route('GET', '/api/v1/timeline', async ({ res, url, user }) => {
  const take = parseTake(url.searchParams.get('take'))
  const where: Prisma.PostWhereInput = { parentId: null, deletedAt: null }
  applyCursor(where, url.searchParams.get('cursor'))
  const posts = await prisma.post.findMany({
    where,
    include: postInclude(user.id),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })
  json(res, 200, { posts: posts.map(serializePost), nextCursor: nextCursor(posts, take) })
})

route('GET', '/api/v1/search', async ({ res, url, user }) => {
  const query = (url.searchParams.get('q') || '').trim()
  if (query.length < 2) return json(res, 200, { posts: [], nextCursor: null })
  if (query.length > 200) throw new HttpError(400, 'bad_request', 'Query too long (max 200 characters).')

  const take = parseTake(url.searchParams.get('take'))
  const isCasLike = /[\d-]/.test(query) && query.replace(/[^0-9-]/g, '').length >= 3
  const where: Prisma.PostWhereInput = {
    parentId: null,
    deletedAt: null,
    OR: [
      { content: { contains: query, mode: 'insensitive' } },
      ...(isCasLike ? [{ chemicals: { some: { casNumber: { contains: query } } } }] : []),
    ],
  }
  applyCursor(where, url.searchParams.get('cursor'))
  const posts = await prisma.post.findMany({
    where,
    include: postInclude(user.id),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })
  json(res, 200, { posts: posts.map(serializePost), nextCursor: nextCursor(posts, take) })
})

route('GET', '/api/v1/posts/:code', async ({ res, user }, { code }) => {
  const post = await findPostByCode(code, user.id)
  if (!post) throw new HttpError(404, 'not_found', 'Post not found.')
  json(res, 200, serializePost(post))
})

route('POST', '/api/v1/posts', async ({ req, res, user }) => {
  const raw = await readJson(req, config.bodyLimitBytes)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'bad_request', 'Request body must be valid JSON.')
  }
  const body = raw as Record<string, unknown>
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null
  const quotePostId = typeof body.quotePostId === 'string' && body.quotePostId ? body.quotePostId : null

  if (!content) throw new HttpError(400, 'bad_request', 'Content is required.')
  if (content.length > 2000) throw new HttpError(400, 'bad_request', 'Content too long (max 2000 characters).')

  let conversationId: string | null = null
  if (parentId) {
    const parent = await prisma.post.findFirst({
      where: { id: parentId, deletedAt: null },
      select: { id: true, conversationId: true },
    })
    if (!parent) throw new HttpError(404, 'not_found', 'Parent post not found.')
    conversationId = parent.conversationId ?? parent.id
  }
  if (quotePostId) {
    const quoted = await prisma.post.findFirst({
      where: { id: quotePostId, deletedAt: null },
      select: { id: true },
    })
    if (!quoted) throw new HttpError(404, 'not_found', 'Quoted post not found.')
  }

  const provided = Array.isArray(body.casNumbers)
    ? body.casNumbers.filter((value): value is string => typeof value === 'string')
    : typeof body.casNumbers === 'string'
      ? body.casNumbers.split(',')
      : []
  const casNumbers = new Set(
    [...provided.map((value) => value.trim()), ...extractCasNumbers(content)].filter((value) => /^\d{2,7}-\d{2}-\d$/.test(value)),
  )

  const post = await prisma.$transaction(async (tx) => {
    const connect: { casNumber: string }[] = []
    for (const casNumber of casNumbers) {
      await tx.chemical.upsert({ where: { casNumber }, create: { casNumber }, update: {} })
      connect.push({ casNumber })
    }

    const created = await tx.post.create({
      data: {
        authorId: user.id,
        parentId,
        conversationId,
        quotePostId,
        content,
        images: [],
        shortCode: generateShortCode(),
        chemicals: { connect },
      },
      include: postInclude(user.id),
    })

    for (const casNumber of casNumbers) {
      await tx.chemical.update({ where: { casNumber }, data: { postCount: { increment: 1 } } })
    }
    if (parentId) {
      await tx.post.update({ where: { id: parentId }, data: { replyCount: { increment: 1 } } })
    }
    // Maintain denormalized User.postCount (parity with BFF).
    await tx.user.update({ where: { id: user.id }, data: { postCount: { increment: 1 } } })
    return created
  })

  await createPostNotifications({ userId: user.id, content, parentId, quotePostId, postId: post.id })
  json(res, 201, serializePost(post))
})

route('POST', '/api/v1/posts/:code/like', async ({ res, user }, { code }) => {
  const post = await prisma.post.findFirst({
    where: { shortCode: code, deletedAt: null },
    select: { id: true, authorId: true },
  })
  if (!post) throw new HttpError(404, 'not_found', 'Post not found.')
  const existing = await prisma.like.findUnique({ where: { postId_userId: { postId: post.id, userId: user.id } } })
  if (!existing) {
    try {
      await prisma.$transaction([
        prisma.like.create({ data: { postId: post.id, userId: user.id } }),
        prisma.post.update({ where: { id: post.id }, data: { likeCount: { increment: 1 } } }),
      ])
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
    }
    if (post.authorId !== user.id) {
      await upsertNotification({ userId: post.authorId, fromId: user.id, type: 'LIKE', postId: post.id })
    }
  }
  json(res, existing ? 200 : 201, { liked: true })
})

route('DELETE', '/api/v1/posts/:code/like', async ({ res, user }, { code }) => {
  const post = await findPostId(code)
  await prisma.$transaction(async (tx) => {
    const deleted = await tx.like.deleteMany({ where: { postId: post.id, userId: user.id } })
    if (deleted.count > 0) {
      await tx.post.update({ where: { id: post.id }, data: { likeCount: { decrement: deleted.count } } })
    }
  })
  json(res, 200, { liked: false })
})

route('POST', '/api/v1/posts/:code/bookmark', async ({ res, user }, { code }) => {
  const post = await findPostId(code)
  const existing = await prisma.bookmark.findUnique({ where: { postId_userId: { postId: post.id, userId: user.id } } })
  if (!existing) {
    try {
      await prisma.$transaction([
        prisma.bookmark.create({ data: { postId: post.id, userId: user.id } }),
        prisma.post.update({ where: { id: post.id }, data: { bookmarkCount: { increment: 1 } } }),
      ])
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
    }
  }
  json(res, existing ? 200 : 201, { bookmarked: true })
})

route('DELETE', '/api/v1/posts/:code/bookmark', async ({ res, user }, { code }) => {
  const post = await findPostId(code)
  await prisma.$transaction(async (tx) => {
    const deleted = await tx.bookmark.deleteMany({ where: { postId: post.id, userId: user.id } })
    if (deleted.count > 0) {
      await tx.post.update({ where: { id: post.id }, data: { bookmarkCount: { decrement: deleted.count } } })
    }
  })
  json(res, 200, { bookmarked: false })
})

route('GET', '/api/v1/users/:username', async ({ res }, { username }) => {
  const user = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: userSelect(),
  })
  if (!user) throw new HttpError(404, 'not_found', 'User not found.')
  json(res, 200, {
    ...user,
    _count: {
      posts: user.postCount,
      followers: user.followerCount,
      following: user.followingCount,
    },
  })
})

route('GET', '/api/v1/users/:username/posts', async ({ res, url, user }, { username }) => {
  const target = await prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true } })
  if (!target) throw new HttpError(404, 'not_found', 'User not found.')

  const take = parseTake(url.searchParams.get('take'))
  const scope = url.searchParams.get('scope')
  const where: Prisma.PostWhereInput = { authorId: target.id, deletedAt: null, parentId: null }
  if (scope === 'replies') where.parentId = { not: null }
  if (scope === 'media') where.NOT = { images: { isEmpty: true } }
  applyCursor(where, url.searchParams.get('cursor'))
  const posts = await prisma.post.findMany({
    where,
    include: postInclude(user.id),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })
  json(res, 200, { posts: posts.map(serializePost), nextCursor: nextCursor(posts, take) })
})

route('POST', '/api/v1/users/:username/follow', async ({ res, user }, { username }) => {
  const target = await findUserId(username)
  if (target.id === user.id) throw new HttpError(400, 'bad_request', 'You cannot follow yourself.')
  const existing = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: user.id, followingId: target.id } },
  })
  if (!existing) {
    try {
      await prisma.$transaction([
        prisma.follow.create({ data: { followerId: user.id, followingId: target.id } }),
        prisma.user.update({ where: { id: user.id }, data: { followingCount: { increment: 1 } } }),
        prisma.user.update({ where: { id: target.id }, data: { followerCount: { increment: 1 } } }),
      ])
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
    }
    await upsertNotification({ userId: target.id, fromId: user.id, type: 'FOLLOW' })
  }
  json(res, existing ? 200 : 201, { following: true })
})

route('DELETE', '/api/v1/users/:username/follow', async ({ res, user }, { username }) => {
  const target = await findUserId(username)
  await prisma.$transaction(async (tx) => {
    const deleted = await tx.follow.deleteMany({ where: { followerId: user.id, followingId: target.id } })
    if (deleted.count > 0) {
      await tx.user.update({ where: { id: user.id }, data: { followingCount: { decrement: 1 } } })
      await tx.user.update({ where: { id: target.id }, data: { followerCount: { decrement: 1 } } })
    }
  })
  json(res, 200, { following: false })
})

async function findPostByCode(code: string, userId: string) {
  return prisma.post.findFirst({
    where: { shortCode: code, deletedAt: null },
    include: postInclude(userId),
  })
}

async function findPostId(code: string): Promise<{ id: string }> {
  const post = await prisma.post.findFirst({ where: { shortCode: code, deletedAt: null }, select: { id: true } })
  if (!post) throw new HttpError(404, 'not_found', 'Post not found.')
  return post
}

async function findUserId(username: string): Promise<{ id: string }> {
  const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true } })
  if (!user) throw new HttpError(404, 'not_found', 'User not found.')
  return user
}

async function createPostNotifications(params: {
  userId: string
  content: string
  parentId: string | null
  quotePostId: string | null
  postId: string
}): Promise<void> {
  if (params.parentId) {
    const parent = await prisma.post.findUnique({ where: { id: params.parentId }, select: { authorId: true } })
    if (parent && parent.authorId !== params.userId) {
      await upsertNotification({ userId: parent.authorId, fromId: params.userId, type: 'COMMENT', postId: params.parentId })
    }
  }
  if (params.quotePostId) {
    const quoted = await prisma.post.findUnique({ where: { id: params.quotePostId }, select: { authorId: true } })
    if (quoted && quoted.authorId !== params.userId) {
      await upsertNotification({ userId: quoted.authorId, fromId: params.userId, type: 'REPOST', postId: params.postId })
    }
  }
  const mentions = extractMentions(params.content)
  if (mentions.length > 0) {
    const users = await prisma.user.findMany({ where: { username: { in: mentions } }, select: { id: true } })
    for (const mentioned of users) {
      if (mentioned.id !== params.userId) {
        await upsertNotification({ userId: mentioned.id, fromId: params.userId, type: 'MENTION', postId: params.postId })
      }
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'P2002'
}
