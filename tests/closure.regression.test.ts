// Closure regression suite for the 1.2.0 post-release interaction closeout.
// Every test asserts the CORRECT post-fix behavior. Run first against the
// published baseline to capture red evidence, then again after the fix.
//
// Baseline red run:
//   TEST_DB_NAME=cascool_closure_regression_test TEST_PORT=3197 \
//     npx vitest run tests/closure.regression.test.ts
import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type { PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import { provisionTestDatabase, dropTestDatabase, sql } from './helpers/db'
import { TEST_DATABASE_URL, SERVER_URL, TEST_PRIVATE_UPLOAD_DIR } from './helpers/env'
import { startTestServer, stopTestServer } from './helpers/server'
import { api, registerAndLogin, type Session } from './helpers/http'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }))
const db = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => db)
let pool: Pool
let a: Session, b: Session
let aid: string, bid: string
let privateMediaUrl: string | undefined
const syntheticPrivateFiles: string[] = []

beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(TEST_DATABASE_URL).hostname)) {
    throw new Error('Local regression only')
  }
  await provisionTestDatabase()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  pool = new Pool({ connectionString: TEST_DATABASE_URL })
  db.prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  await startTestServer()
  a = await registerAndLogin('closurea')
  b = await registerAndLogin('closureb')
  aid = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [a.username]))[0].id
  bid = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [b.username]))[0].id
  console.log('[closure-reg] aid=%s bid=%s db=%s', aid, bid, new URL(TEST_DATABASE_URL).pathname)
})

afterAll(async () => {
  vi.restoreAllMocks()
  await stopTestServer()
  await db.prisma?.$disconnect()
  await pool?.end()
  await dropTestDatabase()
})

function privateUploadDir(): string {
  // The suite's configured private root (helpers/env.ts — the same
  // PRIVATE_UPLOAD_DIR the app and the spawned server read); used only to
  // clean up the synthetic verification fixture after the run.
  return TEST_PRIVATE_UPLOAD_DIR
}

// ── B1: duplicate follow must not re-surface a read notification ──

it('duplicate follow HTTP request keeps the notification read and the relation single', async () => {
  const endpoint = `/api/users/${b.username}/follow`
  expect((await api(endpoint, { method: 'POST', cookie: a.cookie })).status).toBe(200)
  await sql('UPDATE "Notification" SET read=true, "createdAt"=\'2000-01-01\' WHERE "userId"=$1 AND type=\'FOLLOW\'', [bid])
  expect((await api(endpoint, { method: 'POST', cookie: a.cookie })).status).toBe(200)
  const rows = await sql<{ read: boolean }>('SELECT read FROM "Notification" WHERE "userId"=$1 AND type=\'FOLLOW\'', [bid])
  expect(rows).toEqual([{ read: true }])
  expect((await sql<{ n: number }>('SELECT count(*)::int n FROM "Follow" WHERE "followerId"=$1 AND "followingId"=$2', [aid, bid]))[0].n).toBe(1)
})

// ── B5: unfollow→refollow is a real state change; recipient-side cooldown
//    suppresses the re-notification inside the window, resumes after it. ──

