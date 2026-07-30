/**
 * Search service — first-page prefetch for SSR.
 * Mirrors the two-step UNION query used in the Server Action,
 * keeping trgm indexes usable.
 */

import { prisma } from '@/lib/db'
import { postInclude, serializePost, userSelect, serializeUsers } from '@/lib/serialize'
import { FEED_PAGE_SIZE } from '@/lib/feed'
import type { SafePost, SafeUser } from '@/lib/types'

export interface SearchFirstPage {
  posts: SafePost[]
  nextCursor: string | null
  users?: SafeUser[]
  chemicals?: Array<{ casNumber: string; name: string | null; postCount: number }>
}

/**
 * SSR search — first page only. Uses the same two-step UNION query as the
 * Server Action to keep trgm indexes usable.
 *
 * For client-side pagination, the Server Action calls this same function.
 */
export async function searchPostsFirstPage(
  query: string,
  currentUserId?: string | null,
  limit?: number,
): Promise<SearchFirstPage> {
  const q = query.trim()
  if (q.length < 2) return { posts: [], nextCursor: null }

  const take = Math.min(Math.max(limit ?? FEED_PAGE_SIZE, 1), 50)
  const isCasLike = /[\d-]/.test(q) && q.replace(/[^0-9-]/g, '').length >= 3

  // Two-step: UNION of content ILIKE + CAS join
  const branches: string[] = [`
    SELECT p.id, p."createdAt"
    FROM "Post" p
    WHERE p."parentId" IS NULL
      AND p.content ILIKE ${'$1'}
    ORDER BY p."createdAt" DESC, p.id DESC
    LIMIT ${take}
  `]

  const params: unknown[] = [`%${q}%`]

  if (isCasLike) {
    branches.push(`
      SELECT p.id, p."createdAt"
      FROM "Post" p
      JOIN "_ChemicalToPost" cp ON cp."B" = p.id
      JOIN "Chemical" c ON c.id = cp."A"
      WHERE p."parentId" IS NULL
        AND c."casNumber" ILIKE ${'$2'}
      ORDER BY p."createdAt" DESC, p.id DESC
      LIMIT ${take}
    `)
    params.push(`%${q}%`)
  }

  const unionSQL = `
    SELECT id FROM (
      ${branches.map(b => `(${b})`).join('\n        UNION\n        ')}
    ) sub
    ORDER BY "createdAt" DESC, id DESC
    LIMIT ${take}
  `

  const idRows = await prisma.$queryRawUnsafe<{ id: string }[]>(unionSQL, ...params)
  const ids = (idRows as { id: string }[]).map((r) => r.id)

  const posts = ids.length > 0
    ? await prisma.post.findMany({
        where: { id: { in: ids }, deletedAt: null },
        include: postInclude(currentUserId ?? undefined),
      }).then((rows) => {
        const orderMap = new Map(ids.map((id, i) => [id, i]))
        return rows.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0))
      })
    : []

  const nextCursor =
    posts.length >= take && posts.length > 0
      ? `${posts[posts.length - 1].createdAt.toISOString()}|${posts[posts.length - 1].id}`
      : null

  return {
    posts: posts.map(serializePost),
    nextCursor,
  }
}

/**
 * Search suggestions — users + chemicals (first page only, no cursor).
 */
export async function getSearchSuggestions(
  query: string,
): Promise<{ users: SafeUser[]; chemicals: Array<{ casNumber: string; name: string | null; postCount: number }> }> {
  const q = query.trim()
  if (q.length < 3 || !/[a-z]/i.test(q)) {
    return { users: [], chemicals: [] }
  }

  const isCasLike = /[\d-]/.test(q) && q.replace(/[^0-9-]/g, '').length >= 3

  const [users, chemicals] = await Promise.all([
    prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: userSelect,
      orderBy: { followerCount: 'desc' },
      take: 5,
    }).then(serializeUsers).catch(() => []),
    isCasLike
      ? prisma.chemical.findMany({
          where: {
            postCount: { gt: 0 },
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { casNumber: { contains: q } },
            ],
          },
          select: { casNumber: true, name: true, postCount: true },
          orderBy: { postCount: 'desc' },
          take: 5,
        }).catch(() => [])
      : Promise.resolve([]),
  ])

  return { users, chemicals }
}

/**
 * Matching chemicals for search entry-points (used by explore page).
 */
export async function getMatchingChemicals(
  query: string,
  limit: number = 5,
): Promise<Array<{ casNumber: string; name: string | null; postCount: number }>> {
  const q = query.trim()
  const isCasLike = /[\d-]/.test(q) && q.replace(/[^0-9-]/g, '').length >= 3
  if (!isCasLike && !/[a-z]/i.test(q)) return []

  return prisma.chemical.findMany({
    where: {
      postCount: { gt: 0 },
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        ...(isCasLike ? [{ casNumber: { contains: q } }] : []),
      ],
    },
    select: { casNumber: true, name: true, postCount: true },
    orderBy: { postCount: 'desc' },
    take: limit,
  }).catch(() => [])
}
