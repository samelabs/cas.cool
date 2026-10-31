import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client, Pool } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { access, mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dropTestDatabase, provisionTestDatabase, sql } from './helpers/db'
import { TEST_DATABASE_URL, TEST_UPLOAD_DIR } from './helpers/env'

// Next supplies these server-only modules in request contexts. The test
// replaces only the framework boundary; all writes use real PostgreSQL.
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}))
const db = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => db)

let writes: typeof import('@/lib/services/post-write.service')
let pool: Pool
const actor = { id: 'audit_author', role: 'user', verificationStatus: 'verified' }

beforeAll(async () => {
  await provisionTestDatabase()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  pool = new Pool({ connectionString: TEST_DATABASE_URL })
  db.prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  writes = await import('@/lib/services/post-write.service')
  await sql(`INSERT INTO "User" (id, email, username, "passwordHash", "createdAt", "updatedAt")
    VALUES ('audit_author', 'audit@example.test', 'audit_author', 'x', now(), now()),
           ('audit_reader', 'auditreader@example.test', 'audit_reader', 'x', now(), now())`)
})

afterEach(async () => {
  vi.restoreAllMocks()
  const { revalidateTag } = await import('next/cache')
  vi.mocked(revalidateTag).mockReset()
})
afterAll(async () => {
  await db.prisma?.$disconnect()
  await pool?.end()
  await dropTestDatabase()
})

async function seedPost(tag: string) {
  const [post] = await sql<{ id: string; shortCode: string }>(`
    INSERT INTO "Post" (id, "shortCode", "authorId", content, images, "createdAt", "updatedAt")
    VALUES ($1, $1, 'audit_author', 'original', '{}'::text[], now(), now())
    RETURNING id, "shortCode"`, [tag])
  await sql('UPDATE "User" SET "postCount" = "postCount" + 1 WHERE id = $1', [actor.id])
  return post
}

