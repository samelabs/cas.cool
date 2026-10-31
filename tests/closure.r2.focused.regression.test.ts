// Focused regression suite for R2 closure fixes:
// 1. Reversed asset arrays concurrency without deadlock (canonical resource ordering)
// 2. Upload asset URL alias rejection & canonical reference protection
// 3. Idempotent reply & quote recovery after parent/quote tombstone
import { beforeAll, afterAll, it, expect, vi } from 'vitest'
import { Pool } from 'pg'
import type { PrismaClient, Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { provisionTestDatabase, dropTestDatabase, sql } from './helpers/db'
import { TEST_DATABASE_URL, TEST_UPLOAD_DIR } from './helpers/env'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (f: unknown) => f }))
const db = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => db)
let pool: Pool
const files: string[] = []
const a = { id: 'cx_r2_a', role: 'user', verificationStatus: 'verified' }
const b = { ...a, id: 'cx_r2_b' }

beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(TEST_DATABASE_URL).hostname)) throw Error('Local only')
  await provisionTestDatabase()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 })
  db.prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  await sql(`INSERT INTO "User" (id,email,username,"passwordHash","verificationStatus","createdAt","updatedAt") VALUES
    ('cx_r2_a','cx_r2_a@test.local','cx_r2_a','x','verified',now(),now()),
    ('cx_r2_b','cx_r2_b@test.local','cx_r2_b','x','verified',now(),now())`)
})

afterAll(async () => {
  vi.restoreAllMocks()
  await db.prisma?.$disconnect()
  await pool?.end()
  await dropTestDatabase()
  for (const f of files) await rm(f, { force: true })
})

async function publicFile() {
  const name = randomUUID() + '.webp'
  // The suite's configured public root (helpers/env.ts) — the same physical
  // directory assertUploadAssetsAvailable resolves by default.
  const file = path.join(TEST_UPLOAD_DIR, name)
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#008800' } }).webp().toBuffer()
  await writeFile(file, bytes)
  files.push(file)
  return { name, url: '/uploads/' + name }
}

// ── 1. Reversed asset arrays concurrency without deadlock ──────

it('reversed asset arrays acquire locks in canonical order and both succeed without deadlock', async () => {
  const f = await publicFile()
  const g = await publicFile()
  const { assertUploadAssetsAvailable } = await import('@/lib/upload-lifecycle')

  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })

  const executedKeys1: number[] = []
  const executedKeys2: number[] = []

  const attempt = (urls: string[], recordedKeys: number[]) =>
    db.prisma.$transaction(async (tx) => {
      let first = true
      const gated = new Proxy(tx, {
        get(target, key) {
          if (key === '$executeRaw') {
            return async (...args: unknown[]) => {
              if (first) {
                first = false
                if (++arrived === 2) release()
                await gate
              }
              const val = (args[0] as { values?: unknown[] })?.values?.[1] ?? args[2] ?? args[1]
              if (val !== undefined) {
                recordedKeys.push(Number(val))
              }
              return Reflect.apply(target.$executeRaw, target, args)
            }
          }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Prisma.TransactionClient

      await assertUploadAssetsAvailable(gated, urls)
    })

  // Concurrently run opposite order arrays: [f, g] and [g, f]
  const results = await Promise.allSettled([
    attempt([f.url, g.url], executedKeys1),
    attempt([g.url, f.url], executedKeys2),
  ])

  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
  expect(failed).toHaveLength(0)
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true)

  // Assert both transactions executed locks in the exact same numerically ascending order
  expect(executedKeys1).toHaveLength(2)
  expect(executedKeys2).toHaveLength(2)
  expect(executedKeys1).toEqual(executedKeys2)
  expect(executedKeys1[0]).toBeLessThan(executedKeys1[1])
})