it('refollow within the recipient cooldown window does not re-notify; after the window it does', async () => {
  const endpoint = `/api/users/${b.username}/follow`
  // State from the previous test: a follows b, notification read at 2000-01-01.
  // Block 1 — last surface long expired: a genuine re-follow re-notifies.
  expect((await api(endpoint, { method: 'DELETE', cookie: a.cookie })).status).toBe(200)
  expect((await api(endpoint, { method: 'POST', cookie: a.cookie })).status).toBe(200)
  let rows = await sql<{ read: boolean }>('SELECT read FROM "Notification" WHERE "userId"=$1 AND type=\'FOLLOW\'', [bid])
  expect(rows).toEqual([{ read: false }])

  // Block 2 — surface was 30 minutes ago (inside the 60 min window):
  // the toggle is a real state change but must NOT re-disturb the recipient.
  expect((await api(endpoint, { method: 'DELETE', cookie: a.cookie })).status).toBe(200)
  await sql('UPDATE "Notification" SET read=true, "createdAt"=now() - interval \'30 minutes\' WHERE "userId"=$1 AND type=\'FOLLOW\'', [bid])
  expect((await api(endpoint, { method: 'POST', cookie: a.cookie })).status).toBe(200)
  rows = await sql<{ read: boolean }>('SELECT read FROM "Notification" WHERE "userId"=$1 AND type=\'FOLLOW\'', [bid])
  expect(rows).toEqual([{ read: true }])

  // Block 3 — surface was 2 hours ago (window expired): re-notify resumes.
  expect((await api(endpoint, { method: 'DELETE', cookie: a.cookie })).status).toBe(200)
  await sql('UPDATE "Notification" SET read=true, "createdAt"=now() - interval \'2 hours\' WHERE "userId"=$1 AND type=\'FOLLOW\'', [bid])
  expect((await api(endpoint, { method: 'POST', cookie: a.cookie })).status).toBe(200)
  rows = await sql<{ read: boolean }>('SELECT read FROM "Notification" WHERE "userId"=$1 AND type=\'FOLLOW\'', [bid])
  expect(rows).toEqual([{ read: false }])
})

// ── B2: null-postId notification dedup must be atomic (no findFirst window) ──

it('concurrent null-postId notification creation produces exactly one visible row', async () => {
  await sql('DELETE FROM "Notification" WHERE "userId"=$1', [bid])
  const { deliverNotification } = await import('@/lib/notification')
  const actual = db.prisma.notification.findFirst.bind(db.prisma.notification)
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const spy = vi.spyOn(db.prisma.notification, 'findFirst').mockImplementation((async (...args: unknown[]) => {
    const result = await (actual as (...a: unknown[]) => Promise<unknown>)(...args)
    if (++arrived === 2) release()
    await gate
    return result
  }) as never)
  try {
    await Promise.all([1, 2].map(() => deliverNotification({ userId: bid, fromId: aid, type: 'FOLLOW' })))
    const n = (await sql<{ n: number }>('SELECT count(*)::int n FROM "Notification" WHERE "userId"=$1 AND type=\'FOLLOW\'', [bid]))[0].n
    expect(n).toBe(1)
  } finally { spy.mockRestore() }
})

it('retrying an old event after a newer one is a pure no-op (delivery record authority)', async () => {
  // MESSAGE exercises the same null-postId arbiter and always re-surfaces
  // (no cooldown) — isolates the delivery-record contract from the
  // toggle-type cooldown policy covered by the follow test above.
  await sql('DELETE FROM "Notification" WHERE "userId"=$1', [bid])
  await sql('DELETE FROM "NotificationDelivery" WHERE "eventKey" LIKE \'closure-reg-%\'')
  const { deliverNotification } = await import('@/lib/notification')
  await deliverNotification({ userId: bid, fromId: aid, type: 'MESSAGE', eventKey: 'closure-reg-old' })
  const first = await sql<{ read: boolean; created: string }>('SELECT read, "createdAt"::text AS created FROM "Notification" WHERE "userId"=$1 AND type=\'MESSAGE\'', [bid])
  expect(first).toHaveLength(1)
  expect(first[0].read).toBe(false)
  await deliverNotification({ userId: bid, fromId: aid, type: 'MESSAGE', eventKey: 'closure-reg-new' })
  // user reads it
  await sql('UPDATE "Notification" SET read=true WHERE "userId"=$1 AND type=\'MESSAGE\'', [bid])
  const afterNew = await sql<{ read: boolean; created: string }>('SELECT read, "createdAt"::text AS created FROM "Notification" WHERE "userId"=$1 AND type=\'MESSAGE\'', [bid])
  expect(afterNew).toHaveLength(1)
  expect(afterNew[0].read).toBe(true)
  // old event retry must not flip read or timestamps
  await deliverNotification({ userId: bid, fromId: aid, type: 'MESSAGE', eventKey: 'closure-reg-old' })
  const afterRetry = await sql<{ read: boolean; created: string }>('SELECT read, "createdAt"::text AS created FROM "Notification" WHERE "userId"=$1 AND type=\'MESSAGE\'', [bid])
  expect(afterRetry).toHaveLength(1)
  expect(afterRetry[0].read).toBe(true)
  expect(afterRetry[0].created).toBe(afterNew[0].created)
  const deliveries = await sql<{ n: number }>('SELECT count(*)::int n FROM "NotificationDelivery" WHERE "eventKey" LIKE \'closure-reg-%\'', )
  expect(deliveries[0].n).toBe(2)
})