async function waitForBlockedWriter(blocker: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [row] = await sql<{ blocked: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked`, [blocker])
    if (row.blocked) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Post writer did not reach the held row lock')
}

describe('post-write failure and concurrency boundaries', () => {
  it('a cache failure cannot turn a committed create or delete into an error', async () => {
    const { revalidateTag } = await import('next/cache')
    vi.mocked(revalidateTag).mockImplementation(() => { throw new Error('cache unavailable') })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const created = await writes.createPost(actor, {
      content: 'committed despite cache failure', parentId: null, quotePostId: null,
      images: [], casNumbers: null,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('Expected a committed post')
    const deleted = await writes.deletePost(actor, created.data.shortCode!)
    expect(deleted.ok).toBe(true)
    const [row] = await sql<{ content: string; deleted: boolean }>(
      'SELECT content, "deletedAt" IS NOT NULL AS deleted FROM "Post" WHERE id = $1',
      [created.data.id],
    )
    expect(row).toEqual({ content: '', deleted: true })
  })

  it('reply and quote notifications need no database lookup after the post commits', async () => {
    const original = await seedPost('audit_notify')
    // These are precisely the old post-commit lookups. Validation and all
    // transaction reads remain real; no failure is injected before commit.
    vi.spyOn(db.prisma.post, 'findUnique').mockRejectedValue(new Error('post-commit lookup unavailable'))
    const created = await writes.createPost({ ...actor, id: 'audit_reader' }, {
      content: 'reply and quote', parentId: original.id, quotePostId: original.id,
      images: [], casNumbers: null,
    })
    expect(created.ok).toBe(true)
    const notifications = await sql<{ type: string }>(
      'SELECT type FROM "Notification" WHERE "userId" = $1 ORDER BY type', [actor.id],
    )
    expect(notifications.map((row) => row.type).sort()).toEqual(['COMMENT', 'REPOST'])
  })

  it('an edit waiting behind a delete cannot restore content or chemical associations', async () => {
    const post = await seedPost('audit_delete_race')
    const blocker = new Client({ connectionString: TEST_DATABASE_URL })
    await blocker.connect()
    let edit: ReturnType<typeof writes.editPost> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM "Post" WHERE id = $1 FOR UPDATE', [post.id])
      const { rows: [backend] } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      edit = writes.editPost(actor, post.shortCode, {
        content: 'must never be restored', images: [], casNumbers: ['64-17-5'],
      })
      await waitForBlockedWriter(backend.pid)
      // The delete owns the row and commits first, while the edit is in
      // flight. Include the real delete's generic counter adjustment.
      await blocker.query('UPDATE "Post" SET "deletedAt" = now(), content = \'\', images = \'{}\' WHERE id = $1', [post.id])
      await blocker.query('UPDATE "User" SET "postCount" = "postCount" - 1 WHERE id = $1', [actor.id])
      await blocker.query('COMMIT')
      expect(await edit).toMatchObject({ ok: false, error: { status: 404 } })
      const [row] = await sql<{ content: string; images: string[]; associations: string }>(`
        SELECT p.content, p.images,
          (SELECT count(*)::text FROM "_ChemicalToPost" WHERE "B" = p.id) AS associations
        FROM "Post" p WHERE p.id = $1`, [post.id])
      expect(row).toEqual({ content: '', images: [], associations: '0' })
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
      await edit?.catch(() => {})
    }
  })

  it('edit eligibility is checked after acquiring the row, including an expired edit window', async () => {
    const post = await seedPost('audit_window_race')
    const blocker = new Client({ connectionString: TEST_DATABASE_URL })
    await blocker.connect()
    let edit: ReturnType<typeof writes.editPost> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM "Post" WHERE id = $1 FOR UPDATE', [post.id])
      const { rows: [backend] } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      edit = writes.editPost(actor, post.shortCode, { content: 'too late', images: [], casNumbers: null })
      await waitForBlockedWriter(backend.pid)
      await blocker.query(`UPDATE "Post" SET "createdAt" = timezone('utc', now()) - interval '2 hours' WHERE id = $1`, [post.id])
      await blocker.query('COMMIT')
      expect(await edit).toMatchObject({ ok: false, error: { status: 403, message: 'Edit window has expired.' } })
      const [row] = await sql<{ content: string }>('SELECT content FROM "Post" WHERE id = $1', [post.id])
      expect(row.content).toBe('original')
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
      await edit?.catch(() => {})
    }
  })

  it('cleanup uses the image snapshot actually replaced by the edit', async () => {
    const post = await seedPost('audit_image_race')
    const filename = `audit-${randomUUID()}.webp`
    const filePath = path.join(TEST_UPLOAD_DIR, filename)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'image fixture')
    const blocker = new Client({ connectionString: TEST_DATABASE_URL })
    await blocker.connect()
    let edit: ReturnType<typeof writes.editPost> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM "Post" WHERE id = $1 FOR UPDATE', [post.id])
      const { rows: [backend] } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      edit = writes.editPost(actor, post.shortCode, { content: 'latest edit', images: [], casNumbers: null })
      await waitForBlockedWriter(backend.pid)
      await blocker.query('UPDATE "Post" SET images = $1 WHERE id = $2', [[`/uploads/${filename}`], post.id])
      await blocker.query('COMMIT')
      expect(await edit).toMatchObject({ ok: true })
      await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
      await edit?.catch(() => {})
      await unlink(filePath).catch(() => {})
    }
  })

  it('deletion cleanup uses the actual deleted image snapshot when edit commits new images concurrently', async () => {
    const post = await seedPost('audit_del_snap_race')
    const newFilename = `audit-del-new-${randomUUID()}.webp`
    const newFilePath = path.join(TEST_UPLOAD_DIR, newFilename)
    await mkdir(path.dirname(newFilePath), { recursive: true })
    await writeFile(newFilePath, 'new image fixture')

    const blocker = new Client({ connectionString: TEST_DATABASE_URL })
    await blocker.connect()
    let del: ReturnType<typeof writes.deletePost> | undefined
    try {
      await blocker.query('BEGIN')
      // Hold the post lock so delete waits
      await blocker.query('SELECT id FROM "Post" WHERE id = $1 FOR UPDATE', [post.id])
      const { rows: [backend] } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')

      del = writes.deletePost(actor, post.shortCode)
      await waitForBlockedWriter(backend.pid)

      // Concurrent edit commits the new image while delete is waiting
      await blocker.query('UPDATE "Post" SET images = $1 WHERE id = $2', [[`/uploads/${newFilename}`], post.id])
      await blocker.query('COMMIT')

      const res = await del
      expect(res.ok).toBe(true)

      // The new image committed by the edit MUST have been cleaned up by the delete!
      await expect(access(newFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
      await del?.catch(() => {})
      await unlink(newFilePath).catch(() => {})
    }
  })

  it('deleteReportedPost captures the actual live image snapshot for outbox payload', async () => {
    const post = await seedPost('audit_report_del_snap')
    const imgUrl = `/uploads/report-${randomUUID()}.webp`
    await sql('UPDATE "Post" SET images = $1 WHERE id = $2', [[imgUrl], post.id])

    const res = await writes.deleteReportedPost(post.id)
    expect(res.deleted).toBe(true)
    expect(res.images).toEqual([imgUrl])

    // A second delete returns deleted: false and empty images without double-decrement
    const second = await writes.deleteReportedPost(post.id)
    expect(second.deleted).toBe(false)
    expect(second.images).toEqual([])
  })

  it('text edit without images preserves existing images and files, while explicit [] clears them', async () => {
    const post = await seedPost('audit_preserve_images')
    const filename = `preserve-${randomUUID()}.webp`
    const filePath = path.join(TEST_UPLOAD_DIR, filename)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'preserve fixture')

    try {
      // Set initial image
      await sql('UPDATE "Post" SET images = $1 WHERE id = $2', [[`/uploads/${filename}`], post.id])

      // 1. Edit without images parameter (undefined) -> preserves image and file
      const editPreserve = await writes.editPost(actor, post.shortCode, {
        content: 'content updated, images omitted',
        images: undefined,
        casNumbers: null,
      })
      expect(editPreserve.ok).toBe(true)
      if (!editPreserve.ok) throw new Error('Expected successful edit')
      expect(editPreserve.data.images).toEqual([`/uploads/${filename}`])

      // File must still exist
      await expect(access(filePath)).resolves.toBeUndefined()

      // 2. Edit with explicit empty array [] -> clears image and removes unreferenced file
      const editClear = await writes.editPost(actor, post.shortCode, {
        content: 'content updated, images cleared',
        images: [],
        casNumbers: null,
      })
      expect(editClear.ok).toBe(true)
      if (!editClear.ok) throw new Error('Expected successful edit')
      expect(editClear.data.images).toEqual([])

      // File must now be deleted
      await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await unlink(filePath).catch(() => {})
    }
  })

  it('concurrent API key creation via HTTP route is strictly serialized against the user count limit', async () => {
    const { NextRequest } = await import('next/server')
    const apiAuth = await import('@/lib/api-auth')
    const { POST: createApiKey } = await import('@/app/api/account/api-keys/route')

    await sql(`INSERT INTO "User" (id, email, username, "passwordHash", "createdAt", "updatedAt")
      VALUES ('audit_key_user', 'keyuser@example.test', 'audit_key_user', 'x', now(), now())
      ON CONFLICT DO NOTHING`)

    // Clean up any existing keys for this test user
    await sql(`DELETE FROM "ApiKey" WHERE "userId" = 'audit_key_user'`)

    // Pre-seed 4 active keys (limit is 5)
    for (let i = 1; i <= 4; i++) {
      await sql(`INSERT INTO "ApiKey" (id, "userId", name, "keyHash", prefix, "createdAt")
        VALUES ('k_${i}', 'audit_key_user', 'key_${i}', 'hash_${i}', 'pref_${i}', now())`)
    }

    vi.spyOn(apiAuth, 'requireAuth').mockResolvedValue({
      ok: true,
      identity: {
        authenticated: true,
        method: 'session',
        user: {
          id: 'audit_key_user',
          status: 'active',
          role: 'user',
          verificationStatus: 'verified',
        },
      },
    } as unknown as Awaited<ReturnType<typeof apiAuth.requireAuth>>)

    // Launch 10 concurrent HTTP requests to the actual route handler
    const requests = Array.from({ length: 10 }, (_, i) => {
      const req = new NextRequest('http://localhost/api/account/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `concurrent_${i}` }),
      })
      return createApiKey(req)
    })

    const responses = await Promise.all(requests)
    const statuses = responses.map((r) => r.status)

    const succeeded = statuses.filter((s) => s === 201)
    const failed = statuses.filter((s) => s === 400)

    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(9)

    const [countRow] = await sql<{ count: string }>(
      `SELECT count(*)::text FROM "ApiKey" WHERE "userId" = 'audit_key_user' AND "revokedAt" IS NULL`,
    )
    expect(countRow.count).toBe('5')
  })
})
