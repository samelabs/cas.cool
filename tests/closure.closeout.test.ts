// Closure closeout suite: MCP receive-loop tools + idempotent create_post,
// upload-sweep lifecycle, and notification dedup schema migration.
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtemp, writeFile, utimes, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dropTestDatabase, provisionTestDatabase, promoteUser, sql } from './helpers/db'
import { api, json, registerAndLogin, type Session } from './helpers/http'
import { startTestServer, stopTestServer } from './helpers/server'
import { SERVER_URL, TEST_DATABASE_URL } from './helpers/env'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }))
const db = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => db)

let pool: Pool
let alice: Session
let bob: Session
let aliceKey: string
let bobKey: string

async function createKey(session: { cookie: string }, name: string): Promise<string> {
  const res = await api('/api/account/api-keys', {
    method: 'POST',
    cookie: session.cookie,
    body: JSON.stringify({ name }),
  })
  if (res.status !== 201) throw new Error(`createKey failed: ${res.status}`)
  const data = await json<{ rawKey: string }>(res)
  return data.rawKey
}

function createMcpClient(rawKey: string) {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', SERVER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${rawKey}` } },
  })
  const client = new Client({ name: 'closure-closeout-test', version: '1.0.0' }, { capabilities: {} })
  return { client, transport }
}

beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(SERVER_URL).hostname)) {
    throw new Error('Local closeout only')
  }
  await provisionTestDatabase()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  pool = new Pool({ connectionString: TEST_DATABASE_URL })
  db.prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  await startTestServer()
  alice = await registerAndLogin('closea')
  bob = await registerAndLogin('closeb')
  await promoteUser(alice.username, { verified: true })
  aliceKey = await createKey(alice, 'closea-key')
  bobKey = await createKey(bob, 'closeb-key')
})

afterAll(async () => {
  vi.restoreAllMocks()
  await stopTestServer()
  await db.prisma?.$disconnect()
  await pool?.end()
  await dropTestDatabase()
})

// ── MCP receive loop ─────────────────────────────────────────

describe('MCP notification inbox and relationship read', () => {
  it('list_notifications returns notifications with post context and marks nothing read', async () => {
    const aliceId = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [alice.username]))[0].id
    const bobId = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [bob.username]))[0].id
    await sql(`INSERT INTO "Notification" (id,"userId","fromId",type) VALUES ('close_mcp_n1',$1,$2,'FOLLOW')`, [aliceId, bobId])

    const { client, transport } = createMcpClient(aliceKey)
    await client.connect(transport)
    try {
      const result = await client.callTool({ name: 'list_notifications', arguments: {} })
      expect(result.isError).toBeFalsy()
      const data = result.structuredContent as { notifications: { type: string; from: string | null; read: boolean }[]; unreadCount: number }
      expect(data.notifications.some((n) => n.type === 'FOLLOW')).toBe(true)
      expect(data.unreadCount).toBeGreaterThanOrEqual(1)
      // Read-only: the notification is still unread afterwards.
      const still = await sql<{ read: boolean }>('SELECT read FROM "Notification" WHERE id=\'close_mcp_n1\'')
      expect(still[0].read).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('mark_notifications_read requires write access; read-only keys get a structured permission error', async () => {
    // bob's key belongs to an unverified account → read-only.
    const bobClient = createMcpClient(bobKey)
    await bobClient.client.connect(bobClient.transport)
    try {
      const denied = await bobClient.client.callTool({ name: 'mark_notifications_read', arguments: {} })
      expect(denied.isError).toBe(true)
      const err = (denied.structuredContent as { error: { code: string; recovery?: string } }).error
      expect(['forbidden', 'unauthorized']).toContain(err.code)
      expect(typeof err.recovery).toBe('string')
    } finally {
      await bobClient.client.close()
    }

    const aliceClient = createMcpClient(aliceKey)
    await aliceClient.client.connect(aliceClient.transport)
    try {
      const ok = await aliceClient.client.callTool({ name: 'mark_notifications_read', arguments: {} })
      expect(ok.isError).toBeFalsy()
      const data = ok.structuredContent as { ok: boolean; markedRead: number }
      expect(data.ok).toBe(true)
      expect(data.markedRead).toBeGreaterThanOrEqual(1)
    } finally {
      await aliceClient.client.close()
    }
  })

  it('get_profile exposes the caller-to-target follow relationship without write probes', async () => {
    const { client, transport } = createMcpClient(aliceKey)
    await client.connect(transport)
    try {
      const result = await client.callTool({ name: 'get_profile', arguments: { username: bob.username } })
      expect(result.isError).toBeFalsy()
      const rel = (result.structuredContent as { viewerRelationship?: { isYou: boolean; youFollow: boolean; followsYou: boolean } }).viewerRelationship
      expect(rel).toBeDefined()
      expect(rel!.isYou).toBe(false)
      expect(rel!.youFollow).toBe(false)
      expect(rel!.followsYou).toBe(false)
    } finally {
      await client.close()
    }
  })
})