// ── B3: page-read scope = returned rows × read version ──

/** Seed N visible notifications for `recipient`, each from its own synthetic
 *  actor — the (userId, fromId, type) partial unique arbiter requires one
 *  row per actor, exactly like production data. */
async function seedNotificationsFor(recipient: string, count: number, prefix: string) {
  await sql(`DELETE FROM "Notification" WHERE "userId"=$1`, [recipient])
  await sql(`DELETE FROM "User" WHERE username LIKE $1`, [`${prefix}_%`])
  // `count` actors for the visible rows, plus one reserved arrival actor
  // used to simulate a notification arriving after the page SELECT.
  await sql(`INSERT INTO "User" (id, email, username, "passwordHash", "createdAt", "updatedAt")
    SELECT 'closure_actor_'||i, 'closure_actor_'||i||'@test.local', $1::text||'_'||i, 'x', now(), now()
    FROM generate_series(1, ${count} + 1) i`, [prefix])
  await sql(`INSERT INTO "Notification" (id,"userId","fromId",type,"createdAt")
    SELECT '${prefix}_notif_'||i, $1::text, 'closure_actor_'||i, 'FOLLOW', timezone('utc',now())+i*interval '1 millisecond'
    FROM generate_series(1, ${count}) i`, [recipient])
}

it('notification first page marks only returned stable rows; concurrent arrival and re-surfaced row stay unread', async () => {
  await seedNotificationsFor(bid, 31, 'closure_reg')
  const actual = db.prisma.notification.findMany.bind(db.prisma.notification)
  const hasRevision = (await sql(
    `SELECT 1 FROM information_schema.columns WHERE table_name='Notification' AND column_name='revision'`,
  )).length > 0
  const spy = vi.spyOn(db.prisma.notification, 'findMany').mockImplementationOnce((async (...args: unknown[]) => {
    const result = await (actual as (...a: unknown[]) => Promise<unknown>)(...args) as { id: string; read: boolean }[]
    // 1) a brand-new notification arrives after the page SELECT (from the
    //    reserved arrival actor — a distinct (user, from, type) tuple)
    await sql(`INSERT INTO "Notification" (id,"userId","fromId",type) VALUES ('closure_arrived_after_read',$1,'closure_actor_32','FOLLOW')`, [bid])
    // 2) an already-returned unread row is re-surfaced by a genuine new event
    if (hasRevision) {
      await sql(`UPDATE "Notification" SET "createdAt"=now(), "revision"="revision"+1 WHERE id='closure_reg_notif_5'`, )
    } else {
      await sql(`UPDATE "Notification" SET "createdAt"=now() WHERE id='closure_reg_notif_5'`, )
    }
    return result
  }) as never)
  try {
    const { getNotificationsFirstPage } = await import('@/lib/services/notify.service')
    const page = await getNotificationsFirstPage(bid)
    expect(page.notifications).toHaveLength(30)
    expect(page.notifications.some((n) => n.id === 'closure_arrived_after_read')).toBe(false)
    const readRows = await sql<{ id: string }>('SELECT id FROM "Notification" WHERE "userId"=$1 AND read ORDER BY id', [bid])
    const readIds = new Set(readRows.map((r) => r.id))
    expect(readIds.has('closure_arrived_after_read')).toBe(false)
    expect(readIds.has('closure_reg_notif_5')).toBe(false) // re-surfaced after our SELECT → must stay unread
    expect(readIds.size).toBe(29) // 30 returned rows − re-surfaced one; the 31st + arrival remain unread
    expect((page as { unreadRemaining?: number }).unreadRemaining).toBe(3) // notif_5, notif_31, arrival
  } finally { spy.mockRestore() }
})

