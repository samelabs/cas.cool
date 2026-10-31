// Acceptance regression suite — the independent review's characterization
// probes (R1/R2/R3/R5 + request-key contracts) flipped to assert CORRECT
// behavior. Each test states the wrong behavior it guards against; all
// were demonstrated broken by the review probes and must now hold.
//
// R3's browser-level receive-gap regression lives in the browser suite.
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type { PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import { mkdtemp, writeFile, utimes, stat, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { provisionTestDatabase, dropTestDatabase, sql } from './helpers/db'
import { TEST_DATABASE_URL, SERVER_URL, TEST_UPLOAD_DIR, TEST_PRIVATE_UPLOAD_DIR } from './helpers/env'
import { startTestServer, stopTestServer } from './helpers/server'
import { api, registerAndLogin, type Session } from './helpers/http'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }))
const db = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => db)
let pool: Pool
let a: Session, b: Session
let aid: string, bid: string
let tools: typeof import('@/lib/mcp/tools')
const syntheticFiles: string[] = []

beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(TEST_DATABASE_URL).hostname)) {
    throw new Error('Local only')
  }
  await provisionTestDatabase()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  pool = new Pool({ connectionString: TEST_DATABASE_URL })
  db.prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  tools = await import('@/lib/mcp/tools')
  await startTestServer()
  a = await registerAndLogin('accra')
  b = await registerAndLogin('accrb')
  aid = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [a.username]))[0].id
  bid = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [b.username]))[0].id
})

afterAll(async () => {
  vi.restoreAllMocks()
  await stopTestServer()
  await db.prisma?.$disconnect()
  await pool?.end()
  await dropTestDatabase()
  for (const f of syntheticFiles) await rm(f, { force: true })
})

// ── R2 helpers ────────────────────────────────────────────────

function identity(userId: string, username: string) {
  return {
    authenticated: true,
    method: 'apikey' as const,
    apiKeyId: 'acc-test-key',
    user: { id: userId, username, displayName: null, verificationStatus: 'verified', verificationExpiresAt: null, status: 'active', role: 'user' },
  }
}
function create(userId: string, username: string, args: unknown) {
  return tools.ALL_TOOLS.find((t) => t.name === 'create_post')!.handler(args, identity(userId, username))
}

// ── R1: private attachment claims ─────────────────────────────