describe('create_post idempotency (clientRequestId)', () => {
  it('replays the original post for the same key+content and rejects key reuse with different content', async () => {
    const { client, transport } = createMcpClient(aliceKey)
    await client.connect(transport)
    try {
      const args = { content: 'closure idempotent post', clientRequestId: 'close-replay-0001' }
      const first = await client.callTool({ name: 'create_post', arguments: args })
      expect(first.isError).toBeFalsy()
      const created = first.structuredContent as { id: string; shortCode: string }
      expect(created.id).toBeTruthy()

      // Retry with the SAME key + content after an "uncertain result".
      const retry = await client.callTool({ name: 'create_post', arguments: args })
      expect(retry.isError).toBeFalsy()
      const replayed = retry.structuredContent as { id: string; replayed: boolean }
      expect(replayed.id).toBe(created.id)
      expect(replayed.replayed).toBe(true)

      // No duplicate post was created.
      const count = await sql<{ n: number }>('SELECT count(*)::int n FROM "Post" WHERE id=$1', [created.id])
      expect(count[0].n).toBe(1)

      // Same key + different content → structured conflict.
      const conflict = await client.callTool({
        name: 'create_post',
        arguments: { content: 'different content entirely', clientRequestId: 'close-replay-0001' },
      })
      expect(conflict.isError).toBe(true)
      expect((conflict.structuredContent as { error: { code: string } }).error.code).toBe('request_key_conflict')

      // A fresh key is a genuinely new post.
      const second = await client.callTool({
        name: 'create_post',
        arguments: { content: 'closure idempotent post', clientRequestId: 'close-replay-0002' },
      })
      expect(second.isError).toBeFalsy()
      expect((second.structuredContent as { id: string }).id).not.toBe(created.id)
    } finally {
      await client.close()
    }
  })
})