// ── C2: DM thread first screen = most recent window; read scope = returned ──

it('conversation thread opens on the most recent 200 messages and marks only those read', async () => {
  const [u1, u2] = [aid, bid].sort()
  await sql('INSERT INTO "Conversation" (id,"user1Id","user2Id") VALUES (\'closure_long\',$1,$2) ON CONFLICT DO NOTHING', [u1, u2])
  await sql('DELETE FROM "DirectMessage" WHERE "conversationId"=\'closure_long\'')
  await sql(`INSERT INTO "DirectMessage" (id,"conversationId","senderId","receiverId",content,"createdAt")
    SELECT 'closure_dm_'||i,'closure_long',$1,$2,'message '||i,'2026-01-01'::timestamp+i*interval '1 second' FROM generate_series(1,201) i`, [aid, bid])
  const { getConversationThread } = await import('@/lib/services/message.service')
  const thread = await getConversationThread('closure_long', bid)
  expect(thread.messages).toHaveLength(200)
  expect(thread.messages.some((m) => m.id === 'closure_dm_201')).toBe(true) // newest visible
  expect(thread.messages.some((m) => m.id === 'closure_dm_1')).toBe(false) // oldest outside window
  const dm1 = await sql<{ read: boolean }>('SELECT "readAt" IS NOT NULL AS read FROM "DirectMessage" WHERE id=\'closure_dm_1\'')
  expect(dm1[0].read).toBe(false) // never shown → never confirmed
  const dm201 = await sql<{ read: boolean }>('SELECT "readAt" IS NOT NULL AS read FROM "DirectMessage" WHERE id=\'closure_dm_201\'')
  expect(dm201[0].read).toBe(true)
})

// ── C3: same-millisecond messages must be fully reachable via the
//    composite (createdAt,id) incremental cursor ──

it('incremental message polling with the composite cursor drains same-millisecond backlog completely', async () => {
  const [u1, u2] = [aid, bid].sort()
  await sql('INSERT INTO "Conversation" (id,"user1Id","user2Id") VALUES (\'closure_tied\',$1,$2) ON CONFLICT DO NOTHING', [u1, u2])
  const conv = (await sql<{ id: string }>('SELECT id FROM "Conversation" WHERE "user1Id"=$1 AND "user2Id"=$2', [u1, u2]))[0].id
  await sql('DELETE FROM "DirectMessage" WHERE "conversationId"=$1', [conv])
  await sql(`INSERT INTO "DirectMessage" (id,"conversationId","senderId","receiverId",content,"createdAt")
    SELECT 'closure_tied_dm_'||i,$1,$2,$3,'message '||i,'2026-06-01'::timestamp FROM generate_series(1,51) i`, [conv, aid, bid])

  const collected: { id: string }[] = []
  let afterTs: string | undefined = '2000-01-01T00:00:00.000Z'
  let afterId: string | undefined = ''
  let rounds = 0
  while (rounds < 5) {
    rounds++
    const qs = new URLSearchParams({ afterTs: afterTs! })
    if (afterId) qs.set('afterId', afterId!)
    const res = await api(`/api/messages/${conv}?${qs}`, { cookie: b.cookie })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { messages: { id: string; createdAt: string }[]; hasMore?: boolean }
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages.length).toBeLessThanOrEqual(50)
    collected.push(...body.messages.map((m) => ({ id: m.id })))
    if (body.messages.length === 0 || body.hasMore === false) break
    const last = body.messages[body.messages.length - 1]
    afterTs = last.createdAt
    afterId = last.id
  }
  expect(collected).toHaveLength(51)
  expect(new Set(collected.map((m) => m.id)).size).toBe(51)
})

