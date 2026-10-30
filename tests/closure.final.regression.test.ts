import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { provisionTestDatabase, dropTestDatabase, promoteUser, sql } from './helpers/db'
import { SERVER_URL, TEST_DATABASE_URL } from './helpers/env'
import { startTestServer, stopTestServer } from './helpers/server'
import { api, registerAndLogin, type Session } from './helpers/http'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (f: unknown) => f }))
const db = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => db)
let pool: Pool
let a: Session, b: Session, c: Session
let aid: string, bid: string, cid: string
let recoveryTaskId: string
let readKey: string
const files: string[] = []

beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(TEST_DATABASE_URL).hostname)) throw Error('Local only')
  await provisionTestDatabase()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 })
  db.prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  for (const id of ['final_recovery_recipient', 'final_recovery_actor']) {
    await db.prisma.user.create({ data: { id, username: id, email: id + '@test.local', passwordHash: 'x' } })
  }
  const task = await db.prisma.sideEffectTask.create({ data: {
    kind: 'notification',
    payload: { userId: 'final_recovery_recipient', fromId: 'final_recovery_actor', type: 'FOLLOW', eventKey: 'final-http-recovery' },
  } })
  recoveryTaskId = task.id
  // The readiness probe is a real GET /api/posts. No write request has
  // occurred when the assertion below observes automatic backlog recovery.
  await startTestServer()
  a = await registerAndLogin('final_a'); b = await registerAndLogin('final_b'); c = await registerAndLogin('final_c')
  aid = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [a.username]))[0].id
  bid = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [b.username]))[0].id
  cid = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [c.username]))[0].id
  await promoteUser(a.username, { verified: true })
  const keyRes = await api('/api/account/api-keys', { method: 'POST', cookie: b.cookie, body: JSON.stringify({ name: 'read-recovery' }) })
  expect(keyRes.status).toBe(201)
  readKey = (await keyRes.json()).rawKey
})

afterAll(async () => {
  vi.restoreAllMocks()
  await stopTestServer()
  await db.prisma?.$disconnect(); await pool?.end(); await dropTestDatabase()
  for (const file of files) await rm(file, { force: true })
})

it('ordinary REST reads recover a committed task without a new business write', async () => {
  await expect.poll(async () => (await db.prisma.sideEffectTask.findUniqueOrThrow({ where: { id: recoveryTaskId } })).status,
    { timeout: 10_000 }).toBe('succeeded')
})

it('MCP read-only traffic recovers pending notifications after the shared recovery throttle', async () => {
  const task = await db.prisma.sideEffectTask.create({ data: {
    kind: 'notification', payload: { userId: aid, fromId: bid, type: 'FOLLOW', eventKey: 'final-mcp-recovery' },
  } })
  const client = new Client({ name: 'final-recovery', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', SERVER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${readKey}` } },
  }))
  try {
    await expect.poll(async () => {
      const result = await client.callTool({ name: 'list_notifications', arguments: {} })
      expect(result.isError).toBeFalsy()
      return (await db.prisma.sideEffectTask.findUniqueOrThrow({ where: { id: task.id } })).status
    }, { timeout: 40_000, interval: 1000 }).toBe('succeeded')
    const delivered = await db.prisma.notification.findFirstOrThrow({ where: { userId: aid, fromId: bid, type: 'FOLLOW' } })
    expect(delivered.read).toBe(false)
  } finally { await client.close() }
}, 45_000)