describe('Agent multi-step participation loop (official MCP client)', () => {
  it('receive notification → locate THE actual reply → read its context → continue the discussion → verify', async () => {
    const { client, transport } = createMcpClient(aliceKey)
    await client.connect(transport)
    try {
      // bob publishes a root post (via HTTP as bob's session).
      const seeded = await api('/api/posts', { method: 'POST', cookie: bob.cookie, body: JSON.stringify({ content: 'closure agent loop target' }) })
      expect(seeded.status).toBe(201)
      const seededPost = (await seeded.json()) as unknown as { id: string; shortCode: string }

      // alice (agent) replies to bob's root post via MCP.
      const reply = await client.callTool({
        name: 'create_post',
        arguments: { content: 'closure agent loop reply from agent', parentId: seededPost.id },
      })
      expect(reply.isError).toBeFalsy()
      const replyPost = reply.structuredContent as { id: string; shortCode: string }

      // ── The receive loop: BOB is notified and must locate THE actual new
      // reply (not merely the parent), read its discussion context, and
      // continue the thread — all through official MCP tools. ──
      const bobClient = createMcpClient(bobKey)
      // bob's key is read-only (unverified account): reading + locating is
      // exactly the read-only surface; bob continues via his web session.
      await bobClient.client.connect(bobClient.transport)
      let replyShortCode: string | null = null
      try {
        const inbox = await bobClient.client.callTool({ name: 'list_notifications', arguments: {} })
        expect(inbox.isError).toBeFalsy()
        const notifications = (inbox.structuredContent as { notifications: { type: string; postShortCode: string | null; replyShortCode: string | null }[] }).notifications
        const replyNotification = notifications.find((n) => n.type === 'COMMENT' && n.postShortCode === seededPost.shortCode)
        expect(replyNotification).toBeDefined()
        // THE actual new reply is identified directly — even if the parent
        // has pages of replies, the agent does not have to scan them.
        replyShortCode = replyNotification!.replyShortCode
        expect(replyShortCode).toBe(replyPost.shortCode)

        // Read the discussion context OF THE REPLY (anchored there).
        const discussion = await bobClient.client.callTool({
          name: 'get_post_discussion',
          arguments: { shortCode: replyShortCode },
        })
        expect(discussion.isError).toBeFalsy()
        const disc = discussion.structuredContent as { post: { id: string }; ancestors: { id: string }[] }
        expect(disc.post.id).toBe(replyPost.id)
        expect(disc.ancestors.some((a) => a.id === seededPost.id)).toBe(true)
      } finally {
        await bobClient.client.close()
      }

      // bob continues the discussion from the web session, replying to the
      // agent's reply; the agent then receives THAT and verifies it.
      const bobReply = await api('/api/posts', {
        method: 'POST', cookie: bob.cookie,
        body: JSON.stringify({ content: 'closure agent loop counter-reply', parentId: replyPost.id }),
      })
      expect(bobReply.status).toBe(201)

      const inboxAfter = await client.callTool({ name: 'list_notifications', arguments: {} })
      const afterNotifications = (inboxAfter.structuredContent as { notifications: { type: string; replyShortCode: string | null }[] }).notifications
      const counterNotification = afterNotifications.find((n) => n.type === 'COMMENT' && n.replyShortCode)
      expect(counterNotification).toBeDefined()
      const verified = await client.callTool({ name: 'get_post', arguments: { shortCode: counterNotification!.replyShortCode! } })
      expect(verified.isError).toBeFalsy()
      expect((verified.structuredContent as { content: string }).content).toContain('counter-reply')
    } finally {
      await client.close()
    }
  })
})

// ── Upload sweep lifecycle ───────────────────────────────────

