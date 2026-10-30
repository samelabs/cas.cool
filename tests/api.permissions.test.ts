/**
 * Unified API-key dynamic authorization matrix:
 * Key only proves identity. Programmatic write operations require current verification.
 * Unverified, pending, or restricted accounts are read-only.
 * Password changes strictly require a browser session.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropTestDatabase, provisionTestDatabase, promoteUser, sql } from './helpers/db'
import { api, json, registerAndLogin, type Session } from './helpers/http'
import { startTestServer, stopTestServer } from './helpers/server'

let alice: Session
let bob: Session
let unverifiedKey: string
let verifiedKey: string
let adminKey: string
let unverifiedAdminKey: string
let bobId: string
let alicePostCode: string
let aliceKeyId: string

async function createKey(
  session: { cookie: string },
  name: string,
): Promise<{ rawKey: string; id: string }> {
  const res = await api('/api/account/api-keys', {
    method: 'POST',
    cookie: session.cookie,
    body: JSON.stringify({ name }),
  })
  if (res.status !== 201) throw new Error(`key ${name}: ${res.status} ${await res.text()}`)
  return json<{ rawKey: string; id: string }>(res)
}

beforeAll(async () => {
  await provisionTestDatabase()
  await startTestServer()

  alice = await registerAndLogin('palice')
  bob = await registerAndLogin('pbob')
  await promoteUser(alice.username, { verified: true })
  // bob remains unverified

  // dedicated admin (registered through the API, promoted through the DB)
  const adminSession = await registerAndLogin('padm')
  await promoteUser(adminSession.username, { verified: true, admin: true })

  // unverified admin
  const unverifiedAdminSession = await registerAndLogin('punvadm')
  await promoteUser(unverifiedAdminSession.username, { verified: false, admin: true })

  const aliceKeyObj = await createKey(alice, 'alice-key')
  const bobKeyObj = await createKey(bob, 'bob-key')
  verifiedKey = aliceKeyObj.rawKey
  aliceKeyId = aliceKeyObj.id
  unverifiedKey = bobKeyObj.rawKey

  adminKey = (await createKey(adminSession, 'admin-key')).rawKey
  unverifiedAdminKey = (await createKey(unverifiedAdminSession, 'unverified-admin-key')).rawKey

  // A post owned by alice for edit/delete/interaction targets
  const postRes = await api('/api/posts', {
    method: 'POST',
    bearer: verifiedKey,
    body: JSON.stringify({ content: 'permission matrix target 64-17-5' }),
  })
  const post = await json<{ shortCode: string; id: string }>(postRes)
  alicePostCode = post.shortCode

  const rows = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = $1`, [bob.username])
  bobId = rows[0].id
})

afterAll(async () => {
  await stopTestServer()
  await dropTestDatabase()
})

const WRITE_ENDPOINTS: Array<{ label: string; run: (key: string) => Promise<Response> }> = [
  {
    label: 'POST /api/posts',
    run: (key) => api('/api/posts', { method: 'POST', bearer: key, body: JSON.stringify({ content: 'x' }) }),
  },
  {
    label: 'PATCH /api/posts/:code (own)',
    run: (key) => api(`/api/posts/${alicePostCode}`, { method: 'PATCH', bearer: key, body: JSON.stringify({ content: 'y' }) }),
  },
  {
    label: 'DELETE /api/posts/:code (own)',
    run: (key) => api(`/api/posts/${alicePostCode}`, { method: 'DELETE', bearer: key }),
  },
  {
    label: 'POST /api/posts/:code/like',
    run: (key) => api(`/api/posts/${alicePostCode}/like`, { method: 'POST', bearer: key }),
  },
  {
    label: 'DELETE /api/posts/:code/like',
    run: (key) => api(`/api/posts/${alicePostCode}/like`, { method: 'DELETE', bearer: key }),
  },
  {
    label: 'POST /api/upload',
    run: (key) =>
      api('/api/upload', {
        method: 'POST',
        bearer: key,
        body: 'file=x',
        headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
      }),
  },
  {
    label: 'POST /api/users/:username/follow',
    run: (key) => api(`/api/users/${bob.username}/follow`, { method: 'POST', bearer: key }),
  },
  {
    label: 'DELETE /api/users/:username/follow',
    run: (key) => api(`/api/users/${bob.username}/follow`, { method: 'DELETE', bearer: key }),
  },
  {
    label: 'POST /api/messages',
    run: (key) => api('/api/messages', { method: 'POST', bearer: key, body: JSON.stringify({ recipientId: bobId, content: 'hi' }) }),
  },
  {
    label: 'POST /api/notifications/read',
    run: (key) => api('/api/notifications/read', { method: 'POST', bearer: key }),
  },
  {
    label: 'POST /api/reports',
    run: (key) =>
      api('/api/reports', {
        method: 'POST',
        bearer: key,
        body: JSON.stringify({ targetType: 'POST', targetId: alicePostCode, reason: 'spam' }),
      }),
  },
  {
    label: 'PATCH /api/me/profile',
    run: (key) => api('/api/me/profile', { method: 'PATCH', bearer: key, body: JSON.stringify({ bio: 'x' }) }),
  },
  {
    label: 'POST /api/account/api-keys (create)',
    run: (key) => api('/api/account/api-keys', { method: 'POST', bearer: key, body: JSON.stringify({ name: 'z' }) }),
  },
  {
    label: 'DELETE /api/account/api-keys/:id (revoke)',
    run: (key) => api(`/api/account/api-keys/${aliceKeyId}`, { method: 'DELETE', bearer: key }),
  },
  {
    label: 'POST /api/account/verification',
    run: (key) =>
      api('/api/account/verification', {
        method: 'POST',
        bearer: key,
        body: JSON.stringify({ idName: 'a', idNumber: 'b', idFrontImage: '/uploads/a.webp', idBackImage: '/uploads/b.webp' }),
      }),
  },
]

describe('unverified keys are rejected on every write endpoint', () => {
  for (const ep of WRITE_ENDPOINTS) {
    it(ep.label, async () => {
      const res = await ep.run(unverifiedKey)
      expect(res.status).toBe(403)
      const body = await json<{ error: { code: string; message: string } }>(res)
      expect(body.error.code).toBe('forbidden')
      expect(body.error.message.length).toBeGreaterThan(0)
    })
  }
})

describe('verified key can write', () => {
  it('creates a post and toggles a like', async () => {
    const created = await api('/api/posts', {
      method: 'POST',
      bearer: verifiedKey,
      body: JSON.stringify({ content: 'verified key works' }),
    })
    expect(created.status).toBe(201)

    const like = await api(`/api/posts/${alicePostCode}/like`, { method: 'POST', bearer: verifiedKey })
    expect(like.status).toBe(200)
    const unlike = await api(`/api/posts/${alicePostCode}/like`, { method: 'DELETE', bearer: verifiedKey })
    expect(unlike.status).toBe(200)
  })
})

describe('admin operations', () => {
  it('unverified ADMIN key: lists OK, mutations 403', async () => {
    const list = await api('/api/admin/users', { bearer: unverifiedAdminKey })
    expect(list.status).toBe(200)

    const verifications = await api('/api/admin/verifications', { bearer: unverifiedAdminKey })
    expect(verifications.status).toBe(200)

    const reports = await api('/api/admin/reports', { bearer: unverifiedAdminKey })
    expect(reports.status).toBe(200)

    const mutations = [
      api('/api/admin/users/' + bobId, { method: 'PATCH', bearer: unverifiedAdminKey, body: JSON.stringify({ status: 'restricted' }) }),
      api(`/api/admin/users/${bobId}/verify`, { method: 'POST', bearer: unverifiedAdminKey }),
      api(`/api/admin/users/${bobId}/revoke-verification`, { method: 'POST', bearer: unverifiedAdminKey }),
      api('/api/admin/verifications/none/approve', { method: 'POST', bearer: unverifiedAdminKey }),
      api('/api/admin/verifications/none/reject', { method: 'POST', bearer: unverifiedAdminKey }),
      api('/api/admin/reports/none/resolve', { method: 'POST', bearer: unverifiedAdminKey }),
      api('/api/admin/reports/none/dismiss', { method: 'POST', bearer: unverifiedAdminKey }),
    ]
    for (const req of mutations) {
      const res = await req
      expect(res.status).toBe(403)
      const body = await json<{ error: { code: string; message: string } }>(res)
      expect(body.error.code).toBe('forbidden')
    }
  })

  it('verified ADMIN key passes the access gate (may then 404 on missing ids)', async () => {
    const res = await api('/api/admin/verifications/none/approve', { method: 'POST', bearer: adminKey })
    expect([404]).toContain(res.status) // past the permission gate; target absent
    expect(res.status).not.toBe(403)
  })
})

describe('password changes are session-only', () => {
  it('both unverified and verified keys are rejected', async () => {
    for (const key of [unverifiedKey, verifiedKey]) {
      const res = await api('/api/me/password', {
        method: 'POST',
        bearer: key,
        body: JSON.stringify({ currentPassword: 'password-123', newPassword: 'password-456' }),
      })
      expect(res.status).toBe(403)
      const body = await json<{ error: { code: string } }>(res)
      expect(body.error.code).toBe('forbidden')
    }
  })
})

describe('direct message read receipts write side-effect', () => {
  it('unverified key does not update readAt, while verified key or session records read receipt directly in DB', async () => {
    const [aliceRow] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = $1`, [alice.username])
    const aliceId = aliceRow.id

    // Seed conversation and unread message from alice to bob
    const convId = 'audit_conv_' + Date.now()
    const msgId = 'audit_msg_' + Date.now()
    await sql(`INSERT INTO "Conversation" (id, "user1Id", "user2Id", "createdAt", "lastAt")
      VALUES ($1, $2, $3, now(), now())`, [convId, aliceId, bobId])
    await sql(`INSERT INTO "DirectMessage" (id, "conversationId", "senderId", "receiverId", content, "readAt", "createdAt")
      VALUES ($1, $2, $3, $4, 'hello', null, now())`, [msgId, convId, aliceId, bobId])

    // Bob uses unverified key: receives message, but readAt must NOT be updated
    const res1 = await api(`/api/messages/${convId}?afterTs=2000-01-01T00:00:00.000Z`, { bearer: unverifiedKey })
    expect(res1.status).toBe(200)
    const [msgRow1] = await sql<{ readAt: Date | null }>(`SELECT "readAt" FROM "DirectMessage" WHERE id = $1`, [msgId])
    expect(msgRow1.readAt).toBeNull()

    // Bob uses web session (or verified key): receives message, and readAt is directly recorded in DB
    const res2 = await api(`/api/messages/${convId}?afterTs=2000-01-01T00:00:00.000Z`, { cookie: bob.cookie })
    expect(res2.status).toBe(200)
    const [msgRow2] = await sql<{ readAt: Date | null }>(`SELECT "readAt" FROM "DirectMessage" WHERE id = $1`, [msgId])
    expect(msgRow2.readAt).not.toBeNull()
  })
})

describe('post view telemetry deduplication and author exclusion', () => {
  it('author viewing own post does not increment views; first-time reader increments; subsequent view deduped', async () => {
    const [postBefore] = await sql<{ id: string; views: number }>(
      `SELECT id, views FROM "Post" WHERE "shortCode" = $1`,
      [alicePostCode],
    )
    const initialViews = postBefore.views
    const postId = postBefore.id

    // 1. Author (Alice) views her own post -> views must NOT increment
    const authorRes = await api(`/api/posts/${alicePostCode}/view`, {
      method: 'POST',
      cookie: alice.cookie,
    })
    expect(authorRes.status).toBe(200)
    const [postAfterAuthor] = await sql<{ views: number }>(
      `SELECT views FROM "Post" WHERE id = $1`,
      [postId],
    )
    expect(postAfterAuthor.views).toBe(initialViews)

    // Verify no PostView created for author
    const [authorViewRow] = await sql<{ count: string }>(
      `SELECT count(*)::text FROM "PostView" WHERE "postId" = $1 AND "userId" = (SELECT id FROM "User" WHERE username = $2)`,
      [postId, alice.username],
    )
    expect(authorViewRow.count).toBe('0')

    // 2. Reader (Bob) views for the first time -> views increments by exactly 1
    const readerRes1 = await api(`/api/posts/${alicePostCode}/view`, {
      method: 'POST',
      cookie: bob.cookie,
    })
    expect(readerRes1.status).toBe(200)
    const [postAfterReader1] = await sql<{ views: number }>(
      `SELECT views FROM "Post" WHERE id = $1`,
      [postId],
    )
    expect(postAfterReader1.views).toBe(initialViews + 1)

    // 3. Reader (Bob) views a second time -> views does NOT increment (deduplicated)
    const readerRes2 = await api(`/api/posts/${alicePostCode}/view`, {
      method: 'POST',
      cookie: bob.cookie,
    })
    expect(readerRes2.status).toBe(200)
    const [postAfterReader2] = await sql<{ views: number }>(
      `SELECT views FROM "Post" WHERE id = $1`,
      [postId],
    )
    expect(postAfterReader2.views).toBe(initialViews + 1)
  })
})
