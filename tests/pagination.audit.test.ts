import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { dropTestDatabase, provisionTestDatabase, sql } from './helpers/db'
import { TEST_DATABASE_URL } from './helpers/env'

vi.mock('server-only', () => ({}))
const db = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => db)
let pool: Pool
let search: typeof import('@/lib/services/search.service')
let posts: typeof import('@/lib/services/post-core.service')

beforeAll(async () => {
  await provisionTestDatabase()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  pool = new Pool({ connectionString: TEST_DATABASE_URL })
  db.prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  search = await import('@/lib/services/search.service')
  posts = await import('@/lib/services/post-core.service')
  await sql(`INSERT INTO "User" (id, email, username, "passwordHash", "createdAt", "updatedAt")
    VALUES ('pagination_author', 'pagination@example.test', 'pagination_author', 'x', now(), now())`)
  await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", content, images, "createdAt", "updatedAt")
    SELECT 'pid_' || g, 'page' || g, 'pagination_author', 'pagination post', '{}'::text[],
      now() - g * interval '1 second', now() FROM generate_series(1, 3) g`)
  await sql(`INSERT INTO "Chemical" (id, "casNumber", "postCount", "createdAt", "updatedAt")
    VALUES ('pagination_chemical', '64-17-5', 3, now(), now())`)
  await sql(`INSERT INTO "_ChemicalToPost" ("A", "B")
    SELECT 'pagination_chemical', id FROM "Post"`)
})

afterAll(async () => {
  await db.prisma?.$disconnect()
  await pool?.end()
  await dropTestDatabase()
})

describe('pagination query boundaries', () => {
  it.each(['2026-13-29T00:00:00.000Z', '2026-02-30T00:00:00.000Z'])(
    'rejects invalid calendar cursor %s before querying PostgreSQL', async (date) => {
      const page = await search.searchPostsAfterCursor('pagination', undefined, `${date}|pid_1`)
      expect(page).toEqual({ posts: [], nextCursor: null })
    },
  )

  it('normalizes fractional timeline sizes before Prisma queries', async () => {
    const page = await posts.getTimelinePage({ tab: 'latest', author: 'pagination_author', take: 1.9 })
    expect(page.posts).toHaveLength(1)
    expect(page.nextCursor).toBeTruthy()
  })

  it.each(['pagination', '64-17-5'])('normalizes fractional search sizes for %s', async (query) => {
    const first = await search.searchPostsFirstPage(query, undefined, 1.9)
    expect(first.posts).toHaveLength(1)
    expect(first.nextCursor).toBeTruthy()
    const second = await search.searchPostsAfterCursor(query, undefined, first.nextCursor!, 1.9)
    expect(second.posts).toHaveLength(1)
    expect(second.posts[0].id).not.toBe(first.posts[0].id)
  })

  it('paginates ancestor chains with cursor across soft-deleted boundary posts', async () => {
    // Seed 25-deep thread: chain_a0 -> chain_a1 -> ... -> chain_a25
    await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", content, images, "createdAt", "updatedAt")
      VALUES ('chain_a0', 'sc_ch0', 'pagination_author', 'Root post', '{}'::text[], now() - interval '2 hours', now())`)

    let prev = 'chain_a0'
    for (let i = 1; i <= 25; i++) {
      const id = `chain_a${i}`
      await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", "parentId", content, images, "createdAt", "updatedAt")
        VALUES ($1, $2, 'pagination_author', $3, $4, '{}'::text[], now() - interval '2 hours' + $5 * interval '10s', now())`,
        [id, `sc_ch${i}`, prev, `Post ${i}`, i])
      prev = id
    }

    // Soft-delete nodes 17, 16 (boundary), 15, 14
    await sql(`UPDATE "Post" SET "deletedAt" = now(), content = '' WHERE id IN ('chain_a17', 'chain_a16', 'chain_a15', 'chain_a14')`)

    // Page 1: target is chain_a25, take 10
    const page1 = await posts.getPostChain('chain_a25', null, null, { limit: 10 })
    expect(page1.ancestors).toHaveLength(10)
    expect(page1.hasMoreAncestors).toBe(true)
    expect(page1.oldestAncestorId).toBe('chain_a15')
    expect(page1.nextAncestorCursor).toBeTruthy()
    expect(page1.nextAncestorCursor).not.toBe('chain_a15') // Cryptographically signed opaque token

    // Reject raw ID bypass
    await expect(posts.getPostChain('chain_a25', null, null, { limit: 10, cursor: 'chain_a15' }))
      .rejects.toThrow('Malformed ancestor cursor')

    // Reject cross-discussion reuse (cursor signed for chain_a25 used on another post)
    await expect(posts.getPostChain('chain_a10', null, null, { limit: 10, cursor: page1.nextAncestorCursor }))
      .rejects.toThrow('does not belong to the requested target post')

    // Reject tampered cursor signature
    const tampered = Buffer.from('chain_a25:chain_a15:tampered_signature').toString('base64url')
    await expect(posts.getPostChain('chain_a25', null, null, { limit: 10, cursor: tampered }))
      .rejects.toThrow('Invalid or tampered ancestor cursor signature')

    // Page 2: continue from page1.nextAncestorCursor
    const page2 = await posts.getPostChain('chain_a25', null, null, { limit: 10, cursor: page1.nextAncestorCursor })
    expect(page2.ancestors).toHaveLength(10)
    expect(page2.hasMoreAncestors).toBe(true)
    expect(page2.nextAncestorCursor).toBeTruthy()
    expect(page2.nextAncestorCursor).not.toBe('chain_a5')

    // Page 3: continue to root
    const page3 = await posts.getPostChain('chain_a25', null, null, { limit: 10, cursor: page2.nextAncestorCursor })
    expect(page3.ancestors.length).toBeGreaterThanOrEqual(1)
    expect(page3.hasMoreAncestors).toBe(false)
    expect(page3.nextAncestorCursor).toBeNull()
    expect(page3.ancestors[0].id).toBe('chain_a0') // Reached root

    // Total assembled ancestors: page3 + page2 + page1
    const total = [...page3.ancestors, ...page2.ancestors, ...page1.ancestors]
    expect(total).toHaveLength(25) // all 25 ancestors of chain_a25 (a0 through a24)
    const totalIds = total.map((p) => p.id)
    const expected = Array.from({ length: 25 }, (_, i) => `chain_a${i}`)
    expect(totalIds).toEqual(expected)
  })
})