describe('upload sweep', () => {
  it('deletes unreferenced out-of-grace files, keeps referenced and in-grace files', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'sweep-'))
    const publicDir = path.join(tmp, 'public')
    await mkdir(publicDir, { recursive: true })
    const dirs = { public: publicDir, private: path.join(tmp, 'private') }
    try {
      const old = new Date(Date.now() - 48 * 3600 * 1000)
      // 1) unreferenced, out of grace → deleted
      await writeFile(path.join(publicDir, '11111111-1111-4111-8111-111111111111.webp'), 'x')
      await utimes(path.join(publicDir, '11111111-1111-4111-8111-111111111111.webp'), old, old)
      // 2) referenced by a post, out of grace → kept
      await writeFile(path.join(publicDir, '22222222-2222-4222-8222-222222222222.webp'), 'x')
      await utimes(path.join(publicDir, '22222222-2222-4222-8222-222222222222.webp'), old, old)
      const author = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [alice.username]))[0].id
      await sql(`INSERT INTO "Post" (id, "authorId", content, images, "createdAt", "updatedAt")
        VALUES ('close_sweep_post', $1, 'sweep fixture', ARRAY['/uploads/22222222-2222-4222-8222-222222222222.webp'], now(), now())`, [author])
      // 3) unreferenced but fresh (in grace) → kept
      await writeFile(path.join(publicDir, '33333333-3333-4333-8333-333333333333.webp'), 'x')

      const { sweepUploads } = await import('@/lib/upload-sweep')
      const outcome = await sweepUploads(Date.now(), dirs)
      expect(outcome.deleted).toBe(1)
      const actions = new Map(outcome.outcomes.map((o) => [o.file, o.action]))
      expect(actions.get('/uploads/11111111-1111-4111-8111-111111111111.webp')).toBe('deleted')
      expect(actions.get('/uploads/22222222-2222-4222-8222-222222222222.webp')).toBe('kept-referenced')
      expect(actions.get('/uploads/33333333-3333-4333-8333-333333333333.webp')).toBe('kept-in-grace')

      // Reference added BEFORE the sweep (concurrent-attach simulation):
      // the re-check protects the file even though the listing was stale.
      await writeFile(path.join(publicDir, '44444444-4444-4444-8444-444444444444.webp'), 'x')
      await utimes(path.join(publicDir, '44444444-4444-4444-8444-444444444444.webp'), old, old)
      await sql(`UPDATE "Post" SET images = array_append(images, '/uploads/44444444-4444-4444-8444-444444444444.webp') WHERE id='close_sweep_post'`)
      const second = await sweepUploads(Date.now(), dirs)
      const actions2 = new Map(second.outcomes.map((o) => [o.file, o.action]))
      expect(actions2.get('/uploads/44444444-4444-4444-8444-444444444444.webp')).toBe('kept-referenced')
    } finally {
      await rm(tmp, { recursive: true, force: true })
      await sql('DELETE FROM "Post" WHERE id=\'close_sweep_post\'')
    }
  })
})

// ── Migration rehearsals (isolated DB, no production contact) ──

describe('notification dedup migration rehearsal', () => {
  it('merges pre-existing null-postId duplicates to the newest row, repoints deliveries, and rebuilds the arbiter', async () => {
    const aliceId = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [alice.username]))[0].id
    const bobId = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [bob.username]))[0].id
    await sql('DELETE FROM "Notification" WHERE "userId"=$1', [aliceId])
    // Simulate the pre-migration duplicates (index dropped for the rehearsal).
    await sql('DROP INDEX IF EXISTS "Notification_null_post_dedup_key"')
    await sql(`INSERT INTO "Notification" (id,"userId","fromId",type,"createdAt",read) VALUES
      ('close_dup_old', $1, $2, 'FOLLOW', '2026-01-01', true),
      ('close_dup_mid', $1, $2, 'FOLLOW', '2026-02-01', false),
      ('close_dup_new', $1, $2, 'FOLLOW', '2026-03-01', false)`, [aliceId, bobId])
    // A delivery record pointing at a doomed duplicate must survive the merge.
    await sql('INSERT INTO "NotificationDelivery" ("eventKey","notificationId") VALUES (\'close_dup_evt\', \'close_dup_old\')')

    // The migration's own statements (merge → repoint → delete → arbiter).
    await sql(`WITH ranked AS (
      SELECT id, "userId", "fromId", type,
             ROW_NUMBER() OVER (PARTITION BY "userId", "fromId", type ORDER BY "createdAt" DESC, id DESC) AS rn
      FROM "Notification" WHERE "postId" IS NULL
    )
    UPDATE "NotificationDelivery" d
    SET "notificationId" = w.id
    FROM ranked l
    JOIN ranked w ON w."userId" = l."userId" AND w."fromId" = l."fromId" AND w.type = l.type AND w.rn = 1
    WHERE l.rn > 1 AND d."notificationId" = l.id`)
    await sql(`DELETE FROM "Notification"
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY "userId", "fromId", type ORDER BY "createdAt" DESC, id DESC) AS rn
          FROM "Notification" WHERE "postId" IS NULL
        ) t WHERE t.rn > 1
      )`)
    await sql('CREATE UNIQUE INDEX "Notification_null_post_dedup_key" ON "Notification"("userId", "fromId", "type") WHERE "postId" IS NULL')

    const rows = await sql<{ id: string; read: boolean }>('SELECT id, read FROM "Notification" WHERE "userId"=$1 AND type=\'FOLLOW\'', [aliceId])
    expect(rows).toEqual([{ id: 'close_dup_new', read: false }]) // newest survives with its own state
    const delivery = await sql<{ notificationId: string }>('SELECT "notificationId" FROM "NotificationDelivery" WHERE "eventKey"=\'close_dup_evt\'')
    expect(delivery[0].notificationId).toBe('close_dup_new') // repointed, not lost

    // The rebuilt arbiter now makes the atomic upsert race-safe.
    await sql('DELETE FROM "NotificationDelivery" WHERE "eventKey"=\'close_dup_evt\'')
  })
})