describe('R1 private attachment ownership cannot be claimed', () => {
  let mediaUrl: string

  async function uploadVerification(cookie: string): Promise<string> {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#0000ff' } }).png().toBuffer()
    const form = new FormData()
    form.set('purpose', 'verification')
    form.set('file', new Blob([bytes], { type: 'image/png' }), 'synthetic.png')
    const upload = await fetch(`${SERVER_URL}/api/upload`, { method: 'POST', headers: { Cookie: cookie }, body: form })
    expect(upload.status).toBe(201)
    const image = (await upload.json()) as { url: string; filename: string }
    syntheticFiles.push(path.join(TEST_PRIVATE_UPLOAD_DIR, image.filename))
    return image.url
  }

  it('submitting another member\'s attachment URL is rejected and grants nothing', async () => {
    mediaUrl = await uploadVerification(a.cookie)

    // B cannot read A's attachment.
    expect((await api(mediaUrl, { cookie: b.cookie })).status).toBe(404)

    // B tries to CLAIM it by submitting it in their own application → 400.
    const claim = await api('/api/account/verification', {
      method: 'POST', cookie: b.cookie,
      body: JSON.stringify({ idName: 'Synthetic only', idNumber: 'TEST', idFrontImage: mediaUrl, idBackImage: mediaUrl }),
    })
    expect(claim.status).toBe(400)

    // No submission row was created for B; B still 404; A still 200.
    const bSubs = await sql<{ n: number }>('SELECT count(*)::int n FROM "VerificationSubmission" WHERE "userId"=$1', [bid])
    expect(bSubs[0].n).toBe(0)
    expect((await api(mediaUrl, { cookie: b.cookie })).status).toBe(404)
    expect((await api(mediaUrl, { cookie: a.cookie })).status).toBe(200)
  })

  it('a legitimate submission with the caller\'s own attachments succeeds (positive control)', async () => {
    const front = await uploadVerification(b.cookie)
    const back = await uploadVerification(b.cookie)
    const submit = await api('/api/account/verification', {
      method: 'POST', cookie: b.cookie,
      body: JSON.stringify({ idName: 'Synthetic B', idNumber: 'TEST-B', idFrontImage: front, idBackImage: back }),
    })
    expect(submit.status).toBe(200)
    expect((await api(front, { cookie: b.cookie })).status).toBe(200)
    expect((await api(front, { cookie: a.cookie })).status).toBe(404) // A never gains access
    // Cleanup for later tests (row AND the lifecycle gate it set).
    await sql('DELETE FROM "VerificationSubmission" WHERE "userId"=$1', [bid])
    await sql(`UPDATE "User" SET "verificationStatus"='unverified' WHERE id=$1`, [bid])
  })

  it('re-submitting (换图) with a foreign URL does not take over an existing submission', async () => {
    const own = await uploadVerification(a.cookie)
    const submit = await api('/api/account/verification', {
      method: 'POST', cookie: a.cookie,
      body: JSON.stringify({ idName: 'Synthetic A', idNumber: 'TEST-A', idFrontImage: own, idBackImage: own }),
    })
    expect(submit.status).toBe(200)
    // Reset the lifecycle gate so resubmission is possible, then attack:
    await sql('UPDATE "User" SET "verificationStatus"=\'unverified\' WHERE id=$1', [aid])
    const foreign = await uploadVerification(b.cookie)
    const attack = await api('/api/account/verification', {
      method: 'POST', cookie: a.cookie,
      body: JSON.stringify({ idName: 'Synthetic A', idNumber: 'TEST-A', idFrontImage: foreign, idBackImage: foreign }),
    })
    expect(attack.status).toBe(400)
    // A's submission still references A's own attachment; B keeps ownership.
    const row = await sql<{ front: string }>('SELECT "idFrontImage" AS front FROM "VerificationSubmission" WHERE "userId"=$1', [aid])
    expect(row[0].front).toBe(own)
    expect((await api(foreign, { cookie: a.cookie })).status).toBe(404)
    expect((await api(foreign, { cookie: b.cookie })).status).toBe(200)
    await sql('DELETE FROM "VerificationSubmission" WHERE "userId"=$1', [aid])
    await sql(`UPDATE "User" SET "verificationStatus"='unverified' WHERE id=$1`, [aid])
  })

  it('binding the same attachment twice in one submission (重复绑定) is fine for the owner', async () => {
    const own = await uploadVerification(b.cookie)
    const submit = await api('/api/account/verification', {
      method: 'POST', cookie: b.cookie,
      body: JSON.stringify({ idName: 'Synthetic B2', idNumber: 'TEST-B2', idFrontImage: own, idBackImage: own }),
    })
    expect(submit.status).toBe(200)
    await sql('DELETE FROM "VerificationSubmission" WHERE "userId"=$1', [bid])
    await sql(`UPDATE "User" SET "verificationStatus"='unverified' WHERE id=$1`, [bid])
  })

  it('concurrent submissions from two members each with own attachments both succeed', async () => {
    const [aFront, aBack, bFront, bBack] = await Promise.all([
      uploadVerification(a.cookie), uploadVerification(a.cookie),
      uploadVerification(b.cookie), uploadVerification(b.cookie),
    ])
    const results = await Promise.all([
      api('/api/account/verification', { method: 'POST', cookie: a.cookie, body: JSON.stringify({ idName: 'A', idNumber: 'A', idFrontImage: aFront, idBackImage: aBack }) }),
      api('/api/account/verification', { method: 'POST', cookie: b.cookie, body: JSON.stringify({ idName: 'B', idNumber: 'B', idFrontImage: bFront, idBackImage: bBack }) }),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    await sql('DELETE FROM "VerificationSubmission" WHERE "userId" IN ($1,$2)', [aid, bid])
    await sql(`UPDATE "User" SET "verificationStatus"='unverified' WHERE id IN ($1,$2)`, [aid, bid])
  })

  it('pre-submission preview: the uploader reads their own not-yet-submitted attachment', async () => {
    const own = await uploadVerification(a.cookie)
    const res = await api(own, { cookie: a.cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})

// ── R2: atomic create_post idempotency ────────────────────────

describe('R2 atomic request-key idempotency', () => {
  const CONTENT_TAG = 'ACC_REGRESSION_r2'

  // No check-then-act window exists any more: the (caller, key) unique
  // constraint arbitrates INSIDE the creation transactions, so plain
  // concurrent calls are the genuine race.

  it('same key + same content concurrent: exactly ONE post commits, both callers see it', async () => {
    const content = `${CONTENT_TAG}_same`
    const key = 'acc-r2-same'
    const results = await Promise.all([
      create(aid, a.username, { content, clientRequestId: key }),
      create(aid, a.username, { content, clientRequestId: key }),
    ])
    // Both succeed (one created, one replayed) — and exactly one post exists.
    const total = await db.prisma.post.count({ where: { authorId: aid, content } })
    expect(total).toBe(1)
    const okResults = results.filter((r) => !r.isError)
    expect(okResults.length).toBe(2)
    const ids = new Set(okResults.map((r) => (r.structuredContent as { id: string }).id))
    expect(ids.size).toBe(1)
    expect(okResults.some((r) => (r.structuredContent as { replayed?: boolean }).replayed === true)).toBe(true)
  })

  it('same key + different content concurrent: exactly ONE post commits, the other errors', async () => {
    const key = 'acc-r2-diff'
    const results = await Promise.all([
      create(aid, a.username, { content: `${CONTENT_TAG}_diff_A`, clientRequestId: key }),
      create(aid, a.username, { content: `${CONTENT_TAG}_diff_B`, clientRequestId: key }),
    ])
    const total = await db.prisma.post.count({ where: { authorId: aid, content: { startsWith: `${CONTENT_TAG}_diff_` } } })
    expect(total).toBe(1) // the loser left NOTHING behind
    const errors = results.filter((r) => r.isError)
    expect(errors.length).toBe(1)
    expect((errors[0].structuredContent as { error: { code: string } }).error.code).toBe('request_key_conflict')
  })

  it('mid-transaction failure rolls the WHOLE creation back — no orphan post, retry creates exactly one', async () => {
    const content = `${CONTENT_TAG}_outage`
    const key = 'acc-r2-outage'
    // Inject INSIDE the transaction boundary: the core post write fails
    // after the request-key row was inserted in the same transaction.
    const coreWrite = await import('@/lib/services/post-core-write.service')
    const actualCreate = coreWrite.createCorePost
    const fail = vi.spyOn(coreWrite, 'createCorePost').mockRejectedValueOnce(new Error('synthetic mid-transaction failure'))
    try {
      await expect(create(aid, a.username, { content, clientRequestId: key })).rejects.toThrow('synthetic mid-transaction failure')
    } finally { fail.mockRestore() }
    void actualCreate
    // Everything rolled back together: no post AND no request-key row.
    expect(await db.prisma.post.count({ where: { authorId: aid, content } })).toBe(0)
    expect(await db.prisma.postRequestKey.count({ where: { userId: aid, requestId: key } })).toBe(0)
    // Retry succeeds exactly once.
    const retried = await create(aid, a.username, { content, clientRequestId: key })
    expect(retried.isError).toBeFalsy()
    expect(await db.prisma.post.count({ where: { authorId: aid, content } })).toBe(1)
  })

  it('a key older than 24h no longer replays — a fresh post is created', async () => {
    const content = `${CONTENT_TAG}_expired`
    const key = 'acc-r2-expired'
    const first = await create(aid, a.username, { content, clientRequestId: key })
    expect(first.isError).toBeFalsy()
    const firstId = (first.structuredContent as { id: string }).id
    await sql(`UPDATE "PostRequestKey" SET "createdAt"=timezone('utc',now())-interval '25 hours' WHERE "userId"=$1 AND "requestId"=$2`, [aid, key])
    const second = await create(aid, a.username, { content, clientRequestId: key })
    expect(second.isError).toBeFalsy()
    expect((second.structuredContent as { replayed?: boolean }).replayed).toBeUndefined()
    expect((second.structuredContent as { id: string }).id).not.toBe(firstId)
    expect(await db.prisma.post.count({ where: { authorId: aid, content } })).toBe(2)
  })

  it('replay after the original was deleted errors cleanly and creates nothing', async () => {
    const content = `${CONTENT_TAG}_deleted`
    const key = 'acc-r2-deleted'
    const first = await create(aid, a.username, { content, clientRequestId: key })
    expect(first.isError).toBeFalsy()
    const shortCode = (first.structuredContent as { shortCode: string }).shortCode
    const del = await tools.ALL_TOOLS.find((t) => t.name === 'delete_post')!.handler({ shortCode }, identity(aid, a.username))
    expect(del.isError).toBeFalsy()
    const replay = await create(aid, a.username, { content, clientRequestId: key })
    expect(replay.isError).toBe(true)
    expect((replay.structuredContent as { error: { code: string } }).error.code).toBe('request_key_post_gone')
    // No zombie: the original row (soft-deleted, content cleared by the
    // tombstone) still exists EXACTLY once, and nothing new was created.
    const original = await db.prisma.post.findUnique({ where: { id: (first.structuredContent as { id: string }).id }, select: { deletedAt: true } })
    expect(original?.deletedAt).not.toBeNull()
    expect(await db.prisma.post.count({ where: { authorId: aid, parentId: null, quotePostId: null, deletedAt: null, content: { startsWith: CONTENT_TAG } } })).toBeLessThanOrEqual(await db.prisma.postRequestKey.count({ where: { userId: aid } }))
  })

  it('concurrent loser leaves no counters, relations or notification tasks behind', async () => {
    const key = 'acc-r2-side-effects'
    const content = `${CONTENT_TAG}_sidefx`
    const authorBefore = await sql<{ n: number }>('SELECT "postCount" AS n FROM "User" WHERE id=$1', [aid])
    await Promise.all([
      create(aid, a.username, { content, clientRequestId: key }),
      create(aid, a.username, { content, clientRequestId: key }),
    ])
    const authorAfter = await sql<{ n: number }>('SELECT "postCount" AS n FROM "User" WHERE id=$1', [aid])
    expect(authorAfter[0].n - authorBefore[0].n).toBe(1) // counter moved exactly once
    const tasks = await sql<{ n: number }>(
      `SELECT count(*)::int n FROM "SideEffectTask" t
       WHERE t.kind='notification' AND (t.payload->>'fromId')=$1 AND t."createdAt" > now() - interval '5 minutes'`, [aid])
    expect(tasks[0].n).toBe(0) // self-post → no notification tasks; nothing from the loser
  })
})

// ── R5: sweep vs reference-write mutual exclusion ─────────────

describe('R5 sweep and reference writes are mutually exclusive', () => {
  it('a REAL reference write committing after the final check cannot dangle (lock serializes)', async () => {
    const name = randomUUID() + '.webp'
    const url = `/uploads/${name}`
    // The configured public root — the SAME physical directory the app's
    // reference-write path resolves (helpers/env.ts provides it to both the
    // test process and the spawned server).
    const publicDir = TEST_UPLOAD_DIR
    await (await import('node:fs/promises')).mkdir(publicDir, { recursive: true })
    const file = path.join(publicDir, name)
    await writeFile(file, 'synthetic')
    const old = new Date(Date.now() - 48 * 3600_000)
    await utimes(file, old, old)
    const dirs = { public: TEST_UPLOAD_DIR, private: TEST_PRIVATE_UPLOAD_DIR }

    const { sweepUploadFile } = await import('@/lib/upload-sweep')
    const { assertUploadAssetsAvailable } = await import('@/lib/upload-lifecycle')
    // Positive control: the exact write path can see this live file before
    // any deletion. A mismatched fixture directory must fail the test.
    await db.prisma.$transaction(async (tx) => assertUploadAssetsAvailable(tx, [url], 'public'))

    // Deterministic interleaving: the sweep's reference check (inside its
    // lock-holding transaction) signals BEFORE returning, giving the real
    // locked write time to start and BLOCK on the advisory lock. The sweep
    // then unlinks and commits; the write acquires the lock and must be
    // rejected (file gone) — never a dangling reference.
    const cleanupMod = await import('@/lib/upload-cleanup')
    const actualIsReferenced = cleanupMod.isReferenced
    let sweepChecked!: () => void
    const sweepCheckedPromise = new Promise<void>((r) => { sweepChecked = r })
    let holdSweep!: () => void
    const holdSweepPromise = new Promise<void>((r) => { holdSweep = r })
    const spy = vi.spyOn(cleanupMod, 'isReferenced').mockImplementation(async (u: string) => {
      const result = await actualIsReferenced(u)
      if (u === url) { sweepChecked(); await holdSweepPromise }
      return result
    })

    try {
      // The reference write goes through the REAL locked path (transaction
      // + advisory lock + availability assertion) — not a raw insert.
      const writePromise = (async () => {
        await sweepCheckedPromise // sweep holds the lock; start the write now
        try {
          await db.prisma.$transaction(async (tx) => {
            await assertUploadAssetsAvailable(tx, [url], 'public')
            await tx.post.create({ data: { authorId: aid, content: 'ACC_REGRESSION_r5_write', images: [url] } })
          })
          return 'committed' as const
        } catch (error: unknown) {
          if (!(error instanceof Error && 'code' in error && error.code === 'asset_gone')) throw error
          return 'rejected' as const
        }
      })()

      const sweepPromise = sweepUploadFile('public', name, Date.now(), dirs)
      // Let both run: the sweep finishes check+unlink under the lock, the
      // write unblocks afterwards.
      const [{ key }] = await sql<{ key: number }>('SELECT hashtext($1)::bigint AS key', [url])
      const unsignedKey = Number(key) >>> 0
      try {
        await expect.poll(async () => {
          const rows = await sql<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
              AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND NOT granted) AS waiting`,
            [0x55504c44, unsignedKey],
          )
          return rows[0].waiting
        }, { timeout: 5000 }).toBe(true)
      } finally {
        holdSweep()
      }
      const [sweepResult, writeResult] = await Promise.all([sweepPromise, writePromise])

      // The invariant: the file may be deleted (sweep won), but then the
      // write MUST have been rejected — a dangling reference is impossible.
      let fileExists: boolean
      try { await stat(file); fileExists = true } catch { fileExists = false }
      const dangling = await db.prisma.post.count({ where: { images: { has: url } } })
      expect(dangling).toBe(0)
      if (!fileExists) {
        expect(sweepResult.action).toBe('deleted')
        expect(writeResult).toBe('rejected')
      } else {
        expect(writeResult).toBe('committed')
        expect(['kept-referenced', 'missing']).toContain(sweepResult.action)
      }
      await db.prisma.post.deleteMany({ where: { content: 'ACC_REGRESSION_r5_write' } })
    } finally {
      spy.mockRestore()
      await rm(file, { force: true })
    }
  })

  it('real unlink failure (EACCES) is reported as an error, not "missing"', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'acc-r5b-'))
    const name = randomUUID() + '.webp'
    const file = path.join(tmp, name)
    await writeFile(file, 'synthetic')
    const old = new Date(Date.now() - 48 * 3600_000)
    await utimes(file, old, old)
    // Make the file read-only and the directory non-writable → unlink fails
    // with EACCES (not ENOENT).
    await chmod(file, 0o444)
    await chmod(tmp, 0o555)
    try {
      const { sweepUploadFile } = await import('@/lib/upload-sweep')
      await expect(sweepUploadFile('public', name, Date.now(), { public: tmp, private: path.join(tmp, 'p') }))
        .rejects.toThrow()
      // The file still exists — a permission failure did not claim recycle.
      expect((await stat(file)).isFile()).toBe(true)
    } finally {
      await chmod(tmp, 0o755)
      await chmod(file, 0o644)
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