it('successive replies update REST/MCP context while retrying an old event remains a no-op', async () => {
  const parentResponse = await api('/api/posts', { method: 'POST', cookie: a.cookie, body: JSON.stringify({ content: 'Final discussion parent' }) })
  expect(parentResponse.status).toBe(201)
  const parent = await parentResponse.json()
  const replies: { id: string; shortCode: string }[] = []
  for (const content of ['First reply', 'Second reply']) {
    const res = await api('/api/posts', { method: 'POST', cookie: b.cookie, body: JSON.stringify({ content, parentId: parent.id }) })
    expect(res.status).toBe(201); replies.push(await res.json())
  }
  const page = await (await api('/api/notifications', { cookie: a.cookie })).json()
  const n = page.notifications.find((row: { postId: string }) => row.postId === parent.id)
  expect(n.replyShortCode).toBe(replies[1].shortCode)
  const row = await db.prisma.notification.findUniqueOrThrow({ where: { id: n.id } })
  expect(row.eventKey).toBe('reply:' + replies[0].id)
  expect(row.replyPostId).toBe(replies[1].id)
  await db.prisma.notification.update({ where: { id: row.id }, data: { read: true } })
  const { deliverNotification } = await import('@/lib/notification')
  await deliverNotification({ userId: aid, fromId: bid, type: 'COMMENT', postId: parent.id, eventKey: 'reply:' + replies[0].id })
  const after = await db.prisma.notification.findUniqueOrThrow({ where: { id: row.id } })
  expect(after.read).toBe(true)
  expect(after.replyPostId).toBe(replies[1].id)
  expect(after.revision).toBe(row.revision)
  const keyRes = await api('/api/account/api-keys', { method: 'POST', cookie: a.cookie, body: JSON.stringify({ name: 'reply-context' }) })
  expect(keyRes.status).toBe(201)
  const client = new Client({ name: 'final-reply', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', SERVER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${(await keyRes.json()).rawKey}` } },
  }))
  try {
    const result = await client.callTool({ name: 'list_notifications', arguments: {} })
    const inbox = result.structuredContent as { notifications: { postId: string; replyShortCode: string }[] }
    expect(inbox.notifications.find((item) => item.postId === parent.id)?.replyShortCode).toBe(replies[1].shortCode)
  } finally { await client.close() }
})

it('a submission committed after a stale ownership scan preserves its anchor and preview', async () => {
  const name = randomUUID() + '.webp', url = '/api/media/verification/' + name
  const file = path.join('private-uploads', name)
  await mkdir('private-uploads', { recursive: true })
  await writeFile(file, await sharp({ create: { width: 4, height: 4, channels: 3, background: '#00aa00' } }).webp().toBuffer())
  files.push(file)
  await db.prisma.privateMedia.create({ data: { filename: name, userId: cid, createdAt: new Date(Date.now() - 25 * 3600_000) } })
  let ready!: () => void, release!: () => void
  const arrived = new Promise<void>((r) => { ready = r }), gate = new Promise<void>((r) => { release = r })
  const original = db.prisma.privateMedia.findMany.bind(db.prisma.privateMedia)
  const spy = vi.spyOn(db.prisma.privateMedia, 'findMany').mockImplementationOnce((async (...args: Parameters<typeof original>) => {
    const rows = await original(...args); ready(); await gate; return rows
  }) as never)
  const { sweepStalePrivateMedia } = await import('@/lib/upload-sweep')
  const sweeping = sweepStalePrivateMedia()
  try {
    await arrived
    const submit = await api('/api/account/verification', { method: 'POST', cookie: c.cookie, body: JSON.stringify({ idName: 'Synthetic', idNumber: 'TEST', idFrontImage: url, idBackImage: url }) })
    expect(submit.status).toBe(200)
  } finally { release() }
  expect(await sweeping).toBe(0); spy.mockRestore()
  expect((await api(url, { cookie: c.cookie })).status).toBe(200)
  expect(await db.prisma.privateMedia.count({ where: { filename: name } })).toBe(1)
})

it('ack validates the complete batch before writing, including the database integer boundary', async () => {
  const n = await db.prisma.notification.create({ data: { userId: cid, fromId: aid, type: 'FOLLOW' } })
  for (const revision of [2147483648, 1e100, -1, 0.5]) {
    const result = await api('/api/notifications/ack', { method: 'POST', cookie: a.cookie, body: JSON.stringify({ items: [{ id: n.id, revision }] }) })
    expect(result.status).toBe(400)
  }
  const res = await api('/api/notifications/ack', { method: 'POST', cookie: c.cookie, body: JSON.stringify({ items: [{ id: n.id, revision: 0 }, { id: n.id, revision: 2147483648 }] }) })
  expect(res.status).toBe(400)
  expect((await db.prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).read).toBe(false)
  const valid = await api('/api/notifications/ack', { method: 'POST', cookie: c.cookie, body: JSON.stringify({ items: [{ id: n.id, revision: 0 }] }) })
  expect(valid.status).toBe(200)
  expect((await valid.json()).confirmed).toBe(1)
})

it('locked upload cleanup needs only its own transaction connection', async () => {
  const name = randomUUID() + '.webp', url = '/uploads/' + name
  const file = path.join('public', 'uploads', name)
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'synthetic')
  files.push(file)
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const singlePool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 500 })
  const singleClient = new PrismaClient({ adapter: new PrismaPg(singlePool) })
  const previous = db.prisma
  db.prisma = singleClient
  try {
    const { removeUnreferencedUpload } = await import('@/lib/upload-cleanup')
    await removeUnreferencedUpload(url)
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    db.prisma = previous
    await singleClient.$disconnect(); await singlePool.end()
  }
})