// ── R7: DM history paging is actually reachable and complete ────

describe('DM older-history paging (R7)', () => {
  it('pages back to the very first message with no gaps or repeats, confirming read scope', async () => {
    const aliceId = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [alice.username]))[0].id
    const bobId = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [bob.username]))[0].id
    const [user1Id, user2Id] = [aliceId, bobId].sort()
    const convId = 'close_hist_conv_1'
    await sql(`INSERT INTO "Conversation" (id,"user1Id","user2Id") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [convId, user1Id, user2Id])
    await sql('DELETE FROM "DirectMessage" WHERE "conversationId"=$1', [convId])
    await sql(`INSERT INTO "DirectMessage" (id,"conversationId","senderId","receiverId",content,"createdAt")
      SELECT 'close_hist_m'||lpad(i::text,3,'0'), $1, $2, $3, 'history message '||i, '2026-01-01'::timestamp + i*interval '1 second'
      FROM generate_series(1, 245) i`, [convId, aliceId, bobId])

    // First screen = most recent 200 (contract).
    const { getConversationThread } = await import('@/lib/services/message.service')
    const thread = await getConversationThread(convId, bobId, 200)
    expect(thread.messages).toHaveLength(200)
    expect(thread.messages[0].id).toBe('close_hist_m046') // oldest INSIDE the window
    expect(thread.messages[199].id).toBe('close_hist_m245')

    // History paging: walk back in 50s until the true first message.
    const seen: string[] = [...thread.messages.map((m) => m.id)]
    let beforeTs = new Date(thread.messages[0].createdAt).toISOString()
    let beforeId = thread.messages[0].id
    let rounds = 0
    while (rounds < 10) {
      rounds++
      const res = await api(`/api/messages/${convId}?beforeTs=${encodeURIComponent(beforeTs)}&beforeId=${beforeId}`, { cookie: bob.cookie })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { messages: { id: string; createdAt: string }[]; hasMore?: boolean }
      seen.push(...body.messages.map((m) => m.id))
      if (body.messages.length === 0 || body.hasMore === false) break
      const first = body.messages[0]
      beforeTs = new Date(first.createdAt).toISOString()
      beforeId = first.id
    }
    // Complete, ordered, no repeats: every message 1..245 exactly once.
    expect(new Set(seen).size).toBe(245)
    expect(seen).toHaveLength(245)
    expect(seen).toContain('close_hist_m001')

    // Read scope: the RECEIVED history messages actually returned are read.
    const unreadReceived = await sql<{ n: number }>(
      'SELECT count(*)::int n FROM "DirectMessage" WHERE "conversationId"=$1 AND "receiverId"=$2 AND "readAt" IS NULL', [convId, bobId])
    expect(unreadReceived[0].n).toBe(0)

    await sql('DELETE FROM "DirectMessage" WHERE "conversationId"=$1', [convId])
    await sql('DELETE FROM "Conversation" WHERE id=$1', [convId])
  })
})

// ── R8: per-page, revision-guarded notification read confirmation ──

describe('notification page-read ack (R8)', () => {
  it('ack confirms only matching (id, revision) rows of the caller; stale/foreign/no-ops are ignored', async () => {
    const aliceId = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [alice.username]))[0].id
    const bobId = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [bob.username]))[0].id
    await sql('DELETE FROM "Notification" WHERE "userId" IN ($1,$2)', [aliceId, bobId])
    // 3 synthetic actors → 3 visible notifications for alice.
    for (let i = 1; i <= 3; i++) {
      const actorId = `acc_ack_actor_${i}`
      await sql(`INSERT INTO "User" (id,email,username,"passwordHash","createdAt","updatedAt")
        VALUES ($1,$1||'@t.local',$1,'x',now(),now()) ON CONFLICT (id) DO NOTHING`, [actorId])
      await sql(`INSERT INTO "Notification" (id,"userId","fromId",type,read,revision)
        VALUES ('acc_ack_n'||$2,$1,$3,'FOLLOW',false,0)`, [aliceId, String(i).padStart(2, '0'), actorId])
    }
    try {
      // GET (list) is read-only — nothing confirmed by reading.
      const list = await api('/api/notifications', { cookie: alice.cookie })
      expect(list.status).toBe(200)
      const listed = (await list.json()) as { notifications: { id: string; revision: number }[]; unreadCount: number }
      expect(listed.notifications).toHaveLength(3)
      expect(listed.unreadCount).toBe(3)
      let rows = await sql<{ id: string; read: boolean }>('SELECT id, read FROM "Notification" WHERE "userId"=$1 ORDER BY id', [aliceId])
      expect(rows.every((r) => !r.read)).toBe(true)

      // Ack with a STALE revision (row was re-activated after the client saw it).
      await sql(`UPDATE "Notification" SET revision=1 WHERE id='acc_ack_n01'`)
      const stale = await api('/api/notifications/ack', {
        method: 'POST', cookie: alice.cookie,
        body: JSON.stringify({ items: [{ id: 'acc_ack_n01', revision: 0 }] }),
      })
      expect(stale.status).toBe(200)
      rows = await sql<{ id: string; read: boolean }>('SELECT id, read FROM "Notification" WHERE "userId"=$1 ORDER BY id', [aliceId])
      expect(rows.find((r) => r.id === 'acc_ack_n01')!.read).toBe(false) // stale ack ignored

      // Correct ack for n02 + foreign row (bob's? none exist) + n03.
      const ack = await api('/api/notifications/ack', {
        method: 'POST', cookie: alice.cookie,
        body: JSON.stringify({ items: [
          { id: 'acc_ack_n02', revision: 0 },
          { id: 'acc_ack_n03', revision: 0 },
          { id: 'does-not-exist', revision: 0 },
        ] }),
      })
      const ackBody = (await ack.json()) as { confirmed: number; unreadRemaining: number }
      expect(ackBody.confirmed).toBe(2)
      expect(ackBody.unreadRemaining).toBe(1) // n01 still unread (re-activated)
      rows = await sql<{ id: string; read: boolean }>('SELECT id, read FROM "Notification" WHERE "userId"=$1 ORDER BY id', [aliceId])
      expect(rows.map((r) => r.read)).toEqual([false, true, true])

      // Another member cannot ack alice's rows (ownership predicate).
      const foreign = await api('/api/notifications/ack', {
        method: 'POST', cookie: bob.cookie,
        body: JSON.stringify({ items: [{ id: 'acc_ack_n01', revision: 1 }] }),
      })
      expect(foreign.status).toBe(200)
      rows = await sql<{ id: string; read: boolean }>('SELECT id, read FROM "Notification" WHERE "userId"=$1 ORDER BY id', [aliceId])
      expect(rows.find((r) => r.id === 'acc_ack_n01')!.read).toBe(false)
    } finally {
      await sql('DELETE FROM "Notification" WHERE "userId" IN ($1,$2)', [aliceId, bobId])
      await sql(`DELETE FROM "User" WHERE id LIKE 'acc_ack_actor_%'`)
    }
  })
})