it('duplicate URLs and redundant references in asset array are deduplicated before locking', async () => {
  const f = await publicFile()
  const { assertUploadAssetsAvailable } = await import('@/lib/upload-lifecycle')

  const executedLocks: number[] = []

  await db.prisma.$transaction(async (tx) => {
    const trackedTx = new Proxy(tx, {
      get(target, key) {
        if (key === '$executeRaw') {
          return async (...args: unknown[]) => {
            const val = (args[0] as { values?: unknown[] })?.values?.[1] ?? args[2] ?? args[1]
            if (val !== undefined) {
              executedLocks.push(Number(val))
            }
            return Reflect.apply(target.$executeRaw, target, args)
          }
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Prisma.TransactionClient

    await assertUploadAssetsAvailable(trackedTx, [f.url, f.url, f.url])
  })

  // Assert actual lock acquisition count: exactly 1 lock for the deduplicated resource, not 3
  expect(executedLocks).toHaveLength(1)
})

// ── 2. Asset URL alias rejection & reference protection ────────

it('non-canonical URL aliases are rejected before write, and valid reference protects file from cleanup', async () => {
  const f = await publicFile()
  const writes = await import('@/lib/services/post-write.service')

  // Alias with path traversal is rejected at createPost
  const alias = '/uploads/../uploads/' + f.name
  const rejected = await writes.createPost(a, {
    content: 'CODEX R2 alias attempt',
    parentId: null,
    quotePostId: null,
    images: [alias],
    casNumbers: null,
  })
  expect(rejected.ok).toBe(false)
  if (!rejected.ok) {
    expect(rejected.error.status).toBe(400)
    expect(rejected.error.code).toBe('bad_request')
  }

  // Canonical URL is accepted
  const valid = await writes.createPost(a, {
    content: 'CODEX R2 valid canonical reference',
    parentId: null,
    quotePostId: null,
    images: [f.url],
    casNumbers: null,
  })
  expect(valid.ok).toBe(true)

  // Cleanup with canonical URL preserves the file because it is referenced
  const { removeUnreferencedUpload } = await import('@/lib/upload-cleanup')
  await removeUnreferencedUpload(f.url)

  expect(await db.prisma.post.count({ where: { images: { has: f.url } } })).toBe(1)
  expect((await stat(path.join(TEST_UPLOAD_DIR, f.name))).isFile()).toBe(true)
})

// ── 4. Idempotent reply recovery after parent tombstone ─────────

it('idempotent reply recovery returns original reply even after parent is deleted', async () => {
  const writes = await import('@/lib/services/post-write.service')
  const base = { parentId: null, quotePostId: null, images: [], casNumbers: null }

  const parent = await writes.createPost(b, { ...base, content: 'CODEX R2 recovery parent' })
  if (!parent.ok) throw Error('parent fixture failed')

  const input = {
    ...base,
    content: 'CODEX R2 existing reply',
    parentId: parent.data.id,
    idempotency: { requestId: 'cx-r2-existing-reply', contentHash: 'same-original-payload' },
  }

  const first = await writes.createPost(a, input)
  if (!first.ok) throw Error('reply fixture failed')

  // Delete parent post
  expect((await writes.deletePost(b, parent.data.shortCode!)).ok).toBe(true)
  expect((await db.prisma.post.findUnique({ where: { id: first.data.id } }))!.deletedAt).toBeNull()

  // Replaying the exact same request MUST succeed with the original committed reply
  const replayed = await writes.createPost(a, input)
  expect(replayed.ok).toBe(true)
  if (replayed.ok) {
    expect(replayed.replayed).toBe(true)
    expect(replayed.data.id).toBe(first.data.id)
  }

  // A NEW request with a fresh key trying to reply to the deleted parent must be rejected
  const fresh = await writes.createPost(a, {
    ...input,
    idempotency: { requestId: 'cx-r2-new-reply-attempt', contentHash: 'same-original-payload' },
  })
  expect(fresh.ok).toBe(false)
  if (!fresh.ok) {
    expect(fresh.error.status).toBe(404)
    expect(fresh.error.message).toBe('Parent post not found.')
  }
})

it('idempotent quote recovery returns original quote even after quoted post is deleted', async () => {
  const writes = await import('@/lib/services/post-write.service')
  const base = { parentId: null, quotePostId: null, images: [], casNumbers: null }

  const quoted = await writes.createPost(b, { ...base, content: 'CODEX R2 recovery quote target' })
  if (!quoted.ok) throw Error('quoted fixture failed')

  const input = {
    ...base,
    content: 'CODEX R2 existing quote text',
    quotePostId: quoted.data.id,
    idempotency: { requestId: 'cx-r2-existing-quote', contentHash: 'same-quote-payload' },
  }

  const first = await writes.createPost(a, input)
  if (!first.ok) throw Error('quote fixture failed')

  // Delete quoted post
  expect((await writes.deletePost(b, quoted.data.shortCode!)).ok).toBe(true)
  expect((await db.prisma.post.findUnique({ where: { id: first.data.id } }))!.deletedAt).toBeNull()

  // Replay of existing quote succeeds
  const replayed = await writes.createPost(a, input)
  expect(replayed.ok).toBe(true)
  if (replayed.ok) {
    expect(replayed.replayed).toBe(true)
    expect(replayed.data.id).toBe(first.data.id)
  }

  // New quote targeting deleted post is rejected
  const fresh = await writes.createPost(a, {
    ...input,
    idempotency: { requestId: 'cx-r2-new-quote-attempt', contentHash: 'same-quote-payload' },
  })
  expect(fresh.ok).toBe(false)
  if (!fresh.ok) {
    expect(fresh.error.status).toBe(404)
    expect(fresh.error.message).toBe('Quoted post not found.')
  }
})