// ── C4: likes list must exclude soft-deleted root posts (SQL, pre-pagination) ──

it('likes list excludes a deleted root post like ordinary feeds', async () => {
  const writes = await import('@/lib/services/post-write.service')
  const { setPostInteraction } = await import('@/lib/services/interaction.service')
  const { getTimelinePage } = await import('@/lib/services/post.service')
  const actor = { id: aid, role: 'user', verificationStatus: 'unverified' }
  const created = await writes.createPost(actor, { content: 'closure deleted like', parentId: null, quotePostId: null, images: [], casNumbers: null })
  if (!created.ok) throw new Error('fixture creation failed')
  const code = created.data.shortCode!
  expect((await setPostInteraction({ ...actor, id: bid }, code, 'like', true)).ok).toBe(true)
  const before = await getTimelinePage({ tab: 'latest', likedBy: bid, userId: bid })
  expect(before.posts.some((p) => p.id === created.data.id)).toBe(true)
  expect((await writes.deletePost(actor, code)).ok).toBe(true)
  const page = await getTimelinePage({ tab: 'latest', likedBy: bid, userId: bid })
  expect(page.posts.some((p) => p.id === created.data.id)).toBe(false)
})

// ── B4/G01: reply notifications are durable outbox tasks, not fire-and-forget ──

it('a committed reply leaves a durable notification outbox task; drain failure is observable and recoverable', async () => {
  const writes = await import('@/lib/services/post-write.service')
  const actor = { id: aid, role: 'user', verificationStatus: 'unverified' }
  const root = await writes.createPost(actor, { content: 'closure outbox parent', parentId: null, quotePostId: null, images: [], casNumbers: null })
  if (!root.ok) throw new Error('fixture failed')
  await sql('DELETE FROM "SideEffectTask"')
  await sql('DELETE FROM "Notification" WHERE "postId"=$1 AND type=\'COMMENT\'', [root.data.id])
  const reply = await writes.createPost({ ...actor, id: bid }, { content: 'closure outbox reply', parentId: root.data.id, quotePostId: null, images: [], casNumbers: null })
  expect(reply.ok).toBe(true)

  // The notification task must exist durably (enqueued in the reply's transaction).
  const tasks = await sql<{ id: string; status: string; attempts: number }>(
    'SELECT id, status, attempts FROM "SideEffectTask" WHERE kind=\'notification\'',
  )
  expect(tasks.length).toBe(1)

  // Deterministic failure injection at the executor boundary (the real
  // post-commit drain has already succeeded above; these prove the failure
  // and recovery semantics of the mechanism itself).
  const outbox = await import('@/lib/services/side-effect.service')
  const seed = await sql<{ id: string }>(
    `INSERT INTO "SideEffectTask" (id, kind, payload, "createdAt", "updatedAt")
     VALUES ('closure_fail_task','notification',$1::jsonb, now(), now()) RETURNING id`,
    [JSON.stringify({ userId: bid, fromId: aid, type: 'FOLLOW', eventKey: 'closure-reg-fail' })],
  )
  const failing: Record<string, (p: never) => Promise<void>> = {
    notification: async () => { throw new Error('synthetic delivery outage') },
    upload_cleanup: async () => {},
  }
  const failed = await outbox.drainSideEffects({ ids: [seed[0].id], executors: failing as never })
  expect(failed.failed).toBe(1)
  const afterFailure = await sql<{ status: string; attempts: number; lastError: string | null }>(
    'SELECT status, attempts, "lastError" FROM "SideEffectTask" WHERE id=$1', [seed[0].id],
  )
  expect(afterFailure[0].status).toBe('pending')
  expect(afterFailure[0].attempts).toBe(1)
  expect(afterFailure[0].lastError).toContain('synthetic delivery outage')

  // Recovery: a plain drain delivers the notification and completes the task.
  const recovered = await outbox.drainSideEffects({ ids: [seed[0].id] })
  expect(recovered.succeeded).toBe(1)
  const task = await sql<{ status: string }>('SELECT status FROM "SideEffectTask" WHERE id=$1', [seed[0].id])
  expect(task[0].status).toBe('succeeded')
  const notif = await sql<{ n: number }>('SELECT count(*)::int n FROM "NotificationDelivery" WHERE "eventKey"=\'closure-reg-fail\'')
  expect(notif[0].n).toBe(1)
})

// ── E / F01: verification attachments are private, identity-gated media ──

it('verification upload lands in private storage and is only readable by the applicant and admins', async () => {
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#00ff00' } }).png().toBuffer()
  const form = new FormData()
  form.set('purpose', 'verification')
  form.set('file', new Blob([bytes], { type: 'image/png' }), 'synthetic-review.png')
  const res = await fetch(`${SERVER_URL}/api/upload`, { method: 'POST', headers: { Cookie: a.cookie }, body: form })
  expect(res.status).toBe(201)
  const image = (await res.json()) as { url: string; filename: string }
  syntheticPrivateFiles.push(image.filename)
  privateMediaUrl = image.url
  // The URL must NOT live in the public static space.
  expect(image.url.startsWith('/uploads/')).toBe(false)

  // Anonymous → 401; other member → 404 (no existence leak); applicant → 200.
  expect((await fetch(`${SERVER_URL}${image.url}`)).status).toBe(401)
  expect((await fetch(`${SERVER_URL}${image.url}`, { headers: { Cookie: b.cookie } })).status).toBe(404)
  const own = await fetch(`${SERVER_URL}${image.url}`, { headers: { Cookie: a.cookie } })
  expect(own.status).toBe(200)
  expect(own.headers.get('content-type')).toContain('image/')
  expect(own.headers.get('cache-control')).toContain('no-store')

  // Path traversal is rejected.
  const evil = await fetch(`${SERVER_URL}/api/media/verification/..%2F..%2Fpackage.json`, { headers: { Cookie: a.cookie } })
  expect([400, 404]).toContain(evil.status)
})

it('verification submission accepts private media URLs and they cannot leak into public posts', async () => {
  expect(privateMediaUrl).toBeTruthy()
  const submit = await api('/api/account/verification', {
    method: 'POST', cookie: a.cookie,
    body: JSON.stringify({ idName: 'Synthetic Tester', idNumber: 'SYN-0000', idFrontImage: privateMediaUrl, idBackImage: privateMediaUrl }),
  })
  expect(submit.status).toBe(200)

  // Public post creation must not accept the private URL as an image.
  const post = await api('/api/posts', {
    method: 'POST', cookie: a.cookie,
    body: JSON.stringify({ content: 'closure private leak attempt', images: [privateMediaUrl] }),
  })
  expect(post.status).toBe(201)
  const body = (await post.json()) as { images?: string[]; data?: { images?: string[] } }
  const images = body.images ?? body.data?.images ?? []
  expect(images).not.toContain(privateMediaUrl)
})

it('admin reviewers can read verification attachments; expired/deleted submissions deny access', async () => {
  expect(privateMediaUrl).toBeTruthy()
  // Make the only admin (role exists in test DB? promote b for the check)
  await sql('UPDATE "User" SET role=\'admin\' WHERE id=$1', [bid])
  const admin = await fetch(`${SERVER_URL}${privateMediaUrl}`, { headers: { Cookie: b.cookie } })
  expect(admin.status).toBe(200)
  await sql('UPDATE "User" SET role=\'user\' WHERE id=$1', [bid])
})

// Cleanup: remove the synthetic media created for this suite.
afterAll(async () => {
  const { rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  for (const filename of syntheticPrivateFiles) {
    await rm(join(privateUploadDir(), filename), { force: true })
  }
})
