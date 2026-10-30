/**
 * Public API contract tests — black-box HTTP against a real `next dev`
 * server + a throwaway migrated database (provisioned in beforeAll).
 *
 * These pin the Phase-1 baseline (docs/API-BASELINE.md): identity model,
 * error shape, key transactions and their counter invariants, permission
 * gates, and the auth-fallback trap. If a change here is intentional, the
 * baseline document must move with it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  agePostPastEditWindow,
  dropTestDatabase,
  promoteUser,
  provisionTestDatabase,
  sql,
} from './helpers/db'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { api, json, registerAndLogin, sessionCookie, type Session } from './helpers/http'
import { TEST_DATABASE_URL } from './helpers/env'
import { startTestServer, stopTestServer } from './helpers/server'

const PASSWORD = 'password-123'

let alice: Session
let bob: Session

beforeAll(async () => {
  await provisionTestDatabase()
  await startTestServer()
  alice = await registerAndLogin('alice')
  bob = await registerAndLogin('bob')
})

afterAll(async () => {
  await stopTestServer()
  await dropTestDatabase()
})

describe('identity model & error shape', () => {
  it('public endpoints answer 200 anonymously with the list envelope', async () => {
    const res = await api('/api/posts')
    expect(res.status).toBe(200)
    const body = await json<{ posts: unknown[]; nextCursor: string | null }>(res)
    expect(Array.isArray(body.posts)).toBe(true)
    expect('nextCursor' in body).toBe(true)
  })

  it('protected endpoints 401 anonymously with { error: { code } }', async () => {
    const res = await api('/api/notifications')
    expect(res.status).toBe(401)
    const body = await json<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('unauthorized')
  })

  it('session cookie authenticates (login round-trip after logout)', async () => {
    expect(await api('/api/auth/logout', { method: 'POST', cookie: alice.cookie }).then((r) => r.status)).toBe(200)

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: alice.email, password: PASSWORD }),
    })
    expect(login.status).toBe(200)
    const cookie = sessionCookie(login)
    expect(cookie).toBeTruthy()
    alice.cookie = cookie!

    const res = await api('/api/notifications', { cookie: alice.cookie })
    expect(res.status).toBe(200)
  })

  it('an invalid Bearer key is rejected when no session cookie is sent', async () => {
    const res = await api('/api/account/api-keys', { bearer: 'cas_totally-invalid-key-000' })
    expect(res.status).toBe(401)
  })

  it('an invalid Bearer does not fall back to the session cookie', async () => {
    const res = await api('/api/account/api-keys', {
      bearer: 'cas_totally-invalid-key-000',
      cookie: alice.cookie,
    })
    expect(res.status).toBe(401)
  })
})

describe('database-owned site identity', () => {
  it('uses the configured origin and name in discovery and metadata files', async () => {
    await sql('UPDATE "SiteConfig" SET "origin" = $1, "name" = $2, "shortName" = $3 WHERE id = 1', [
      'https://feed.example', 'Feed Example', 'Feed',
    ])
    // getSiteConfig is cached (unstable_cache, 1h). A fresh process reads
    // the row again — restarting the dev server makes this deterministic.
    // Production propagation is measured in docs/FEED-PERF.md: static
    // surfaces revalidate after their cache window; a clean rebuild and
    // restart are needed only for an immediate rebrand.
    await stopTestServer()
    await startTestServer()

    const [robots, manifest, discovery] = await Promise.all([
      api('/robots.txt'), api('/manifest.webmanifest'), api('/llms.txt'),
    ])
    expect(robots.status).toBe(200)
    expect(await robots.text()).toContain('https://feed.example/sitemap.xml')
    expect(manifest.status).toBe(200)
    expect((await manifest.json()).name).toBe('Feed Example')
    expect(discovery.status).toBe(200)
    const text = await discovery.text()
    expect(text).toContain('# Feed Example')
    expect(text).toContain('https://feed.example')
  })
})

describe('chemical associations (product layer, counters exact)', () => {
  async function chemicalCounts(cas: string[]): Promise<Record<string, number>> {
    const rows = await sql<{ casNumber: string; postCount: number }>(
      'SELECT "casNumber", "postCount" FROM "Chemical" WHERE "casNumber" = ANY($1)',
      [cas],
    )
    return Object.fromEntries(rows.map((r) => [r.casNumber, r.postCount]))
  }

  it('create links CAS numbers and increments Chemical.postCounts', async () => {
    const before = await chemicalCounts(['64-17-5', '50-00-0'])
    const res = await api('/api/posts', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ content: 'ethanol study 64-17-5', casNumbers: ['50-00-0'] }),
    })
    expect(res.status).toBe(201)
    const post = await json<{ chemicals: { casNumber: string }[] }>(res)
    expect(post.chemicals.map((c) => c.casNumber).sort()).toEqual(['50-00-0', '64-17-5'])

    const after = await chemicalCounts(['64-17-5', '50-00-0'])
    expect(after['64-17-5']).toBe((before['64-17-5'] ?? 0) + 1)
    expect(after['50-00-0']).toBe((before['50-00-0'] ?? 0) + 1)
  })

  it('edit swaps the chemical set and moves counts exactly', async () => {
    const created = await api('/api/posts', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ content: 'ethanol 64-17-5', casNumbers: ['64-17-5'] }),
    })
    const { shortCode } = await json<{ shortCode: string }>(created)
    const before = await chemicalCounts(['64-17-5', '50-00-0'])

    const patch = await api(`/api/posts/${shortCode}`, {
      method: 'PATCH',
      cookie: alice.cookie,
      body: JSON.stringify({ content: 'formaldehyde 50-00-0', casNumbers: ['50-00-0'] }),
    })
    expect(patch.status).toBe(200)
    const patched = await json<{ chemicals: { casNumber: string }[] }>(patch)
    expect(patched.chemicals.map((c) => c.casNumber)).toEqual(['50-00-0'])

    const got = await json<{ chemicals: { casNumber: string }[] }>(await api(`/api/posts/${shortCode}`))
    expect(got.chemicals.map((c) => c.casNumber)).toEqual(['50-00-0'])

    const after = await chemicalCounts(['64-17-5', '50-00-0'])
    expect(after['64-17-5']).toBe(before['64-17-5'] - 1)
    expect(after['50-00-0']).toBe(before['50-00-0'] + 1)
  })

  it('soft delete returns chemical counts', async () => {
    const created = await api('/api/posts', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ content: 'water 7732-18-5' }),
    })
    const { shortCode } = await json<{ shortCode: string }>(created)
    const before = (await chemicalCounts(['7732-18-5']))['7732-18-5']

    const del = await api(`/api/posts/${shortCode}`, { method: 'DELETE', cookie: alice.cookie })
    expect(del.status).toBe(200)

    const after = (await chemicalCounts(['7732-18-5']))['7732-18-5']
    expect(after).toBe(before - 1)
  })

  it('CAS filtering applies before keyset pagination and retains product tags', async () => {
    const marker = `caspage${Date.now().toString(36)}`
    const createdIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const res = await api('/api/posts', {
        method: 'POST', cookie: alice.cookie,
        body: JSON.stringify({ content: `${marker} ${i} 67-56-1` }),
      })
      expect(res.status).toBe(201)
      createdIds.push((await json<{ id: string }>(res)).id)
    }
    const found = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 8; page++) {
      const path: string = `/api/posts?tab=latest&cas=67-56-1&take=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await api(path)
      expect(res.status).toBe(200)
      const body = await json<{ posts: { id: string; chemicals: { casNumber: string }[] }[]; nextCursor: string | null }>(res)
      for (const post of body.posts) {
        expect(found.has(post.id), `post ${post.id} appeared on two pages`).toBe(false)
        expect(post.chemicals.map((chemical) => chemical.casNumber)).toContain('67-56-1')
        found.add(post.id)
      }
      cursor = body.nextCursor
      if (!cursor) break
    }
    for (const id of createdIds) {
      expect(found.has(id), `post ${id} was skipped by CAS pagination`).toBe(true)
    }
  })

  it('rejects CAS combinations that would otherwise ignore the filter', async () => {
    for (const path of [
      '/api/posts?tab=foryou&cas=64-17-5',
      '/api/posts?tab=latest&cas=64-17-5&since=2026-01-01T00%3A00%3A00.000Z',
      '/api/posts?tab=latest&cas=64-17-5&likedBy=user',
      '/api/posts?tab=latest&cas=64-17-5&bookmarkedBy=user',
    ]) {
      expect(await api(path).then((response) => response.status), path).toBe(400)
    }
  })

  it('attaches compound tags to quoted posts in both list and detail views', async () => {
    const sourceResponse = await api('/api/posts', {
      method: 'POST', cookie: alice.cookie,
      body: JSON.stringify({ content: 'quoted source 64-17-5' }),
    })
    expect(sourceResponse.status).toBe(201)
    const source = await json<{ id: string; authorId: string }>(sourceResponse)

    const quoteResponse = await api('/api/posts', {
      method: 'POST', cookie: alice.cookie,
      body: JSON.stringify({ content: 'Quote with context', quotePostId: source.id }),
    })
    expect(quoteResponse.status).toBe(201)
    const quote = await json<{ id: string; shortCode: string; quotedPost: { chemicals: { casNumber: string }[] } }>(quoteResponse)
    expect(quote.quotedPost.chemicals.map((chemical) => chemical.casNumber)).toContain('64-17-5')

    const detail = await json<typeof quote>(await api(`/api/posts/${quote.shortCode}`))
    expect(detail.quotedPost.chemicals.map((chemical) => chemical.casNumber)).toContain('64-17-5')

    const list = await json<{ posts: typeof quote[] }>(await api(`/api/posts?tab=latest&author=${source.authorId}`))
    expect(list.posts.find((post) => post.id === quote.id)?.quotedPost.chemicals.map((chemical) => chemical.casNumber)).toContain('64-17-5')
  })

  it('moderation deletion uses the same CAS count movement and stays idempotent', async () => {
    const admin = await registerAndLogin('chemadmin')
    await promoteUser(admin.username, { admin: true })
    const created = await api('/api/posts', {
      method: 'POST', cookie: alice.cookie,
      body: JSON.stringify({ content: 'moderation 75-07-0' }),
    })
    expect(created.status).toBe(201)
    const post = await json<{ id: string; shortCode: string }>(created)
    const reported = await api('/api/reports', {
      method: 'POST', cookie: bob.cookie,
      body: JSON.stringify({ targetType: 'POST', targetId: post.id, reason: 'spam' }),
    })
    expect(reported.status).toBe(201)
    const [report] = await sql<{ id: string }>('SELECT id FROM "Report" WHERE "postId" = $1 AND status = $2', [post.id, 'PENDING'])
    expect(report).toBeTruthy()
    const before = (await chemicalCounts(['75-07-0']))['75-07-0']
    const resolved = await api(`/api/admin/reports/${report.id}/resolve`, {
      method: 'POST', cookie: admin.cookie, body: JSON.stringify({ action: 'delete' }),
    })
    expect(resolved.status).toBe(200)
    expect((await chemicalCounts(['75-07-0']))['75-07-0']).toBe(before - 1)
    expect(await api(`/api/posts/${post.shortCode}`).then((r) => r.status)).toBe(404)
    // The author-side delete on the already-deleted post neither 500s nor
    // moves counters a second time.
    expect(await api(`/api/posts/${post.shortCode}`, { method: 'DELETE', cookie: alice.cookie }).then((r) => r.status)).toBe(404)
    expect((await chemicalCounts(['75-07-0']))['75-07-0']).toBe(before - 1)

    const notifsBefore = (await sql<{ count: string }>('SELECT count(*) FROM "Notification" WHERE type = $1', ['REPORT_RESOLVED']))[0].count
    // Replay of resolution must not re-execute penalties or duplicate notifications
    const replayed = await api(`/api/admin/reports/${report.id}/resolve`, {
      method: 'POST', cookie: admin.cookie, body: JSON.stringify({ action: 'delete' }),
    })
    expect(replayed.status).toBe(400)
    expect((await chemicalCounts(['75-07-0']))['75-07-0']).toBe(before - 1)
    const notifsAfter = (await sql<{ count: string }>('SELECT count(*) FROM "Notification" WHERE type = $1', ['REPORT_RESOLVED']))[0].count
    expect(notifsAfter).toBe(notifsBefore)

    // Attempting to suspend an admin fails atomically and leaves report PENDING
    const [adminUser] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [admin.username])
    const adminReportRes = await api('/api/reports', {
      method: 'POST', cookie: bob.cookie,
      body: JSON.stringify({ targetType: 'USER', targetId: adminUser.id, reason: 'harassment' }),
    })
    expect(adminReportRes.status).toBe(201)
    const [adminReport] = await sql<{ id: string }>('SELECT id FROM "Report" WHERE "reportedUserId" = $1 AND status = $2', [adminUser.id, 'PENDING'])
    expect(adminReport).toBeTruthy()
    const suspendAdminRes = await api(`/api/admin/reports/${adminReport.id}/resolve`, {
      method: 'POST', cookie: admin.cookie, body: JSON.stringify({ action: 'suspend' }),
    })
    expect(suspendAdminRes.status).toBe(400)
    const [stillPending] = await sql<{ status: string }>('SELECT status FROM "Report" WHERE id = $1', [adminReport.id])
    expect(stillPending.status).toBe('PENDING')
  })
})

describe('following feed', () => {
  it('returns posts from followed authors through the indexed relation', async () => {
    const reader = await registerAndLogin('feedreader')
    const follow = await api(`/api/users/${bob.username}/follow`, { method: 'POST', cookie: reader.cookie })
    expect(follow.status).toBe(200)
    const created = await api('/api/posts', {
      method: 'POST', cookie: bob.cookie,
      body: JSON.stringify({ content: 'followed author post 64-17-5' }),
    })
    expect(created.status).toBe(201)
    const page = await api('/api/posts?tab=following', { cookie: reader.cookie })
    expect(page.status).toBe(200)
    const result = await json<{ posts: { author: { username: string } }[] }>(page)
    expect(result.posts.some((p) => p.author.username === bob.username)).toBe(true)
    expect(result.posts.every((p) => p.author.username === bob.username)).toBe(true)
  })

  it('hydrates only selected authors for the latest page', async () => {
    for (const content of ['second post from Bob', 'third post from Bob']) {
      expect(await api('/api/posts', {
        method: 'POST', cookie: bob.cookie, body: JSON.stringify({ content }),
      }).then((r) => r.status)).toBe(201)
    }
    expect(await api('/api/posts', {
      method: 'POST', cookie: alice.cookie,
      body: JSON.stringify({ content: 'post from Alice' }),
    }).then((r) => r.status)).toBe(201)
    const page = await json<{ posts: { author: { username: string } }[] }>(
      await api('/api/posts?take=2'),
    )
    expect(page.posts.map((p) => p.author.username).sort()).toEqual([alice.username, bob.username].sort())
  })
})

describe('post lifecycle & counter invariants (key transactions)', () => {
  const marker = `marker${Date.now().toString(36)}`
  let rootCode: string
  let rootId: string

  it('unverified users cannot exceed the 300-char limit', async () => {
    const res = await api('/api/posts', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ content: 'x'.repeat(400) }),
    })
    expect(res.status).toBe(400)
    const body = await json<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('bad_request')
  })

  it('verified users can post 400 chars; CAS numbers are linked', async () => {
    await promoteUser(alice.username, { verified: true })
    const res = await api('/api/posts', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ content: `ethanol study 64-17-5 ${marker} ${'x'.repeat(360)}` }),
    })
    expect(res.status).toBe(201)
    const post = await json<{
      id: string
      shortCode: string
      author: { username: string }
      chemicals: { casNumber: string }[]
      _count: { replies: number; likes: number; reposts: number }
    }>(res)
    expect(post.id).toBeTruthy()
    expect(post.shortCode).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ]{8}$/)
    expect(post.author.username).toBe(alice.username)
    expect(post.chemicals.map((c) => c.casNumber)).toContain('64-17-5')
    rootId = post.id
    rootCode = post.shortCode
  })

  it('reply links via parentId (internal id) and bumps the parent reply count', async () => {
    const res = await api('/api/posts', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ content: 'a reply', parentId: rootId }),
    })
    expect(res.status).toBe(201)
    const reply = await json<{ parentId: string; conversationId: string }>(res)
    expect(reply.parentId).toBe(rootId)
    expect(reply.conversationId).toBe(rootId)

    const parent = await json<{ _count: { replies: number } }>(await api(`/api/posts/${rootCode}`))
    expect(parent._count.replies).toBe(1)
  })

  it('like and repost are idempotent and update denormalized counters', async () => {
    expect(await api(`/api/posts/${rootCode}/like`, { method: 'POST', cookie: alice.cookie }).then((r) => r.status)).toBe(200)
    expect(await api(`/api/posts/${rootCode}/like`, { method: 'POST', cookie: alice.cookie }).then((r) => r.status)).toBe(200)

    expect(await api(`/api/posts/${rootCode}/repost`, { method: 'POST', cookie: alice.cookie }).then((r) => r.status)).toBe(200)

    const post = await json<{ _count: { likes: number; reposts: number }; liked: boolean; reposted: boolean }>(
      await api(`/api/posts/${rootCode}`, { cookie: alice.cookie }),
    )
    expect(post._count.likes).toBe(1)
    expect(post._count.reposts).toBe(1)
    expect(post.liked).toBe(true)
    expect(post.reposted).toBe(true)
  })

  it('ownership: another user cannot edit or delete the post', async () => {
    const patch = await api(`/api/posts/${rootCode}`, {
      method: 'PATCH',
      cookie: bob.cookie,
      body: JSON.stringify({ content: 'hijack' }),
    })
    expect(patch.status).toBe(403)

    const del = await api(`/api/posts/${rootCode}`, { method: 'DELETE', cookie: bob.cookie })
    expect(del.status).toBe(403)
  })

  it('edit window: authors cannot edit after 60 minutes', async () => {
    await agePostPastEditWindow(rootCode)
    const res = await api(`/api/posts/${rootCode}`, {
      method: 'PATCH',
      cookie: alice.cookie,
      body: JSON.stringify({ content: 'too late edit' }),
    })
    expect(res.status).toBe(403)
    const body = await json<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('forbidden')
  })

  it('soft delete clears content and hides the post from reads', async () => {
    const res = await api(`/api/posts/${rootCode}`, { method: 'DELETE', cookie: alice.cookie })
    expect(res.status).toBe(200)
    expect(await api(`/api/posts/${rootCode}`).then((r) => r.status)).toBe(404)
  })
})

describe('API key lifecycle & dynamic authorization', () => {
  it('unified key: unverified read-only -> verified read-write -> revoked read-only -> restored write', async () => {
    // 1. Unverified active member creates a unified key via web
    const keyRes = await api('/api/account/api-keys', {
      method: 'POST',
      cookie: bob.cookie,
      body: JSON.stringify({ name: 'bob-bot' }),
    })
    expect(keyRes.status).toBe(201)
    const key = await json<{ rawKey: string; prefix: string }>(keyRes)
    expect(key.rawKey.startsWith('cas_')).toBe(true)

    // The documented key-liveness check: auth-required endpoint, NO cookie
    const live = await api('/api/account/api-keys', { bearer: key.rawKey })
    expect(live.status).toBe(200)

    // Check capabilities endpoint
    const capsRes = await api('/api/account/capabilities', { bearer: key.rawKey })
    expect(capsRes.status).toBe(200)
    const caps = await json<{ permissions: { canProgrammaticWrite: boolean } }>(capsRes)
    expect(caps.permissions.canProgrammaticWrite).toBe(false)

    // Unverified key cannot write
    const denied = await api('/api/posts', {
      method: 'POST',
      bearer: key.rawKey,
      body: JSON.stringify({ content: 'unverified key cannot post' }),
    })
    expect(denied.status).toBe(403)

    const deniedWithCookie = await api('/api/posts', {
      method: 'POST',
      bearer: key.rawKey,
      cookie: bob.cookie,
      body: JSON.stringify({ content: 'cookie cannot elevate programmatic key' }),
    })
    expect(deniedWithCookie.status).toBe(403)

    expect(await api('/api/me/profile', {
      method: 'PATCH',
      bearer: key.rawKey,
      body: JSON.stringify({ bio: 'blocked' }),
    }).then((r) => r.status)).toBe(403)

    // Keys cannot manage keys
    expect(await api('/api/account/api-keys/not-a-key', {
      method: 'DELETE',
      bearer: key.rawKey,
    }).then((r) => r.status)).toBe(403)

    // Password requires browser session
    expect(await api('/api/me/password', {
      method: 'POST',
      bearer: key.rawKey,
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'new-password-123' }),
    }).then((r) => r.status)).toBe(403)

    // 2. Promote bob to verified — THE SAME KEY automatically gains write capabilities
    await promoteUser(bob.username, { verified: true })

    const verifiedCapsRes = await api('/api/account/capabilities', { bearer: key.rawKey })
    const verifiedCaps = await json<{ permissions: { canProgrammaticWrite: boolean } }>(verifiedCapsRes)
    expect(verifiedCaps.permissions.canProgrammaticWrite).toBe(true)

    const postOk = await api('/api/posts', {
      method: 'POST',
      bearer: key.rawKey,
      body: JSON.stringify({ content: 'same key can now post after verification' }),
    })
    expect(postOk.status).toBe(201)

    // 3. Demote/revoke verification — THE SAME KEY immediately drops back to read-only
    await promoteUser(bob.username, { verified: false })
    const deniedAgain = await api('/api/posts', {
      method: 'POST',
      bearer: key.rawKey,
      body: JSON.stringify({ content: 'demoted key cannot post' }),
    })
    expect(deniedAgain.status).toBe(403)
    expect(await api('/api/account/api-keys', { bearer: key.rawKey }).then((r) => r.status)).toBe(200)

    // 4. Restore verification — THE SAME KEY can write again
    await promoteUser(bob.username, { verified: true })
    const postRestored = await api('/api/posts', {
      method: 'POST',
      bearer: key.rawKey,
      body: JSON.stringify({ content: 'restored key can post again' }),
    })
    expect(postRestored.status).toBe(201)
  })
})

describe('admin gates', () => {
  it('non-admin gets 403; promoted admin can list users', async () => {
    const denied = await api('/api/admin/users', { cookie: bob.cookie })
    expect(denied.status).toBe(403)

    await promoteUser(bob.username, { admin: true })
    const ok = await api('/api/admin/users', { cookie: bob.cookie })
    expect(ok.status).toBe(200)
    const body = await json<{ users: unknown[] }>(ok)
    expect(Array.isArray(body.users)).toBe(true)

    // Unverified admin key can read, but mutations return 403
    await promoteUser(bob.username, { verified: false, admin: true })
    const keyRes = await api('/api/account/api-keys', {
      method: 'POST', cookie: bob.cookie,
      body: JSON.stringify({ name: 'admin-key' }),
    })
    expect(keyRes.status).toBe(201)
    const { rawKey } = await json<{ rawKey: string }>(keyRes)
    expect(await api('/api/admin/users', { bearer: rawKey }).then((r) => r.status)).toBe(200)
    expect(await api('/api/admin/users/not-a-user', {
      method: 'PATCH', bearer: rawKey,
      body: JSON.stringify({ status: 'restricted' }),
    }).then((r) => r.status)).toBe(403)

    // Once verified, the same admin key passes the write gate (404 on missing target)
    await promoteUser(bob.username, { verified: true, admin: true })
    expect(await api('/api/admin/users/not-a-user', {
      method: 'PATCH', bearer: rawKey,
      body: JSON.stringify({ status: 'restricted' }),
    }).then((r) => r.status)).toBe(404)
  })
})

describe('search & pagination contracts', () => {
  it('accepts the For You first-page timestamp cursor and rejects malformed cursors', async () => {
    const timestamp = new Date().toISOString()
    const next = await api(`/api/posts?tab=foryou&cursor=${encodeURIComponent(timestamp)}`)
    expect(next.status).toBe(200)
    expect(Array.isArray((await json<{ posts: unknown[] }>(next)).posts)).toBe(true)

    const malformed = await api('/api/posts?tab=foryou&cursor=not-a-date')
    expect(malformed.status).toBe(400)
    expect((await json<{ error: { code: string } }>(malformed)).error.code).toBe('bad_request')
  })

  it('anonymous/unverified search returns an empty result, not an error', async () => {
    const res = await api('/api/search?q=anything')
    expect(res.status).toBe(200)
    const body = await json<{ posts: unknown[]; nextCursor: string | null }>(res)
    expect(body.posts).toEqual([])
  })

  it('paginates verified search using bound parameters without duplicates', async () => {
    const searcher = await registerAndLogin('searcher')
    await promoteUser(searcher.username, { verified: true })

    const term = 'uniquequerytoken'
    await api('/api/posts', { method: 'POST', cookie: searcher.cookie, body: JSON.stringify({ content: `${term} post alpha` }) })
    await api('/api/posts', { method: 'POST', cookie: searcher.cookie, body: JSON.stringify({ content: `${term} post beta` }) })
    await api('/api/posts', { method: 'POST', cookie: searcher.cookie, body: JSON.stringify({ content: `${term} post gamma` }) })

    const page1Res = await api(`/api/search?q=${term}&take=2`, { cookie: searcher.cookie })
    expect(page1Res.status).toBe(200)
    const page1 = await json<{ posts: Array<{ id: string; content: string }>; nextCursor: string | null }>(page1Res)
    expect(page1.posts.length).toBe(2)
    expect(page1.nextCursor).toBeTruthy()

    const page2Res = await api(`/api/search?q=${term}&take=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, { cookie: searcher.cookie })
    expect(page2Res.status).toBe(200)
    const page2 = await json<{ posts: Array<{ id: string; content: string }>; nextCursor: string | null }>(page2Res)
    expect(page2.posts.length).toBe(1)

    const page1Ids = new Set(page1.posts.map((p) => p.id))
    expect(page1Ids.has(page2.posts[0].id)).toBe(false)

    const fractional = await api(`/api/search?q=${term}&take=1.9`, { cookie: searcher.cookie })
    expect(fractional.status).toBe(200)
    expect((await json<{ posts: unknown[] }>(fractional)).posts).toHaveLength(1)

    const invalidDate = `2026-02-30T00:00:00.000Z|${page1.posts[0].id}`
    const invalid = await api(`/api/search?q=${term}&cursor=${encodeURIComponent(invalidDate)}`, { cookie: searcher.cookie })
    expect(invalid.status).toBe(200)
    expect(await json(invalid)).toEqual({ posts: [], nextCursor: null })
  })

  it('take is clamped to 50 and defaults sanely', async () => {
    const res = await api('/api/posts?take=9999')
    expect(res.status).toBe(200)
    const body = await json<{ posts: unknown[] }>(res)
    expect(body.posts.length).toBeLessThanOrEqual(50)

    const junk = await api('/api/posts?take=abc')
    expect(junk.status).toBe(200)

    const fractional = await api('/api/posts?take=1.9')
    expect(fractional.status).toBe(200)
    const page = await json<{ posts: unknown[]; nextCursor: string | null }>(fractional)
    expect(page.posts).toHaveLength(1)
    expect(page.nextCursor).toBeTruthy()
  })

  it('rejects invalid since/cursor combinations instead of erroring mid-query', async () => {
    const invalidSince = await api('/api/posts?since=banana')
    expect(invalidSince.status).toBe(400)
    expect((await json<{ error: { code: string } }>(invalidSince)).error.code).toBe('bad_request')

    // An unparseable since used to fall through to the feed tabs with the
    // cursor still unvalidated → Prisma Invalid Date → 500.
    const both = await api('/api/posts?since=banana&cursor=banana')
    expect(both.status).toBe(400)

    // Cursor validation must not be skipped just because since is present:
    // a valid since with a garbage cursor also reached Prisma as Invalid Date.
    const validSince = '1970-01-01T00:00:00.000Z'
    const garbageCursor = await api(`/api/posts?since=${validSince}&cursor=banana`)
    expect(garbageCursor.status).toBe(400)
    expect((await json<{ error: { code: string } }>(garbageCursor)).error.code).toBe('bad_request')

    // The banner path (canonical since, no cursor) keeps working.
    const banner = await api(`/api/posts?since=${validSince}`)
    expect(banner.status).toBe(200)
    const bannerBody = await json<{ posts: unknown[]; nextCursor: string | null }>(banner)
    expect(Array.isArray(bannerBody.posts)).toBe(true)
    expect(bannerBody.nextCursor).toBeNull()
  })

  it('paginates the latest feed without duplicates or omissions when candidate count is less than window', async () => {
    // There are ~15-20 posts in cascool_test.
    // With take=10, fetchSize = min(10 * 5, 200) = 50.
    // Total candidate count (~15) is strictly less than window (50).
    const res1 = await api('/api/posts?tab=latest&take=10')
    expect(res1.status).toBe(200)
    const body1 = await json<{ posts: Array<{ id: string }>; nextCursor: string | null }>(res1)
    expect(body1.posts.length).toBe(10)
    // BUG in old code: candidates.length (15) < fetchSize (50) causes nextCursor to erroneously be null!
    expect(body1.nextCursor).toBeTruthy()

    const res2 = await api(`/api/posts?tab=latest&take=10&cursor=${encodeURIComponent(body1.nextCursor!)}`)
    expect(res2.status).toBe(200)
    const body2 = await json<{ posts: Array<{ id: string }>; nextCursor: string | null }>(res2)
    expect(body2.posts.length).toBeGreaterThan(0)

    const ids1 = new Set(body1.posts.map(p => p.id))
    for (const p of body2.posts) {
      expect(ids1.has(p.id), 'no post from page 1 may appear on page 2').toBe(false)
    }
  })
})

describe('DELETE rate limiting (Phase-2 fix)', () => {
  it('interaction DELETEs consume the write bucket; exhaustion yields 429 + Retry-After', async () => {
    const hammer = await registerAndLogin('hammer')
    await promoteUser(hammer.username, { verified: true })
    const keyRes = await api('/api/account/api-keys', {
      method: 'POST',
      cookie: hammer.cookie,
      body: JSON.stringify({ name: 'hammer' }),
    })
    const rawKey = (await json<{ rawKey: string }>(keyRes)).rawKey

    const postRes = await api('/api/posts', {
      method: 'POST',
      bearer: rawKey,
      body: JSON.stringify({ content: 'rate limit target 50-00-0' }),
    })
    expect(postRes.status).toBe(201)
    const { shortCode } = await json<{ shortCode: string }>(postRes)

    // Write tier: 60/min per identity. The create used one token; idempotent
    // like-unlikes burn the rest. Before the fix, no DELETE ever 429'd.
    let saw429 = false
    let retryAfter: string | null = null
    for (let i = 0; i < 70; i++) {
      const r = await api(`/api/posts/${shortCode}/like`, { method: 'DELETE', bearer: rawKey })
      if (r.status === 429) {
        saw429 = true
        retryAfter = r.headers.get('Retry-After')
        break
      }
      expect(r.status).toBe(200)
    }
    expect(saw429).toBe(true)
    expect(retryAfter).toBe('1')
  })
})

describe('bookmark ownership and following privacy', () => {
  it('rejects anonymous access to following feed with 401', async () => {
    const res = await api('/api/posts?tab=following')
    expect(res.status).toBe(401)
    const body = await json<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('unauthorized')
  })

  it('rejects anonymous and cross-account access to bookmarks, permits owner', async () => {
    const u1 = await registerAndLogin('bkmk1')
    const u2 = await registerAndLogin('bkmk2')
    const [u1Row] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [u1.username])

    // Anonymous -> 401
    const anon = await api(`/api/posts?bookmarkedBy=${u1Row.id}`)
    expect(anon.status).toBe(401)

    // Cross-account -> 403
    const cross = await api(`/api/posts?bookmarkedBy=${u1Row.id}`, { cookie: u2.cookie })
    expect(cross.status).toBe(403)

    // Owner via session -> 200
    const ownerSession = await api(`/api/posts?bookmarkedBy=${u1Row.id}`, { cookie: u1.cookie })
    expect(ownerSession.status).toBe(200)

    // Owner via read API key -> 200
    await promoteUser(u1.username, { verified: true })
    const keyRes = await api('/api/account/api-keys', {
      method: 'POST',
      cookie: u1.cookie,
      body: JSON.stringify({ name: 'read-bkmk' }),
    })
    const { rawKey } = await json<{ rawKey: string }>(keyRes)
    const ownerKey = await api(`/api/posts?bookmarkedBy=${u1Row.id}`, { bearer: rawKey })
    expect(ownerKey.status).toBe(200)
  })

  it('paginates bookmarks with identical timestamps using compound cursor without drops', async () => {
    const reader = await registerAndLogin('bkmk_pag')
    const [readerRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [reader.username])

    // Create 3 posts
    const p1 = await api('/api/posts', { method: 'POST', cookie: reader.cookie, body: JSON.stringify({ content: 'p1' }) })
    const p2 = await api('/api/posts', { method: 'POST', cookie: reader.cookie, body: JSON.stringify({ content: 'p2' }) })
    const p3 = await api('/api/posts', { method: 'POST', cookie: reader.cookie, body: JSON.stringify({ content: 'p3' }) })
    const [sc1, sc2, sc3] = [
      (await json<{ shortCode: string }>(p1)).shortCode,
      (await json<{ shortCode: string }>(p2)).shortCode,
      (await json<{ shortCode: string }>(p3)).shortCode,
    ]

    await api(`/api/posts/${sc1}/bookmark`, { method: 'POST', cookie: reader.cookie })
    await api(`/api/posts/${sc2}/bookmark`, { method: 'POST', cookie: reader.cookie })
    await api(`/api/posts/${sc3}/bookmark`, { method: 'POST', cookie: reader.cookie })

    // Force identical createdAt timestamps on all 3 bookmarks
    const fixedTime = new Date('2026-10-28T10:00:00.000Z')
    await sql('UPDATE "Bookmark" SET "createdAt" = $1 WHERE "userId" = $2', [fixedTime, readerRow.id])

    // Fetch page 1 with take=2
    const page1Res = await api(`/api/posts?bookmarkedBy=${readerRow.id}&take=2`, { cookie: reader.cookie })
    expect(page1Res.status).toBe(200)
    const page1 = await json<{ posts: { shortCode: string }[]; nextCursor: string | null }>(page1Res)
    expect(page1.posts.length).toBe(2)
    expect(page1.nextCursor).toBeTruthy()
    expect(page1.nextCursor).toContain('|')

    // Fetch page 2 with cursor
    const page2Res = await api(`/api/posts?bookmarkedBy=${readerRow.id}&take=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, { cookie: reader.cookie })
    expect(page2Res.status).toBe(200)
    const page2 = await json<{ posts: { shortCode: string }[]; nextCursor: string | null }>(page2Res)
    expect(page2.posts.length).toBe(1)
    expect(page2.nextCursor).toBeNull()

    const allSeen = [...page1.posts.map(p => p.shortCode), ...page2.posts.map(p => p.shortCode)]
    expect(new Set(allSeen).size).toBe(3)
  })
})

describe('repost lifecycle invariants & dual record', () => {
  it('creates linked Repost and Post, blocks editing pure repost, and preserves reply chain on cancel', async () => {
    const author = await registerAndLogin('rep_author')
    const reposter = await registerAndLogin('rep_user')
    const replier = await registerAndLogin('rep_replier')

    const origRes = await api('/api/posts', {
      method: 'POST', cookie: author.cookie,
      body: JSON.stringify({ content: 'original post to repost' }),
    })
    const { shortCode: origCode } = await json<{ shortCode: string }>(origRes)
    const [origPost] = await sql<{ id: string; repostCount: number }>('SELECT id, "repostCount" FROM "Post" WHERE "shortCode" = $1', [origCode])
    expect(origPost.repostCount).toBe(0)

    // Repost
    const repRes = await api(`/api/posts/${origCode}/repost`, { method: 'POST', cookie: reposter.cookie })
    expect(repRes.status).toBe(200)

    // Verify DB linkage
    const [repostRow] = await sql<{ id: string; repostPostId: string | null }>(
      'SELECT id, "repostPostId" FROM "Repost" WHERE "postId" = $1',
      [origPost.id],
    )
    expect(repostRow.repostPostId).toBeTruthy()

    const [repostPost] = await sql<{ id: string; shortCode: string; content: string; quotePostId: string }>(
      'SELECT id, "shortCode", content, "quotePostId" FROM "Post" WHERE id = $1',
      [repostRow.repostPostId!],
    )
    expect(repostPost.content).toBe('')
    expect(repostPost.quotePostId).toBe(origPost.id)

    // Verify counter increment
    const [afterRepOrig] = await sql<{ repostCount: number }>('SELECT "repostCount" FROM "Post" WHERE id = $1', [origPost.id])
    expect(afterRepOrig.repostCount).toBe(1)

    // Attempt to edit pure repost -> 400 forbidden
    const editRes = await api(`/api/posts/${repostPost.shortCode}`, {
      method: 'PATCH',
      cookie: reposter.cookie,
      body: JSON.stringify({ content: 'trying to turn into quote' }),
    })
    expect(editRes.status).toBe(400)
    const editErr = await json<{ error: { message: string } }>(editRes)
    expect(editErr.error.message).toContain('Pure reposts cannot be edited')

    // Someone replies to the repost post!
    const replyRes = await api('/api/posts', {
      method: 'POST',
      cookie: replier.cookie,
      body: JSON.stringify({ content: 'replying to repost', parentId: repostPost.id }),
    })
    expect(replyRes.status).toBe(201)
    const { shortCode: replyCode } = await json<{ shortCode: string }>(replyRes)

    // Now reposter undoes the repost!
    const undoRes = await api(`/api/posts/${origCode}/repost`, { method: 'DELETE', cookie: reposter.cookie })
    expect(undoRes.status).toBe(200)

    // Repost row must be gone
    const [repostAfterUndo] = await sql('SELECT id FROM "Repost" WHERE "postId" = $1', [origPost.id])
    expect(repostAfterUndo).toBeUndefined()

    // Original post repostCount must be decremented
    const [afterUndoOrig] = await sql<{ repostCount: number }>('SELECT "repostCount" FROM "Post" WHERE id = $1', [origPost.id])
    expect(afterUndoOrig.repostCount).toBe(0)

    // Crucial check: repostPost was NOT hard-deleted because it had replies!
    const [tombstone] = await sql<{ id: string; deletedAt: string | null }>(
      'SELECT id, "deletedAt" FROM "Post" WHERE id = $1',
      [repostPost.id],
    )
    expect(tombstone).toBeDefined()
    expect(tombstone.deletedAt).not.toBeNull()

    // And the reply must STILL exist and be active!
    const [replyPost] = await sql<{ id: string; deletedAt: string | null }>(
      'SELECT id, "deletedAt" FROM "Post" WHERE "shortCode" = $1',
      [replyCode],
    )
    expect(replyPost).toBeDefined()
    expect(replyPost.deletedAt).toBeNull()
  })

  it('canceling a repost when it is quoted (0 replies) does NOT cascade-delete the quoting post', async () => {
    const author = await registerAndLogin('q_author')
    const reposter = await registerAndLogin('q_reposter')
    const quoter = await registerAndLogin('q_quoter')

    // 1. Author creates original post
    const origRes = await api('/api/posts', {
      method: 'POST', cookie: author.cookie,
      body: JSON.stringify({ content: 'original target for quote test' }),
    })
    const { shortCode: origCode } = await json<{ shortCode: string }>(origRes)
    const [origPost] = await sql<{ id: string }>('SELECT id FROM "Post" WHERE "shortCode" = $1', [origCode])

    // 2. Reposter reposts original post
    const repostRes = await api(`/api/posts/${origCode}/repost`, { method: 'POST', cookie: reposter.cookie })
    expect(repostRes.status).toBe(200)

    const [repostRow] = await sql<{ id: string; repostPostId: string }>(
      'SELECT id, "repostPostId" FROM "Repost" WHERE "postId" = $1',
      [origPost.id],
    )
    expect(repostRow.repostPostId).toBeTruthy()

    const [repostPost] = await sql<{ id: string; shortCode: string; replyCount: number }>(
      'SELECT id, "shortCode", "replyCount" FROM "Post" WHERE id = $1',
      [repostRow.repostPostId],
    )
    expect(repostPost.replyCount).toBe(0) // 0 direct replies!

    // 3. Quoter quotes the repost post (creates quote post referencing repostPost.id)
    const quoteRes = await api('/api/posts', {
      method: 'POST',
      cookie: quoter.cookie,
      body: JSON.stringify({
        content: 'Quoting the reposted post without replying to it',
        quotePostId: repostPost.id,
      }),
    })
    expect(quoteRes.status).toBe(201)
    const { shortCode: quoteCode } = await json<{ shortCode: string }>(quoteRes)

    // 4. Reposter cancels their repost
    // In prior versions, because replyCount was 0, it attempted a physical hard-delete
    // which PostgreSQL ON DELETE CASCADE propagated to delete the quoter's post!
    const undoRes = await api(`/api/posts/${origCode}/repost`, { method: 'DELETE', cookie: reposter.cookie })
    expect(undoRes.status).toBe(200)

    // 5. Verify counters and relationship tree
    const [origCheck] = await sql<{ repostCount: number }>('SELECT "repostCount" FROM "Post" WHERE id = $1', [origPost.id])
    expect(origCheck.repostCount).toBe(0)

    const [reposterUser] = await sql<{ postCount: number }>('SELECT "postCount" FROM "User" WHERE username = $1', [reposter.username])
    expect(reposterUser.postCount).toBe(0)

    const [repostRowCheck] = await sql('SELECT id FROM "Repost" WHERE id = $1', [repostRow.id])
    expect(repostRowCheck).toBeUndefined()

    // The repostPost must be preserved as an HTTP 200 tombstone (soft-deleted)
    const [tombstone] = await sql<{ id: string; deletedAt: string | null; content: string }>(
      'SELECT id, "deletedAt", content FROM "Post" WHERE id = $1',
      [repostPost.id],
    )
    expect(tombstone).toBeDefined()
    expect(tombstone.deletedAt).not.toBeNull()
    expect(tombstone.content).toBe('')

    // Crucial check: Quoter's post was NOT cascade deleted!
    const [quotePostCheck] = await sql<{ id: string; deletedAt: string | null; quotePostId: string | null }>(
      'SELECT id, "deletedAt", "quotePostId" FROM "Post" WHERE "shortCode" = $1',
      [quoteCode],
    )
    expect(quotePostCheck).toBeDefined()
    expect(quotePostCheck.deletedAt).toBeNull()
    expect(quotePostCheck.quotePostId).toBe(repostPost.id)

    // And reading the quote post via API returns 200 with the quoted post tombstone
    const getQuoteRes = await api(`/api/posts/${quoteCode}`)
    expect(getQuoteRes.status).toBe(200)
    const getQuoteBody = await json<{ quotedPost: { deletedAt: string | null; content: string } | null }>(getQuoteRes)
    expect(getQuoteBody.quotedPost).toBeDefined()
    expect(getQuoteBody.quotedPost?.deletedAt).toBeTruthy()
    expect(getQuoteBody.quotedPost?.content).toBe('')

    // Repeated cancel is completely idempotent
    const repeatUndo = await api(`/api/posts/${origCode}/repost`, { method: 'DELETE', cookie: reposter.cookie })
    expect(repeatUndo.status).toBe(200)
    const [origCheck2] = await sql<{ repostCount: number }>('SELECT "repostCount" FROM "Post" WHERE id = $1', [origPost.id])
    expect(origCheck2.repostCount).toBe(0)
  })

  it('deleting a pure repost post directly synchronizes the Repost row and original post counter', async () => {
    const author = await registerAndLogin('del_author')
    const reposter = await registerAndLogin('del_reposter')

    const origRes = await api('/api/posts', {
      method: 'POST', cookie: author.cookie,
      body: JSON.stringify({ content: 'another original post' }),
    })
    const { shortCode: origCode } = await json<{ shortCode: string }>(origRes)
    const [origPost] = await sql<{ id: string }>('SELECT id FROM "Post" WHERE "shortCode" = $1', [origCode])

    await api(`/api/posts/${origCode}/repost`, { method: 'POST', cookie: reposter.cookie })
    const [repostRow] = await sql<{ repostPostId: string }>('SELECT "repostPostId" FROM "Repost" WHERE "postId" = $1', [origPost.id])
    const [repostPost] = await sql<{ shortCode: string }>('SELECT "shortCode" FROM "Post" WHERE id = $1', [repostRow.repostPostId])

    // Reposter deletes their repost post directly
    const delRes = await api(`/api/posts/${repostPost.shortCode}`, { method: 'DELETE', cookie: reposter.cookie })
    expect(delRes.status).toBe(200)

    // Repost row must be deleted
    const [repostCheck] = await sql('SELECT id FROM "Repost" WHERE "postId" = $1', [origPost.id])
    expect(repostCheck).toBeUndefined()

    // Original post repostCount must be 0
    const [origCheck] = await sql<{ repostCount: number }>('SELECT "repostCount" FROM "Post" WHERE id = $1', [origPost.id])
    expect(origCheck.repostCount).toBe(0)
  })
})

describe('post view atomic deduplication', () => {
  it('deduplicates views per user and handles repeat and concurrent views', async () => {
    const author = await registerAndLogin('view_author')
    const viewer = await registerAndLogin('viewer')
    const postRes = await api('/api/posts', {
      method: 'POST', cookie: author.cookie,
      body: JSON.stringify({ content: 'view target post' }),
    })
    const { shortCode } = await json<{ shortCode: string }>(postRes)
    const [post] = await sql<{ id: string; views: number }>('SELECT id, views FROM "Post" WHERE "shortCode" = $1', [shortCode])
    expect(post.views).toBe(0)

    // Author view -> does not increment views
    const authorView = await api(`/api/posts/${shortCode}/view`, { method: 'POST', cookie: author.cookie })
    expect(authorView.status).toBe(200)
    const [afterAuthor] = await sql<{ views: number }>('SELECT views FROM "Post" WHERE id = $1', [post.id])
    expect(afterAuthor.views).toBe(0)

    // First reader view
    const v1 = await api(`/api/posts/${shortCode}/view`, { method: 'POST', cookie: viewer.cookie })
    expect(v1.status).toBe(200)

    const [afterV1] = await sql<{ views: number }>('SELECT views FROM "Post" WHERE id = $1', [post.id])
    expect(afterV1.views).toBe(1)

    // Second view (duplicate) -> views stays 1
    const v2 = await api(`/api/posts/${shortCode}/view`, { method: 'POST', cookie: viewer.cookie })
    expect(v2.status).toBe(200)

    const [afterV2] = await sql<{ views: number }>('SELECT views FROM "Post" WHERE id = $1', [post.id])
    expect(afterV2.views).toBe(1)

    // Concurrent views
    await Promise.all([
      api(`/api/posts/${shortCode}/view`, { method: 'POST', cookie: viewer.cookie }),
      api(`/api/posts/${shortCode}/view`, { method: 'POST', cookie: viewer.cookie }),
    ])
    const [afterConcurrent] = await sql<{ views: number }>('SELECT views FROM "Post" WHERE id = $1', [post.id])
    expect(afterConcurrent.views).toBe(1)
  })

  it('rolls back deduplication row when view count increment fails, enabling clean retry', async () => {
    const author = await registerAndLogin('inj_author')
    const viewer = await registerAndLogin('inj_viewer')
    const postRes = await api('/api/posts', {
      method: 'POST', cookie: author.cookie,
      body: JSON.stringify({ content: 'fault injection post' }),
    })
    const { shortCode } = await json<{ shortCode: string }>(postRes)
    const [post] = await sql<{ id: string; views: number }>('SELECT id, views FROM "Post" WHERE "shortCode" = $1', [shortCode])
    const [viewerRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [viewer.username])
    expect(post.views).toBe(0)

    // Install a database trigger that deliberately fails whenever views increases on this post
    await sql(`
      CREATE OR REPLACE FUNCTION fail_view_increment() RETURNS trigger AS $$
      BEGIN
        IF NEW.views > OLD.views THEN
          RAISE EXCEPTION 'Simulated database failure during post view increment';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_fail_view_increment ON "Post";
      CREATE TRIGGER trg_fail_view_increment
      BEFORE UPDATE ON "Post"
      FOR EACH ROW
      EXECUTE FUNCTION fail_view_increment();
    `)

    try {
      // View attempt must fail (500) due to transactional failure on increment
      const failedRes = await api(`/api/posts/${shortCode}/view`, { method: 'POST', cookie: viewer.cookie })
      expect(failedRes.status).toBe(500)

      // PostView deduplication row MUST be rolled back (0 rows)
      const [viewRowCheck] = await sql<{ count: string }>(
        'SELECT count(*)::text as count FROM "PostView" WHERE "postId" = $1 AND "userId" = $2',
        [post.id, viewerRow.id],
      )
      expect(viewRowCheck.count).toBe('0')

      // Views counter must still be 0
      const [postCheck] = await sql<{ views: number }>('SELECT views FROM "Post" WHERE id = $1', [post.id])
      expect(postCheck.views).toBe(0)
    } finally {
      // Remove fault injection trigger
      await sql('DROP TRIGGER IF EXISTS trg_fail_view_increment ON "Post"')
    }

    // Now retry the view — must succeed (200), increment views to 1, and commit the PostView row!
    const retryRes = await api(`/api/posts/${shortCode}/view`, { method: 'POST', cookie: viewer.cookie })
    expect(retryRes.status).toBe(200)

    const [postAfterRetry] = await sql<{ views: number }>('SELECT views FROM "Post" WHERE id = $1', [post.id])
    expect(postAfterRetry.views).toBe(1)

    const [viewRowAfterRetry] = await sql<{ count: string }>(
      'SELECT count(*)::text as count FROM "PostView" WHERE "postId" = $1 AND "userId" = $2',
      [post.id, viewerRow.id],
    )
    expect(viewRowAfterRetry.count).toBe('1')

    // Second view is recognized as duplicate and doesn't increment
    const dupRes = await api(`/api/posts/${shortCode}/view`, { method: 'POST', cookie: viewer.cookie })
    expect(dupRes.status).toBe(200)
    const [postAfterDup] = await sql<{ views: number }>('SELECT views FROM "Post" WHERE id = $1', [post.id])
    expect(postAfterDup.views).toBe(1)
  })
})

describe('admin report resolve preemption & idempotency', () => {
  it('preemptively claims pending report, rejects concurrent resolve, and stays idempotent on replay', async () => {
    const admin = await registerAndLogin('rpt_adm')
    await promoteUser(admin.username, { admin: true })
    const target = await registerAndLogin('rpt_target')
    const reporter = await registerAndLogin('rpt_reporter')

    const pRes = await api('/api/posts', {
      method: 'POST', cookie: target.cookie,
      body: JSON.stringify({ content: 'violating post' }),
    })
    const { shortCode } = await json<{ shortCode: string }>(pRes)
    const [pRow] = await sql<{ id: string }>('SELECT id FROM "Post" WHERE "shortCode" = $1', [shortCode])
    const [targetRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [target.username])
    const [reporterRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [reporter.username])

    const [rpt] = await sql<{ id: string }>(
      `INSERT INTO "Report" (id, "targetType", "reportedUserId", "postId", "reporterId", reason, status, "createdAt")
       VALUES ('rpt_test_' || md5(random()::text), 'POST', $1, $2, $3, 'SPAM', 'PENDING', now())
       RETURNING id`,
      [targetRow.id, pRow.id, reporterRow.id],
    )

    // Concurrent resolves for the same report
    const [res1, res2] = await Promise.all([
      api(`/api/admin/reports/${rpt.id}/resolve`, {
        method: 'POST', cookie: admin.cookie,
        body: JSON.stringify({ action: 'delete' }),
      }),
      api(`/api/admin/reports/${rpt.id}/resolve`, {
        method: 'POST', cookie: admin.cookie,
        body: JSON.stringify({ action: 'delete' }),
      }),
    ])

    const statuses = [res1.status, res2.status].sort()
    expect(statuses).toEqual([200, 400])

    // Replay returns 400
    const replay = await api(`/api/admin/reports/${rpt.id}/resolve`, {
      method: 'POST', cookie: admin.cookie,
      body: JSON.stringify({ action: 'delete' }),
    })
    expect(replay.status).toBe(400)
    const replayErr = await json<{ error: { message: string } }>(replay)
    expect(replayErr.error.message).toContain('Report already handled')
  })

  it('committed resolution succeeds with 200 and applies penalties atomically', async () => {
    const admin = await registerAndLogin('rpt_adm2')
    await promoteUser(admin.username, { admin: true })
    const target = await registerAndLogin('rpt_target2')
    const reporter = await registerAndLogin('rpt_reporter2')

    const pRes = await api('/api/posts', {
      method: 'POST', cookie: target.cookie,
      body: JSON.stringify({ content: 'post to delete in report' }),
    })
    const { shortCode } = await json<{ shortCode: string }>(pRes)
    const [pRow] = await sql<{ id: string }>('SELECT id FROM "Post" WHERE "shortCode" = $1', [shortCode])
    const [targetRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [target.username])
    const [reporterRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [reporter.username])

    const [rpt] = await sql<{ id: string }>(
      `INSERT INTO "Report" (id, "targetType", "reportedUserId", "postId", "reporterId", reason, status, "createdAt")
       VALUES ('rpt_test2_' || md5(random()::text), 'POST', $1, $2, $3, 'SPAM', 'PENDING', now())
       RETURNING id`,
      [targetRow.id, pRow.id, reporterRow.id],
    )

    // Resolve report with action delete
    const resolveRes = await api(`/api/admin/reports/${rpt.id}/resolve`, {
      method: 'POST', cookie: admin.cookie,
      body: JSON.stringify({ action: 'delete' }),
    })
    expect(resolveRes.status).toBe(200)
    const body = await json<{ ok: boolean; action: string }>(resolveRes)
    expect(body.ok).toBe(true)

    // Report status in database is RESOLVED
    const [rptAfter] = await sql<{ status: string }>('SELECT status FROM "Report" WHERE id = $1', [rpt.id])
    expect(rptAfter.status).toBe('RESOLVED')

    // Post is soft-deleted
    const [postAfter] = await sql<{ deletedAt: string | null }>('SELECT "deletedAt" FROM "Post" WHERE id = $1', [pRow.id])
    expect(postAfter.deletedAt).not.toBeNull()
  })
})

describe('latest feed deduplication order & consumption boundary', () => {
  it('preserves exact chronological order and consumption boundary for A1, A2, B1', async () => {
    const userA = await registerAndLogin('user_a')
    const userB = await registerAndLogin('user_b')

    // Seed candidate posts with future timestamps so they are the top 3 in the latest feed:
    // A1 at T3 (newest)
    // A2 at T2
    // B1 at T1 (oldest)
    const t3 = new Date('2030-01-01T12:00:00.000Z')
    const t2 = new Date('2030-01-01T11:00:00.000Z')
    const t1 = new Date('2030-01-01T10:00:00.000Z')

    const pA1 = await api('/api/posts', { method: 'POST', cookie: userA.cookie, body: JSON.stringify({ content: 'A1' }) })
    const pA2 = await api('/api/posts', { method: 'POST', cookie: userA.cookie, body: JSON.stringify({ content: 'A2' }) })
    const pB1 = await api('/api/posts', { method: 'POST', cookie: userB.cookie, body: JSON.stringify({ content: 'B1' }) })

    const scA1 = (await json<{ shortCode: string }>(pA1)).shortCode
    const scA2 = (await json<{ shortCode: string }>(pA2)).shortCode
    const scB1 = (await json<{ shortCode: string }>(pB1)).shortCode

    await sql('UPDATE "Post" SET "createdAt" = $1 WHERE "shortCode" = $2', [t3, scA1])
    await sql('UPDATE "Post" SET "createdAt" = $1 WHERE "shortCode" = $2', [t2, scA2])
    await sql('UPDATE "Post" SET "createdAt" = $1 WHERE "shortCode" = $2', [t1, scB1])

    // Scenario 1: take=2
    // Candidates are A1 (T3), A2 (T2), B1 (T1).
    // Unique authors pass takes A1, skips A2 (anti-spam suppressed), takes B1.
    // Selected is [A1, B1]. Consumption boundary is B1!
    const resTake2 = await api('/api/posts?take=2')
    expect(resTake2.status).toBe(200)
    const pageTake2 = await json<{ posts: { shortCode: string }[]; nextCursor: string | null }>(resTake2)
    const codesTake2 = pageTake2.posts.map(p => p.shortCode)
    expect(codesTake2).toContain(scA1)
    expect(codesTake2).toContain(scB1)
    expect(codesTake2).not.toContain(scA2)

    // Cursor MUST point to the consumption boundary B1 (or older if more posts exist)
    // When requesting page 2 with cursor, B1 MUST NOT be repeated!
    if (pageTake2.nextCursor) {
      const resPage2 = await api(`/api/posts?take=2&cursor=${encodeURIComponent(pageTake2.nextCursor)}`)
      const page2 = await json<{ posts: { shortCode: string }[] }>(resPage2)
      expect(page2.posts.some(p => p.shortCode === scB1)).toBe(false)
    }

    // Scenario 2: take=3 with backfill when unique authors in candidates < take
    // A follower following only userA and userB has candidate window consisting of only A1, A2, B1.
    const follower = await registerAndLogin('follower_ab')
    await api(`/api/users/${userA.username}/follow`, { method: 'POST', cookie: follower.cookie })
    await api(`/api/users/${userB.username}/follow`, { method: 'POST', cookie: follower.cookie })

    // Backfill MUST preserve candidates total order: [A1, A2, B1] in chronological order!
    const resTake3 = await api('/api/posts?tab=following&take=3', { cookie: follower.cookie })
    expect(resTake3.status).toBe(200)
    const pageTake3 = await json<{ posts: { shortCode: string }[] }>(resTake3)
    const indices = [
      pageTake3.posts.findIndex(p => p.shortCode === scA1),
      pageTake3.posts.findIndex(p => p.shortCode === scA2),
      pageTake3.posts.findIndex(p => p.shortCode === scB1),
    ]
    expect(indices[0]).toBe(0)
    expect(indices[1]).toBe(1)
    expect(indices[2]).toBe(2)
  })
})

describe('cas sitemap scope', () => {
  it('includes registered chemicals up to the cap without arbitrary exclusion', async () => {
    // Insert active chemical and banned chemical with postCount > 0
    await sql(`
      INSERT INTO "Chemical" (id, "casNumber", "banned", "postCount", "createdAt", "updatedAt")
      VALUES
        ('chem_active', '100-00-5', false, 5, now(), now()),
        ('chem_banned', '200-00-5', true, 5, now(), now())
      ON CONFLICT ("casNumber") DO UPDATE SET "banned" = EXCLUDED."banned", "postCount" = EXCLUDED."postCount"
    `)

    const res = await api('/cas/sitemap.xml')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('100-00-5')
    expect(xml).toContain('200-00-5')
  })
})

describe('repost cancel concurrency & unified lock order', () => {
  async function freshRepost(userTag: string): Promise<{
    origCode: string
    origId: string
    reposter: Session
    generatedCode: string
    generatedId: string
  }> {
    const author = await registerAndLogin(`lock_author_${userTag}`)
    const reposter = await registerAndLogin(`lock_reposter_${userTag}`)
    const origRes = await api('/api/posts', {
      method: 'POST', cookie: author.cookie,
      body: JSON.stringify({ content: `lock-order target ${userTag}` }),
    })
    const { shortCode: origCode } = await json<{ shortCode: string }>(origRes)
    const [origRow] = await sql<{ id: string }>('SELECT id FROM "Post" WHERE "shortCode" = $1', [origCode])
    const repRes = await api(`/api/posts/${origCode}/repost`, { method: 'POST', cookie: reposter.cookie })
    expect(repRes.status).toBe(200)
    const [repRow] = await sql<{ repostPostId: string }>(
      'SELECT "repostPostId" FROM "Repost" WHERE "postId" = $1', [origRow.id],
    )
    const [gen] = await sql<{ id: string; shortCode: string }>(
      'SELECT id, "shortCode" FROM "Post" WHERE id = $1', [repRow.repostPostId],
    )
    return { origCode, origId: origRow.id, reposter, generatedCode: gen.shortCode, generatedId: gen.id }
  }

  it('concurrent double cancel: both requests succeed, counters decrement exactly once', async () => {
    for (let round = 0; round < 5; round++) {
      const { origCode, origId, reposter, generatedId } = await freshRepost(`cc${round}`)

      const [a, b] = await Promise.all([
        api(`/api/posts/${origCode}/repost`, { method: 'DELETE', cookie: reposter.cookie }),
        api(`/api/posts/${origCode}/repost`, { method: 'DELETE', cookie: reposter.cookie }),
      ])
      // Neither request may 500 (previously: P2025 on the loser's repost.delete)
      expect([a.status, b.status]).toEqual([200, 200])

      const [repostRow] = await sql('SELECT id FROM "Repost" WHERE "postId" = $1', [origId])
      expect(repostRow).toBeUndefined()
      const [orig] = await sql<{ repostCount: number }>('SELECT "repostCount" FROM "Post" WHERE id = $1', [origId])
      expect(orig.repostCount).toBe(0)
      const [repUser] = await sql<{ postCount: number }>(
        'SELECT "postCount" FROM "User" WHERE username = $1', [reposter.username],
      )
      expect(repUser.postCount).toBe(0)
      const [generated] = await sql<{ deletedAt: string | null; content: string }>(
        'SELECT "deletedAt", content FROM "Post" WHERE id = $1', [generatedId],
      )
      expect(generated.deletedAt).not.toBeNull()
      expect(generated.content).toBe('')
    }
  })

  it('concurrent cancel vs direct delete of the generated post: no deadlock, no 500, counters exact', async () => {
    for (let round = 0; round < 5; round++) {
      const { origCode, origId, reposter, generatedCode, generatedId } = await freshRepost(`cd${round}`)

      const [cancel, direct] = await Promise.all([
        api(`/api/posts/${origCode}/repost`, { method: 'DELETE', cookie: reposter.cookie }),
        api(`/api/posts/${generatedCode}`, { method: 'DELETE', cookie: reposter.cookie }),
      ])
      // The loser of the race exits cleanly: cancel no-ops (row claimed by the
      // delete path) or the delete sees a tombstone (404). No P2025 / deadlock 500.
      for (const res of [cancel, direct]) {
        expect([200, 404]).toContain(res.status)
      }

      const [repostRow] = await sql('SELECT id FROM "Repost" WHERE "postId" = $1', [origId])
      expect(repostRow).toBeUndefined()
      const [orig] = await sql<{ repostCount: number }>('SELECT "repostCount" FROM "Post" WHERE id = $1', [origId])
      expect(orig.repostCount).toBe(0)
      const [repUser] = await sql<{ postCount: number }>(
        'SELECT "postCount" FROM "User" WHERE username = $1', [reposter.username],
      )
      expect(repUser.postCount).toBe(0)
      const [generated] = await sql<{ deletedAt: string | null }>(
        'SELECT "deletedAt" FROM "Post" WHERE id = $1', [generatedId],
      )
      expect(generated.deletedAt).not.toBeNull()
    }
  })

  it('re-cancel after a fresh re-repost only cancels the new repost (claim guards by row id)', async () => {
    const { origCode, origId, reposter } = await freshRepost('rr')
    // Cancel, then re-repost — a NEW Repost row with a new id is created.
    expect((await api(`/api/posts/${origCode}/repost`, { method: 'DELETE', cookie: reposter.cookie })).status).toBe(200)
    const repostAgain = await api(`/api/posts/${origCode}/repost`, { method: 'POST', cookie: reposter.cookie })
    expect(repostAgain.status).toBe(200)

    const [row] = await sql<{ repostPostId: string; post: { deletedAt: string | null } }>(`
      SELECT r."repostPostId", p."deletedAt" AS post FROM "Repost" r
      JOIN "Post" p ON p.id = r."repostPostId" WHERE r."postId" = $1`, [origId])
    expect(row.post).toBeNull() // new generated post is live

    expect((await api(`/api/posts/${origCode}/repost`, { method: 'DELETE', cookie: reposter.cookie })).status).toBe(200)
    const [after] = await sql<{ repostCount: number }>('SELECT "repostCount" FROM "Post" WHERE id = $1', [origId])
    expect(after.repostCount).toBe(0)
  })
})

describe('post sitemap shard lifecycle across the 50,000 boundary', () => {
  const BULK_PREFIX = 'rc50k'
  afterEach(async () => {
    // Clean the bulk fixture even when an assertion fails, so later suites
    // never inherit 50,001 extra posts from an interrupted boundary test.
    await sql('DELETE FROM "Post" WHERE "authorId" = $1', ['rc50k_author'])
    await sql('DELETE FROM "User" WHERE id = $1', ['rc50k_author'])
    // Prove the teardown actually finished instead of silently stalling
    // (statement timeout, dropped connection): bounded wait until the bulk
    // rows are verifiably gone — never an unbounded hang.
    const deadline = Date.now() + 10_000
    let remaining = -1
    while (Date.now() < deadline) {
      const [row] = await sql<{ count: number }>(
        `SELECT count(*)::int AS count FROM "Post" WHERE id LIKE 'rc50k\\_%'`,
      )
      remaining = row.count
      if (remaining === 0) break
      await sql(`DELETE FROM "Post" WHERE id LIKE 'rc50k\\_%'`)
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(remaining).toBe(0)
  })
  function countUrls(xml: string): number {
    return (xml.match(/<url>/g) ?? []).length
  }
  function locs(xml: string): Set<string> {
    return new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]))
  }

  it('out-of-range and overflowing shard indices answer 200 with an empty urlset, never 404 or 500', async () => {
    const beyond = await api('/p/sitemap/9.xml')
    expect(beyond.status).toBe(200)
    expect(countUrls(await beyond.text())).toBe(0)
    // MAX_SAFE_INTEGER × 50,000 overflows the OFFSET — must not reach the DB.
    const overflow = await api('/p/sitemap/9007199254740991.xml')
    expect(overflow.status).toBe(200)
    expect(countUrls(await overflow.text())).toBe(0)
    // Large but representable offsets are cut off by the count-range check
    // before any OFFSET query runs.
    const huge = await api('/p/sitemap/500000.xml')
    expect(huge.status).toBe(200)
    expect(countUrls(await huge.text())).toBe(0)
    const malformed = await api('/p/sitemap/not-a-number.xml')
    expect(malformed.status).toBe(404)
  })

  it('crossing upward and downward never breaks robots or shard URLs', async () => {
    // Explicit per-test budget (not a global timeout raise): the 50,001-row
    // fixture plus two full 50k-URL shard renders exceed the 30s default
    // when the whole suite shares one machine (observed in the 1.2.0 audit
    // rerun). Every request is bounded so a hang fails fast with a cause.
    const FETCH_TIMEOUT = { signal: AbortSignal.timeout(25_000) }
    const [author] = await sql<{ id: string; username: string }>(
      `INSERT INTO "User" (id, email, username, "passwordHash", "postCount", "createdAt", "updatedAt")
       VALUES ('rc50k_author', 'rc50k@example.test', 'rc50k_author', 'x', 0, now(), now())
       ON CONFLICT (email) DO UPDATE SET username = EXCLUDED.username RETURNING id, username`,
    )

    // --- Below the boundary: single shard ---
    const before = await api('/p/sitemap/0.xml', FETCH_TIMEOUT)
    expect(before.status).toBe(200)
    const robotsBefore = await (await api('/robots.txt', FETCH_TIMEOUT)).text()
    expect(robotsBefore).toContain('/p/sitemap/0.xml')
    expect(robotsBefore).not.toContain('/p/sitemap/1.xml')

    // --- Cross upward: 50,001 bulk posts push the total past 50,000 ---
    await sql(`
      INSERT INTO "Post" (id, "shortCode", "authorId", content, images, "createdAt", "updatedAt")
      SELECT 'rc50k_' || g,
             '${BULK_PREFIX}' || lpad(g::text, 6, '0'),
             $1, 'x', '{}'::text[],
             now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval
      FROM generate_series(1, 50001) AS g
    `, [author.id])
    const [{ total }] = await sql<{ total: string }>(
      'SELECT count(*)::text AS total FROM "Post" WHERE "deletedAt" IS NULL',
    )
    expect(Number(total)).toBeGreaterThan(50_000)

    const robotsAfter = await (await api('/robots.txt', FETCH_TIMEOUT)).text()
    expect(robotsAfter).toContain('/p/sitemap/0.xml')
    expect(robotsAfter).toContain('/p/sitemap/1.xml')
    expect(robotsAfter).not.toContain('/p/sitemap/2.xml')

    const shard0 = await api('/p/sitemap/0.xml', FETCH_TIMEOUT)
    const shard1 = await api('/p/sitemap/1.xml', FETCH_TIMEOUT)
    expect(shard0.status).toBe(200)
    expect(shard1.status).toBe(200)
    const xml0 = await shard0.text()
    const xml1 = await shard1.text()
    expect(countUrls(xml0)).toBe(50_000)
    expect(countUrls(xml1)).toBe(Number(total) - 50_000)

    // Quiescent exactness: the union of the two shards is the full live set,
    // with no overlap. (Asserted only at rest — no such claim is made for
    // shards regenerated while writes are in flight.)
    const locations0 = locs(xml0)
    const locations1 = locs(xml1)
    const union = new Set([...locations0, ...locations1])
    expect(union.size).toBe(Number(total))
    expect([...locations0].filter((loc) => locations1.has(loc))).toEqual([])

    // --- Cross downward: tombstone the bulk posts, shard 1 empties (not 404) ---
    await sql(`UPDATE "Post" SET "deletedAt" = now() WHERE id LIKE 'rc50k\\_%'`)
    const robotsShrunk = await (await api('/robots.txt', FETCH_TIMEOUT)).text()
    expect(robotsShrunk).not.toContain('/p/sitemap/1.xml')
    const shard1Empty = await api('/p/sitemap/1.xml', FETCH_TIMEOUT)
    expect(shard1Empty.status).toBe(200)
    expect(countUrls(await shard1Empty.text())).toBe(0)
  }, 120_000)
})

describe('report resolve side-effect outbox (fault injection)', () => {
  async function seedPendingReport(tag: string): Promise<{ reportId: string; admin: Session }> {
    const admin = await registerAndLogin(`obx_admin_${tag}`)
    await promoteUser(admin.username, { admin: true })
    const target = await registerAndLogin(`obx_target_${tag}`)
    const reporter = await registerAndLogin(`obx_reporter_${tag}`)
    // Reference writes now assert asset availability (upload lifecycle
    // coordination) — the referenced file must actually exist.
    await mkdir(path.join(process.cwd(), 'public', 'uploads'), { recursive: true })
    await writeFile(path.join(process.cwd(), 'public', 'uploads', `${tag}.webp`), 'synthetic-outbox-target')
    const pRes = await api('/api/posts', {
      method: 'POST', cookie: target.cookie,
      body: JSON.stringify({ content: `outbox target ${tag}`, images: [`/uploads/${tag}.webp`] }),
    })
    expect(pRes.status).toBe(201)
    const [targetRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [target.username])
    const [reporterRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [reporter.username])
    const [postRow] = await sql<{ id: string }>(
      `SELECT id FROM "Post" WHERE content = $1`, [`outbox target ${tag}`],
    )
    const [rpt] = await sql<{ id: string }>(
      `INSERT INTO "Report" (id, "targetType", "reportedUserId", "postId", "reporterId", reason, status, "createdAt")
       VALUES ('rpt_obx_' || $4, 'POST', $1, $2, $3, 'SPAM', 'PENDING', now()) RETURNING id`,
      [targetRow.id, postRow.id, reporterRow.id, tag],
    )
    return { reportId: rpt.id, admin }
  }

  it('file-side-effect fault: committed resolution returns 200, failure is pending + retryable', async () => {
    const tag = `fault${Date.now()}`
    const { reportId, admin } = await seedPendingReport(tag)

    // Fault injection: the "image" is a DIRECTORY — unlink fails (EISDIR/EPERM),
    // a real, deterministic filesystem fault with no test hook in app code.
    const fs = await import('node:fs')
    const uploadsDir = await import('node:path').then((m) => m.join(process.cwd(), 'public', 'uploads'))
    // Upload storage is gitignored and need not exist on a fresh checkout.
    // The fixture seeded a real FILE (reference writes assert availability);
    // the fault shape replaces it with a directory so unlink fails.
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.rmSync(`${uploadsDir}/${tag}.webp`, { force: true })
    fs.mkdirSync(`${uploadsDir}/${tag}.webp`)

    const res = await api(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST', cookie: admin.cookie,
      body: JSON.stringify({ action: 'delete' }),
    })
    // The committed resolution is 200 despite the failed side effect.
    expect(res.status).toBe(200)

    const [cleanupTask] = await sql<{ id: string; status: string; attempts: number; lastError: string | null }>(
      `SELECT id, status, attempts, "lastError" FROM "SideEffectTask"
       WHERE kind = 'upload_cleanup' AND payload->>'url' = $1`, [`/uploads/${tag}.webp`],
    )
    expect(cleanupTask).toBeDefined()
    expect(cleanupTask.status).toBe('pending')
    expect(cleanupTask.attempts).toBeGreaterThanOrEqual(1)
    expect(cleanupTask.lastError).toBeTruthy()

    // Notifications still delivered (their tasks succeeded).
    const [reporterNotif] = await sql<{ userId: string }>(`
      SELECT n."userId" FROM "Notification" n JOIN "Report" r ON r."reporterId" = n."userId"
      WHERE r.id = $1 AND n.type = 'REPORT_RESOLVED' LIMIT 1`, [reportId])
    expect(reporterNotif).toBeDefined()

    // Clear the fault, then the retry endpoint compensates and tracks.
    fs.rmdirSync(`${uploadsDir}/${tag}.webp`)
    const retry = await api('/api/admin/side-effects/retry', { method: 'POST', cookie: admin.cookie })
    expect(retry.status).toBe(200)
    const retryBody = await json<{ succeeded: number; failed: number; pending: number }>(retry)
    expect(retryBody.failed).toBe(0)
    expect(retryBody.pending).toBe(0)
    expect(retryBody.succeeded).toBeGreaterThanOrEqual(1)

    const [after] = await sql<{ status: string }>(
      'SELECT status FROM "SideEffectTask" WHERE id = $1', [cleanupTask.id],
    )
    expect(after.status).toBe('succeeded')
  })

  it('notification executor fault stays pending with lastError, then recovers on default drain', async () => {
    // Service-level fault injection: drain with a throwing notification
    // executor. The vitest process's Prisma client must target the test DB.
    process.env.DATABASE_URL = TEST_DATABASE_URL
    const { drainSideEffects, sideEffectExecutors } = await import('@/lib/services/side-effect.service')

    const [task] = await sql<{ id: string }>(`
      INSERT INTO "SideEffectTask" (id, kind, payload, status, "createdAt", "updatedAt")
      VALUES ('obx_fault_notif', 'notification',
              '{"userId":"nobody","fromId":"nobody","type":"FOLLOW"}'::jsonb,
              'pending', now(), now())
      RETURNING id`)

    const faulted = await drainSideEffects({
      ids: [task.id],
      executors: {
        ...sideEffectExecutors,
        notification: async () => {
          throw new Error('injected notification fault')
        },
      },
    })
    expect(faulted.attempted).toBe(1)
    expect(faulted.succeeded).toBe(0)
    expect(faulted.failed).toBe(1)
    expect(faulted.failedTasks[0].lastError).toContain('injected notification fault')

    const [row] = await sql<{ status: string; attempts: number; lastError: string }>(
      'SELECT status, attempts, "lastError" FROM "SideEffectTask" WHERE id = $1', [task.id],
    )
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.lastError).toContain('injected notification fault')

    // Default executors: 'nobody' users fail FK validation too — the task
    // must STILL be trackable, not lost.
    const retried = await drainSideEffects({ ids: [task.id] })
    expect(retried.attempted).toBe(1)
    expect(retried.failed).toBe(1)

    // Repair the payload (a real recipient pair) and retry — recovery works.
    const [u] = await sql<{ id: string }>(`SELECT id FROM "User" LIMIT 1`)
    await sql(`UPDATE "SideEffectTask" SET payload = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ userId: u.id, fromId: u.id, type: 'FOLLOW' }), task.id,
    ])
    const recovered = await drainSideEffects({ ids: [task.id] })
    expect(recovered.succeeded).toBe(1)
    const [done] = await sql<{ status: string }>('SELECT status FROM "SideEffectTask" WHERE id = $1', [task.id])
    expect(done.status).toBe('succeeded')
  })

  it('concurrent auto-drain and admin retry claim once: exactly one notification per event', async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL
    const { drainSideEffects } = await import('@/lib/services/side-effect.service')

    const recipientUser = await registerAndLogin('obx_conc_rcpt')
    const actorUser = await registerAndLogin('obx_conc_actor')
    const [recipient] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [recipientUser.username])
    const [actor] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [actorUser.username])
    const eventKey = `obx-conc:${Date.now()}`
    const [task] = await sql<{ id: string }>(`
      INSERT INTO "SideEffectTask" (id, kind, payload, status, "createdAt", "updatedAt")
      VALUES ('obx_conc_task', 'notification', $1::jsonb, 'pending', now(), now()) RETURNING id`,
      [JSON.stringify({ userId: recipient.id, fromId: actor.id, type: 'REPORT_RESOLVED', postId: null, eventKey })],
    )

    const admin = await registerAndLogin('obx_conc_admin')
    await promoteUser(admin.username, { admin: true })

    // "Auto" drain (this process, like a route's post-commit drain) races
    // the admin retry endpoint (server process) on the SAME pending task.
    const [local, endpoint] = await Promise.all([
      drainSideEffects({ ids: [task.id] }),
      api('/api/admin/side-effects/retry', { method: 'POST', cookie: admin.cookie }),
    ])
    expect(endpoint.status).toBe(200)
    expect(local.succeeded + (await json<{ succeeded: number }>(endpoint)).succeeded).toBe(1)

    // Exactly-once observable effect: one notification row for the event,
    // covering the postId-NULL case the compound unique cannot dedup.
    const rows = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM "Notification" WHERE "eventKey" = $1', [eventKey],
    )
    expect(rows[0].n).toBe(1)
    const [after] = await sql<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM "SideEffectTask" WHERE id = $1', [task.id],
    )
    expect(after.status).toBe('succeeded')
    expect(after.attempts).toBe(0)
  })

  it('retry after delivered-but-unmarked crash produces no duplicate notification', async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL
    const { drainSideEffects } = await import('@/lib/services/side-effect.service')
    const { deliverNotification } = await import('@/lib/notification')

    const recipientUser = await registerAndLogin('obx_crash_rcpt')
    const actorUser = await registerAndLogin('obx_crash_actor')
    const [recipient] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [recipientUser.username])
    const [actor] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [actorUser.username])
    const eventKey = `obx-crash:${Date.now()}`
    const [task] = await sql<{ id: string }>(`
      INSERT INTO "SideEffectTask" (id, kind, payload, status, "createdAt", "updatedAt")
      VALUES ('obx_crash_task', 'notification', $1::jsonb, 'pending', now(), now()) RETURNING id`,
      [JSON.stringify({ userId: recipient.id, fromId: actor.id, type: 'REPORT_RESOLVED', postId: null, eventKey })],
    )

    // Simulate the previous process: notification DELIVERED, then it died
    // before marking the task succeeded (task still pending).
    await deliverNotification({ userId: recipient.id, fromId: actor.id, type: 'REPORT_RESOLVED', postId: null, eventKey })
    const [mid] = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM "Notification" WHERE "eventKey" = $1', [eventKey],
    )
    expect(mid.n).toBe(1)

    // The recipient has since READ the notification. A retry of the SAME
    // task must not re-surface it: read stays true, createdAt untouched.
    await sql(`UPDATE "Notification" SET read = true, "createdAt" = now() - interval '1 day' WHERE "eventKey" = $1`, [eventKey])
    const [asRead] = await sql<{ read: boolean; createdAt: string }>(
      'SELECT read, "createdAt" FROM "Notification" WHERE "eventKey" = $1', [eventKey],
    )
    expect(asRead.read).toBe(true)

    const drained = await drainSideEffects({ ids: [task.id] })
    expect(drained.succeeded).toBe(1)
    expect(drained.failed).toBe(0)

    const [afterRead] = await sql<{ read: boolean; createdAt: string }>(
      'SELECT read, "createdAt" FROM "Notification" WHERE "eventKey" = $1', [eventKey],
    )
    expect(afterRead.read).toBe(true)
    expect(new Date(afterRead.createdAt).getTime()).toBe(new Date(asRead.createdAt).getTime())

    // The retry's delivery collapsed onto the existing eventKey row.
    const [after] = await sql<{ n: number; status: string }>(
      'SELECT (SELECT count(*)::int FROM "Notification" WHERE "eventKey" = $1) AS n, (SELECT status FROM "SideEffectTask" WHERE id = $2) AS status',
      [eventKey, task.id],
    )
    expect(after.n).toBe(1)
    expect(after.status).toBe('succeeded')
  })

  it('same admin resolving two reports of the same post: both 200, one row per recipient, no pending tasks', async () => {
    const admin = await registerAndLogin('obx2_admin')
    await promoteUser(admin.username, { admin: true })
    const target = await registerAndLogin('obx2_target')
    const reporter = await registerAndLogin('obx2_reporter')

    const pRes = await api('/api/posts', {
      method: 'POST', cookie: target.cookie,
      body: JSON.stringify({ content: 'double-reported post' }),
    })
    const { shortCode } = await json<{ shortCode: string }>(pRes)
    const [postRow] = await sql<{ id: string }>('SELECT id FROM "Post" WHERE "shortCode" = $1', [shortCode])
    const [targetRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [target.username])
    const [reporterRow] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [reporter.username])

    // Two PENDING reports on the SAME post by the SAME reporter.
    const reportIds = ['rpt_obx2_a', 'rpt_obx2_b']
    for (const rid of reportIds) {
      await sql(`
        INSERT INTO "Report" (id, "targetType", "reportedUserId", "postId", "reporterId", reason, status, "createdAt")
        VALUES ($1, 'POST', $2, $3, $4, 'SPAM', 'PENDING', now())`,
        [rid, targetRow.id, postRow.id, reporterRow.id],
      )
    }

    const first = await api(`/api/admin/reports/${reportIds[0]}/resolve`, {
      method: 'POST', cookie: admin.cookie, body: JSON.stringify({ action: 'delete' }),
    })
    expect(first.status).toBe(200)
    const second = await api(`/api/admin/reports/${reportIds[1]}/resolve`, {
      method: 'POST', cookie: admin.cookie, body: JSON.stringify({ action: 'delete' }),
    })
    // Both resolutions succeed — the second is a DIFFERENT report, not a replay.
    expect(second.status).toBe(200)

    // The second resolution's notification tasks hit the legacy compound
    // unique (same reporter, same admin, same post). They must have
    // re-surfaced the existing row instead of going permanently pending.
    const tasks = await sql<{ status: string }>(
      `SELECT status FROM "SideEffectTask"
       WHERE payload->>'eventKey' LIKE 'report:rpt_obx2_%'`,
    )
    expect(tasks.length).toBe(4) // reporter + reported, per resolution
    expect(tasks.every((t) => t.status === 'succeeded')).toBe(true)
    const [pendingTotal] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM "SideEffectTask" WHERE status = 'pending'`,
    )
    expect(pendingTotal.n).toBe(0)

    // Exactly one notification row per recipient (compound tuple collapsed
    // across the two events). The visible row keeps the FIRST event's key;
    // the per-event delivery records (the dedup authority) exist for BOTH
    // events and point at that row.
    for (const [uid, suffix] of [[reporterRow.id, 'reporter'], [targetRow.id, 'reported']] as const) {
      const rows = await sql<{ id: string; eventKey: string }>(
        'SELECT id, "eventKey" FROM "Notification" WHERE "userId" = $1 AND type = $3 AND "postId" = $2',
        [uid, postRow.id, 'REPORT_RESOLVED'],
      )
      expect(rows.length).toBe(1)
      expect(rows[0].eventKey).toBe(`report:rpt_obx2_a:resolved:${suffix}:${uid}`)
      const deliveries = await sql<{ eventKey: string; notificationId: string | null }>(
        'SELECT "eventKey", "notificationId" FROM "NotificationDelivery" WHERE "eventKey" = ANY($1)',
        [[`report:rpt_obx2_a:resolved:${suffix}:${uid}`, `report:rpt_obx2_b:resolved:${suffix}:${uid}`]],
      )
      expect(deliveries.length).toBe(2)
      for (const d of deliveries) expect(d.notificationId).toBe(rows[0].id)
    }
  })

  it('claim honors limit: tasks beyond the limit stay unclaimed and immediately claimable', async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL
    const { drainSideEffects } = await import('@/lib/services/side-effect.service')

    const recipientUser = await registerAndLogin('obx_lim_rcpt')
    const actorUser = await registerAndLogin('obx_lim_actor')
    const [recipient] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [recipientUser.username])
    const [actor] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [actorUser.username])

    const stamp = Date.now()
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      ids.push(`obx_lim_${i}`)
      await sql(`
        INSERT INTO "SideEffectTask" (id, kind, payload, status, "createdAt", "updatedAt")
        VALUES ($1, 'notification', $2::jsonb, 'pending', now() - ($3 || ' seconds')::interval, now())`,
        [`obx_lim_${i}`, JSON.stringify({ userId: recipient.id, fromId: actor.id, type: 'FOLLOW', postId: null, eventKey: `obx-lim:${stamp}:${i}` }), String(i)],
      )
    }

    const first = await drainSideEffects({ limit: 2 })
    expect(first.attempted).toBe(2)
    expect(first.succeeded).toBe(2)

    // The three unexecuted tasks must NOT hold claims — claimable NOW,
    // not after the 60 s lease.
    const [held] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM "SideEffectTask" WHERE id = ANY($1) AND status = 'pending' AND ("claimToken" IS NOT NULL OR "claimedAt" IS NOT NULL)`,
      [ids],
    )
    expect(held.n).toBe(0)

    const second = await drainSideEffects({ limit: 2 })
    expect(second.attempted).toBe(2) // immediate, no lease lock-out
    expect(second.succeeded).toBe(2)

    const third = await drainSideEffects({ limit: 2 })
    expect(third.attempted).toBe(1)
    expect(third.succeeded).toBe(1)
    expect(third.pending).toBe(0)
  })

  it('A delivered(pending) -> B delivered -> user reads B -> retry A is a pure no-op; B retry too', async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL
    const { drainSideEffects } = await import('@/lib/services/side-effect.service')
    const { deliverNotification } = await import('@/lib/notification')

    const recipientUser = await registerAndLogin('obx_seq_rcpt')
    const actorUser = await registerAndLogin('obx_seq_actor')
    const [recipient] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [recipientUser.username])
    const [actor] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [actorUser.username])
    const pRes = await api('/api/posts', {
      method: 'POST', cookie: recipientUser.cookie, body: JSON.stringify({ content: 'sequence target post' }),
    })
    const { shortCode } = await json<{ shortCode: string }>(pRes)
    const [postRow] = await sql<{ id: string }>('SELECT id FROM "Post" WHERE "shortCode" = $1', [shortCode])

    const stamp = Date.now()
    const keyA = `obx-seq-a:${stamp}`
    const keyB = `obx-seq-b:${stamp}`
    // Both tasks pending — simulate crashed executors that delivered but
    // never marked succeeded.
    for (const [taskId, key] of [['obx_seq_task_a', keyA], ['obx_seq_task_b', keyB]] as const) {
      await sql(`
        INSERT INTO "SideEffectTask" (id, kind, payload, status, "createdAt", "updatedAt")
        VALUES ($1, 'notification', $2::jsonb, 'pending', now(), now())`,
        [taskId, JSON.stringify({ userId: recipient.id, fromId: actor.id, type: 'REPORT_RESOLVED', postId: postRow.id, eventKey: key })],
      )
    }

    // A delivered (row created, stamped keyA). B delivered afterwards:
    // genuine new event over the same tuple → re-surfaced once.
    await deliverNotification({ userId: recipient.id, fromId: actor.id, type: 'REPORT_RESOLVED', postId: postRow.id, eventKey: keyA })
    await deliverNotification({ userId: recipient.id, fromId: actor.id, type: 'REPORT_RESOLVED', postId: postRow.id, eventKey: keyB })

    // The user reads the surfaced notification.
    await sql('UPDATE "Notification" SET read = true WHERE "eventKey" = $1', [keyA])
    const [asRead] = await sql<{ id: string; eventKey: string; read: boolean; createdAt: string }>(
      'SELECT id, "eventKey", read, "createdAt" FROM "Notification" WHERE "userId" = $1 AND "postId" = $2',
      [recipient.id, postRow.id],
    )
    expect(asRead.eventKey).toBe(keyA)
    expect(asRead.read).toBe(true)

    // Retry of the OLD event A (drain executes the still-pending task):
    // pure no-op — delivery record exists; eventKey/read/createdAt frozen.
    const drainA = await drainSideEffects({ ids: ['obx_seq_task_a'] })
    expect(drainA.succeeded).toBe(1)
    const [afterA] = await sql<{ eventKey: string; read: boolean; createdAt: string }>(
      'SELECT "eventKey", read, "createdAt" FROM "Notification" WHERE id = $1', [asRead.id],
    )
    expect(afterA.eventKey).toBe(keyA)
    expect(afterA.read).toBe(true)
    expect(new Date(afterA.createdAt).getTime()).toBe(new Date(asRead.createdAt).getTime())

    // Retry of B itself: also a pure no-op.
    const drainB = await drainSideEffects({ ids: ['obx_seq_task_b'] })
    expect(drainB.succeeded).toBe(1)
    const [afterB] = await sql<{ eventKey: string; read: boolean; createdAt: string }>(
      'SELECT "eventKey", read, "createdAt" FROM "Notification" WHERE id = $1', [asRead.id],
    )
    expect(afterB.eventKey).toBe(keyA)
    expect(afterB.read).toBe(true)
    expect(new Date(afterB.createdAt).getTime()).toBe(new Date(asRead.createdAt).getTime())

    // One visible row, two immutable delivery records pointing at it.
    const rows = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM "Notification" WHERE "userId" = $1 AND "postId" = $2',
      [recipient.id, postRow.id],
    )
    expect(rows[0].n).toBe(1)
    const deliveries = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE "eventKey" = ANY($1)',
      [[keyA, keyB]],
    )
    expect(deliveries[0].n).toBe(2)
  })

  it('legacy (non-event) dedup still holds for LIKE/COMMENT/REPOST tuples', async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL
    const { deliverNotification } = await import('@/lib/notification')

    const recipientUser = await registerAndLogin('obx_leg_rcpt')
    const actorUser = await registerAndLogin('obx_leg_actor')
    const [recipient] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [recipientUser.username])
    const [actor] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [actorUser.username])
    const pRes = await api('/api/posts', {
      method: 'POST', cookie: recipientUser.cookie, body: JSON.stringify({ content: 'legacy dedup post' }),
    })
    const { shortCode } = await json<{ shortCode: string }>(pRes)
    const [postRow] = await sql<{ id: string }>('SELECT id FROM "Post" WHERE "shortCode" = $1', [shortCode])

    // PostId-based path (LIKE/COMMENT/REPOST shape): repeated delivery over
    // the same tuple collapses to ONE row via the compound unique.
    for (let i = 0; i < 3; i++) {
      await deliverNotification({ userId: recipient.id, fromId: actor.id, type: 'LIKE', postId: postRow.id })
    }
    const likeRows = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM "Notification" WHERE "userId" = $1 AND "fromId" = $2 AND type = $4 AND "postId" = $3',
      [recipient.id, actor.id, postRow.id, 'LIKE'],
    )
    expect(likeRows[0].n).toBe(1)

    // Null-postId path (FOLLOW shape): application-level dedup also one row.
    for (let i = 0; i < 3; i++) {
      await deliverNotification({ userId: recipient.id, fromId: actor.id, type: 'FOLLOW', postId: null })
    }
    const followRows = await sql<{ n: number }>(
      'SELECT count(*)::int AS n FROM "Notification" WHERE "userId" = $1 AND "fromId" = $2 AND type = $3',
      [recipient.id, actor.id, 'FOLLOW'],
    )
    expect(followRows[0].n).toBe(1)
  })

  it('claim is mutually exclusive across two live connections (FOR UPDATE SKIP LOCKED)', async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL
    const { buildSideEffectClaimSql } = await import('@/lib/services/side-effect.service')

    const recipientUser = await registerAndLogin('obx_cnt_rcpt')
    const actorUser = await registerAndLogin('obx_cnt_actor')
    const [recipient] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [recipientUser.username])
    const [actor] = await sql<{ id: string }>('SELECT id FROM "User" WHERE username = $1', [actorUser.username])
    for (let i = 1; i <= 3; i++) {
      await sql(`
        INSERT INTO "SideEffectTask" (id, kind, payload, status, "createdAt", "updatedAt")
        VALUES ($1, 'notification', $2::jsonb, 'pending', now() - ($3 || ' seconds')::interval, now())`,
        [`obx_cnt_${i}`, JSON.stringify({ userId: recipient.id, fromId: actor.id, type: 'FOLLOW', postId: null, eventKey: `obx-cnt:${Date.now()}:${i}` }), String(i)],
      )
    }

    const { Client } = await import('pg')
    const c1 = new Client({ connectionString: TEST_DATABASE_URL })
    const c2 = new Client({ connectionString: TEST_DATABASE_URL })
    await c1.connect()
    await c2.connect()
    try {
      // Executor 1 claims ONE task (limit 1) inside an OPEN transaction —
      // its row lock stays held, uncommitted.
      const claim1 = buildSideEffectClaimSql('obx-token-conn1', { limit: 1, leaseSeconds: 60 })
      await c1.query('BEGIN')
      const r1 = await c1.query<{ id: string }>(claim1.text, claim1.values)
      // Seed stagger makes obx_cnt_3 the OLDEST row, so createdAt-ASC claims it first.
      expect(r1.rows.map((r) => r.id)).toEqual(['obx_cnt_3'])

      // Executor 2 claims while executor 1's transaction is still open:
      // SKIP LOCKED excludes the held row — disjoint sets, no blocking.
      const claim2 = buildSideEffectClaimSql('obx-token-conn2', { limit: 3, leaseSeconds: 60 })
      const r2 = await c2.query<{ id: string }>(claim2.text, claim2.values)
      expect(r2.rows.map((r) => r.id).sort()).toEqual(['obx_cnt_1', 'obx_cnt_2'])

      await c1.query('COMMIT')

      // The contended task belongs to exactly one executor.
      const [owner] = await sql<{ claimToken: string | null }>(
        'SELECT "claimToken" FROM "SideEffectTask" WHERE id = $1', ['obx_cnt_3'],
      )
      expect(owner.claimToken).toBe('obx-token-conn1')
    } finally {
      await c1.query('ROLLBACK').catch(() => {})
      await c1.end()
      await c2.end()
      await sql(`DELETE FROM "SideEffectTask" WHERE id LIKE 'obx\_cnt\_%'`)
    }
  })

  it('retry endpoint is admin-gated', async () => {
    const anon = await api('/api/admin/side-effects/retry', { method: 'POST' })
    expect(anon.status).toBe(401)
    const author = await registerAndLogin('obx_plain_user')
    const forbidden = await api('/api/admin/side-effects/retry', { method: 'POST', cookie: author.cookie })
    expect(forbidden.status).toBe(403)
  })
})

describe('notification cursor contract (invalid input is 400, never 500)', () => {
  it('rejects non-cursor garbage with a standard 400 bad_request', async () => {
    const res = await api('/api/notifications?cursor=banana', { cookie: alice.cookie })
    expect(res.status).toBe(400)
    const body = await json<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('bad_request')
  })

  it('rejects malformed compound cursors (empty id / non-canonical timestamp)', async () => {
    const emptyId = await api('/api/notifications?cursor=2026-01-01T00%3A00%3A00.000Z%7C', { cookie: alice.cookie })
    expect(emptyId.status).toBe(400)
    const notIso = await api('/api/notifications?cursor=not-a-date%7Csomeid', { cookie: alice.cookie })
    expect(notIso.status).toBe(400)
    // Round-trip mismatch: a syntactically ISO-looking timestamp that Date
    // normalizes (e.g. 24:00 hour) is not a cursor this API ever emitted.
    const normalized = await api('/api/notifications?cursor=2026-01-01T24%3A00%3A00.000Z%7Cabc', { cookie: alice.cookie })
    expect(normalized.status).toBe(400)
  })

  it('still answers 200 for a well-formed cursor and keeps the first page shape', async () => {
    const cursor = encodeURIComponent(`${new Date().toISOString()}|someid`)
    const valid = await api(`/api/notifications?cursor=${cursor}`, { cookie: alice.cookie })
    expect(valid.status).toBe(200)
    const body = await json<{ notifications: unknown[]; nextCursor: string | null }>(valid)
    expect(Array.isArray(body.notifications)).toBe(true)
    expect('nextCursor' in body).toBe(true)
  })
})

describe('concurrent lock ordering regressions (advisory-gated true deadlocks)', () => {
  // Reproduction harness from the 1.2.0 audit: a dedicated controller
  // connection holds SESSION advisory gates 120001/120002, and test-scoped
  // DB triggers take the matching XACT advisory lock the moment a
  // transaction acquires its FIRST conflicting row lock. Both requests are
  // fired, we wait until BOTH park on the gates (deterministic AB-BA
  // setup), then release simultaneously. Deadlock-free code always
  // completes with consistent counters; the pre-fix code deadlocked
  // (P2034 → HTTP 500). If the code is already fixed, only ONE waiter can
  // ever reach a gate (the loser parks on a row lock instead), the bounded
  // poll times out, and both requests still complete.
  const GATE_A = 120001
  const GATE_B = 120002

  async function gatedPair(
    installSql: string,
    cleanupSql: string,
    fire: () => Promise<Response>[],
    minWaiters = 2,
    budgetMs = 2500,
  ): Promise<{ responses: Response[]; gatedWaiters: number }> {
    const { Client } = await import('pg')
    const ctrl = new Client({ connectionString: TEST_DATABASE_URL })
    await ctrl.connect()
    let gatedWaiters = 0
    try {
      await ctrl.query('SELECT pg_advisory_lock($1), pg_advisory_lock($2)', [GATE_A, GATE_B])
      await sql(installSql)
      try {
        const pending = fire()
        const deadline = Date.now() + budgetMs
        while (Date.now() < deadline) {
          const rows = await sql<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event = 'advisory'
               AND cardinality(pg_blocking_pids(pid)) > 0`,
          )
          gatedWaiters = rows.length
          if (gatedWaiters >= minWaiters) break
          await new Promise((r) => setTimeout(r, 25))
        }
        await ctrl.query('SELECT pg_advisory_unlock($1), pg_advisory_unlock($2)', [GATE_A, GATE_B])
        return { responses: await Promise.all(pending), gatedWaiters }
      } finally {
        await sql(cleanupSql)
      }
    } finally {
      await ctrl.query('SELECT pg_advisory_unlock($1), pg_advisory_unlock($2)', [GATE_A, GATE_B]).catch(() => {})
      await ctrl.end()
    }
  }

  async function assertFollowInvariants(userIds: string[]) {
    const rows = await sql<{
      username: string
      followingCount: number
      followerCount: number
      outgoing: number
      incoming: number
    }>(`SELECT u.username, u."followingCount", u."followerCount",
          (SELECT count(*)::int FROM "Follow" f WHERE f."followerId" = u.id) AS outgoing,
          (SELECT count(*)::int FROM "Follow" f WHERE f."followingId" = u.id) AS incoming
        FROM "User" u WHERE u.id = ANY($1) ORDER BY u.username`, [userIds])
    expect(rows.length).toBe(userIds.length)
    for (const r of rows) {
      expect(r.followingCount).toBe(r.outgoing)
      expect(r.followerCount).toBe(r.incoming)
    }
    return rows
  }

  function userGateTrigger(aId: string, bId: string, direction: 'up' | 'down'): string {
    const cmp = direction === 'up' ? '>' : '<'
    return `CREATE FUNCTION lock_gate_user() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."followingCount" ${cmp} OLD."followingCount" THEN
          IF NEW.id = '${aId}' THEN PERFORM pg_advisory_xact_lock(${GATE_A});
          ELSIF NEW.id = '${bId}' THEN PERFORM pg_advisory_xact_lock(${GATE_B}); END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER lock_gate_user BEFORE UPDATE ON "User"
      FOR EACH ROW EXECUTE FUNCTION lock_gate_user()`
  }
  const USER_GATE_CLEANUP = `DROP TRIGGER IF EXISTS lock_gate_user ON "User"; DROP FUNCTION IF EXISTS lock_gate_user()`

  it('mutual follow completes with consistent counters (was: opposed User lock order → P2034 500)', async () => {
    const ua = await registerAndLogin('lock_follow_a')
    const ub = await registerAndLogin('lock_follow_b')
    const ids = await sql<{ id: string; username: string }>(
      `SELECT id, username FROM "User" WHERE username = ANY($1) ORDER BY username`, [[ua.username, ub.username]],
    )
    const [aId, bId] = ids.map((r) => r.id)

    const { responses } = await gatedPair(
      userGateTrigger(aId, bId, 'up'),
      USER_GATE_CLEANUP,
      () => [
        api(`/api/users/${ub.username}/follow`, { method: 'POST', cookie: ua.cookie }),
        api(`/api/users/${ua.username}/follow`, { method: 'POST', cookie: ub.cookie }),
      ],
    )
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    const rows = await assertFollowInvariants([aId, bId])
    for (const r of rows) {
      expect(r.outgoing).toBe(1)
      expect(r.incoming).toBe(1)
    }
  })

  it('mutual unfollow completes with consistent counters (opposed order on the decrement path)', async () => {
    const ua = await registerAndLogin('lock_unf_a')
    const ub = await registerAndLogin('lock_unf_b')
    // Pre-state: A and B follow each other.
    for (const [cookie, name] of [[ua.cookie, ub.username], [ub.cookie, ua.username]] as const) {
      const res = await api(`/api/users/${name}/follow`, { method: 'POST', cookie })
      expect(res.status).toBe(200)
    }
    const ids = await sql<{ id: string; username: string }>(
      `SELECT id, username FROM "User" WHERE username = ANY($1) ORDER BY username`, [[ua.username, ub.username]],
    )
    const [aId, bId] = ids.map((r) => r.id)

    const { responses } = await gatedPair(
      userGateTrigger(aId, bId, 'down'),
      USER_GATE_CLEANUP,
      () => [
        api(`/api/users/${ub.username}/follow`, { method: 'DELETE', cookie: ua.cookie }),
        api(`/api/users/${ua.username}/follow`, { method: 'DELETE', cookie: ub.cookie }),
      ],
    )
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    const rows = await assertFollowInvariants([aId, bId])
    for (const r of rows) {
      expect(r.outgoing).toBe(0)
      expect(r.incoming).toBe(0)
    }
  })

  it('concurrent duplicate follows stay idempotent: one relation row, exact counters', async () => {
    const ua = await registerAndLogin('lock_dup_a')
    const ub = await registerAndLogin('lock_dup_b')
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        api(`/api/users/${ub.username}/follow`, { method: 'POST', cookie: ua.cookie }),
      ),
    )
    for (const res of responses) expect(res.status).toBe(200)
    const [rel] = await sql<{ count: number }>(
      `SELECT count(*)::int AS count FROM "Follow" f
        JOIN "User" x ON x.id = f."followerId" JOIN "User" y ON y.id = f."followingId"
       WHERE x.username = $1 AND y.username = $2`, [ua.username, ub.username],
    )
    expect(rel.count).toBe(1)
    const ids = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = ANY($1)`, [[ua.username, ub.username]])
    const rows = await assertFollowInvariants(ids.map((r) => r.id))
    for (const r of rows) {
      expect(r.outgoing).toBe(r.username === ua.username ? 1 : 0)
      expect(r.incoming).toBe(r.username === ub.username ? 1 : 0)
    }
  })

  it('interleaved follow/unfollow burst never corrupts the pair; settling state is exact', async () => {
    const ua = await registerAndLogin('lock_mix_a')
    const ub = await registerAndLogin('lock_mix_b')
    // 10 mixed-direction operations racing on the same pair (follow/unfollow
    // cross both lock orders). Every request must complete; invariants are
    // checked live and again after a deterministic settle.
    const ops = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const [cookie, name, method] = i % 2 === 0
          ? [ua.cookie, ub.username, 'POST'] as const
          : [ub.cookie, ua.username, i % 4 === 1 ? 'POST' : 'DELETE'] as const
        return api(`/api/users/${name}/follow`, { method, cookie })
      }),
    )
    for (const res of ops) expect(res.status).toBe(200)
    const ids = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = ANY($1)`, [[ua.username, ub.username]])
    await assertFollowInvariants(ids.map((r) => r.id))
    // Deterministic settle: the burst may leave EITHER direction followed
    // (ub→ua POSTs are part of the mix) — ensure both, then unfollow both.
    for (const [cookie, name] of [[ua.cookie, ub.username], [ub.cookie, ua.username]] as const) {
      const ensure = await api(`/api/users/${name}/follow`, { method: 'POST', cookie })
      expect(ensure.status).toBe(200)
    }
    for (const [cookie, name] of [[ua.cookie, ub.username], [ub.cookie, ua.username]] as const) {
      const drop = await api(`/api/users/${name}/follow`, { method: 'DELETE', cookie })
      expect(drop.status).toBe(200)
    }
    const rows = await assertFollowInvariants(ids.map((r) => r.id))
    for (const r of rows) {
      expect(r.outgoing).toBe(0)
      expect(r.incoming).toBe(0)
    }
  })

  function casGateTrigger(casA: string, casB: string): string {
    return `CREATE FUNCTION lock_gate_cas() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."casNumber" = '${casA}' THEN PERFORM pg_advisory_xact_lock(${GATE_A});
        ELSIF NEW."casNumber" = '${casB}' THEN PERFORM pg_advisory_xact_lock(${GATE_B}); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER lock_gate_cas AFTER INSERT ON "Chemical"
      FOR EACH ROW EXECUTE FUNCTION lock_gate_cas()`
  }
  const CAS_GATE_CLEANUP = `DROP TRIGGER IF EXISTS lock_gate_cas ON "Chemical"; DROP FUNCTION IF EXISTS lock_gate_cas()`

  async function assertCasInvariants(casNumbers: string[]) {
    const rows = await sql<{ casNumber: string; postCount: number; actual: number }>(
      `SELECT c."casNumber", c."postCount",
         (SELECT count(*)::int FROM "_ChemicalToPost" pc JOIN "Post" p ON p.id = pc."B"
           WHERE pc."A" = c.id AND p."deletedAt" IS NULL) AS actual
       FROM "Chemical" c WHERE c."casNumber" = ANY($1) ORDER BY c."casNumber"`, [casNumbers],
    )
    expect(rows.length).toBe(casNumbers.length)
    for (const r of rows) expect(r.postCount).toBe(r.actual)
    return rows
  }

  it('opposed CAS orders on create both commit (was: [A,B] vs [B,A] Chemical upserts → P2034 500)', async () => {
    const ua = await registerAndLogin('lock_cas_a')
    const ub = await registerAndLogin('lock_cas_b')
    const casA = '2000001-11-1'
    const casB = '2000002-11-1'

    const { responses } = await gatedPair(
      casGateTrigger(casA, casB),
      CAS_GATE_CLEANUP,
      () => [
        api('/api/posts', { method: 'POST', cookie: ua.cookie, body: JSON.stringify({ content: 'opposed cas a', casNumbers: [casA, casB] }) }),
        api('/api/posts', { method: 'POST', cookie: ub.cookie, body: JSON.stringify({ content: 'opposed cas b', casNumbers: [casB, casA] }) }),
      ],
    )
    expect(responses.map((r) => r.status)).toEqual([201, 201])
    const rows = await assertCasInvariants([casA, casB])
    for (const r of rows) expect(r.actual).toBe(2)
  })

  it('opposed CAS orders on edit-replace both commit with exact postCounts', async () => {
    const ua = await registerAndLogin('lock_rep_a')
    const ub = await registerAndLogin('lock_rep_b')
    const casA = '2000011-11-1'
    const casB = '2000012-11-1'
    const mk = async (cookie: string, content: string) => {
      const res = await api('/api/posts', { method: 'POST', cookie, body: JSON.stringify({ content }) })
      expect(res.status).toBe(201)
      return json<{ shortCode: string }>(res)
    }
    // One post per author, both edited concurrently to opposed NEW
    // chemical sets (both CAS fresh → insert-gated).
    const p1 = await mk(ua.cookie, 'replace source one')
    const p2 = await mk(ub.cookie, 'replace source two')

    const { responses } = await gatedPair(
      casGateTrigger(casA, casB),
      CAS_GATE_CLEANUP,
      () => [
        api(`/api/posts/${p1.shortCode}`, { method: 'PATCH', cookie: ua.cookie, body: JSON.stringify({ content: 'replace one', casNumbers: [casA, casB] }) }),
        api(`/api/posts/${p2.shortCode}`, { method: 'PATCH', cookie: ub.cookie, body: JSON.stringify({ content: 'replace two', casNumbers: [casB, casA] }) }),
      ],
    )
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    const rows = await assertCasInvariants([casA, casB])
    for (const r of rows) expect(r.actual).toBe(2)
  })
})

describe('advisory hash-collision lock ordering (real resource keys, not CAS order)', () => {
  // The advisory admission locks are keyed by hashtext(namespace||cas), NOT
  // by the CAS string. Sorting the CAS list does not order the lock
  // RESOURCES: two distinct CAS can hash to the same key, letting two
  // transactions acquire the SAME pair of resources in opposite orders
  // (independently reproduced deadlock 40P01 in the 1.2.0 review).
  //
  // Deterministic staging (fix-agnostic): a controller session holds BOTH
  // resource keys; both requests fire and queue on their first resource;
  // release H, wait until a request backend provably HOLDS H; release J.
  // Pre-fix the two requests' first keys differ ([A,B]→H, [B,C]→J), so the
  // loser of the J grant waits on the H holder → real 40P01. Post-fix both
  // requests take the numerically-smallest key first, so the same staging
  // merely serializes them. Observation timeouts FAIL the test — coverage
  // is never assumed from a race that did not form.
  const CAS_A = '7009484-11-4'
  const CAS_B = '7009485-11-7'
  const CAS_C = '7107931-11-6'

  async function resourceKey(cas: string): Promise<string> {
    const [row] = await sql<{ key: string }>(
      `SELECT hashtext('cascool:chemical:' || $1)::text AS key`, [cas],
    )
    return row.key
  }

  async function assertCollisionCasInvariants(expected: Record<string, number>) {
    const rows = await sql<{ casNumber: string; postCount: number; actual: number }>(
      `SELECT c."casNumber", c."postCount",
         (SELECT count(*)::int FROM "_ChemicalToPost" pc JOIN "Post" p ON p.id = pc."B"
           WHERE pc."A" = c.id AND p."deletedAt" IS NULL) AS actual
       FROM "Chemical" c WHERE c."casNumber" = ANY($1) ORDER BY c."casNumber"`,
      [Object.keys(expected)],
    )
    expect(rows.length).toBe(Object.keys(expected).length)
    for (const r of rows) {
      expect(r.postCount).toBe(r.actual)
      expect(r.actual).toBe(expected[r.casNumber])
    }
  }

  it('precondition: A and C collide on the actual advisory resource key, B is distinct', async () => {
    const keyA = await resourceKey(CAS_A)
    const keyC = await resourceKey(CAS_C)
    const keyB = await resourceKey(CAS_B)
    expect(keyA).toBe(keyC) // real collision on the lock resource
    expect(keyB).not.toBe(keyA) // B maps to a different resource
  })

  /**
   * Stage the FIFO interleave and return both responses. `fire` launches
   * the two HTTP requests; the controller coordinates only the advisory
   * resources H (=key(A)=key(C)) and J (=key(B)).
   */
  async function stagedCollisionPair(fire: () => Promise<Response>[]): Promise<Response[]> {
    const { Client } = await import('pg')
    const H = BigInt(await resourceKey(CAS_A))
    const J = BigInt(await resourceKey(CAS_B))
    const ctrl = new Client({ connectionString: TEST_DATABASE_URL })
    await ctrl.connect()
    const ctrlPid = (await ctrl.query<{ pid: string }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    async function waitUntil(desc: string, check: () => Promise<boolean>, budgetMs = 4000): Promise<void> {
      const deadline = Date.now() + budgetMs
      while (Date.now() < deadline) {
        if (await check()) return
        await sleep(25)
      }
      throw new Error(`staging observation timed out: ${desc} (race did not form — refusing to claim coverage)`)
    }

    try {
      await ctrl.query('SELECT pg_advisory_lock($1::int8), pg_advisory_lock($2::int8)', [H, J])
      const pending = fire()

      // Both request backends must reach the advisory stage (queued on
      // whichever resource is THEIR first — differs pre-fix, shared H
      // post-fix).
      await waitUntil('both requests waiting on advisory resources', async () => {
        const rows = await sql<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event = 'advisory'
             AND cardinality(pg_blocking_pids(pid)) > 0 AND pid <> $1`,
          [ctrlPid],
        )
        return rows.length >= 2
      })

      // Release H; the sole/pre-fix-only H waiter takes it and moves on.
      await ctrl.query('SELECT pg_advisory_unlock($1::int8)', [H])
      await waitUntil('a request backend provably holds resource H', async () => {
        const rows = await sql<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND granted AND pid <> $1
             AND objid = ($2::bigint & 4294967295)`,
          [ctrlPid, H],
        )
        return rows[0].n > 0
      })

      // Release J. Pre-fix: FIFO grants J to the earlier [B,C] waiter →
      // it waits on H (held by [A,B]) which waits on J → 40P01. Post-fix:
      // the H holder takes J and finishes; the other follows in order.
      await ctrl.query('SELECT pg_advisory_unlock($1::int8)', [J])
      return await Promise.all(pending)
    } finally {
      await ctrl.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      await ctrl.end()
    }
  }

  it('colliding resource orders on create both commit (was: 40P01 deadlock → 500)', async () => {
    const ua = await registerAndLogin('lock_hc_a')
    const ub = await registerAndLogin('lock_hc_b')
    const before = await readCollisionCounts()

    const responses = await stagedCollisionPair(() => [
      api('/api/posts', { method: 'POST', cookie: ua.cookie, body: JSON.stringify({ content: 'collision pair one', casNumbers: [CAS_A, CAS_B] }) }),
      api('/api/posts', { method: 'POST', cookie: ub.cookie, body: JSON.stringify({ content: 'collision pair two', casNumbers: [CAS_B, CAS_C] }) }),
    ])
    expect(responses.map((r) => r.status)).toEqual([201, 201])

    const posts = await sql<{ content: string; cas: string[] }>(
      `SELECT p.content, array_agg(c."casNumber" ORDER BY c."casNumber") AS cas
       FROM "Post" p JOIN "_ChemicalToPost" pc ON pc."B" = p.id
         JOIN "Chemical" c ON c.id = pc."A"
       WHERE p.content LIKE 'collision pair%' AND p."deletedAt" IS NULL
       GROUP BY p.id, p.content ORDER BY p.content`,
    )
    expect(posts).toHaveLength(2)
    expect(posts[0].cas).toEqual([CAS_A, CAS_B])
    expect(posts[1].cas).toEqual([CAS_B, CAS_C])
    await assertCollisionCasInvariants({
      [CAS_A]: (before[CAS_A] ?? 0) + 1,
      [CAS_B]: (before[CAS_B] ?? 0) + 2,
      [CAS_C]: (before[CAS_C] ?? 0) + 1,
    })
  })

  async function readCollisionCounts(): Promise<Record<string, number>> {
    const rows = await sql<{ casNumber: string; actual: number }>(
      `SELECT c."casNumber",
         (SELECT count(*)::int FROM "_ChemicalToPost" pc JOIN "Post" p ON p.id = pc."B"
           WHERE pc."A" = c.id AND p."deletedAt" IS NULL) AS actual
       FROM "Chemical" c WHERE c."casNumber" = ANY($1)`, [[CAS_A, CAS_B, CAS_C]],
    )
    return Object.fromEntries(rows.map((r) => [r.casNumber, r.actual]))
  }

  it('colliding resource orders on edit-replace both commit with exact postCounts', async () => {
    const ua = await registerAndLogin('lock_he_a')
    const ub = await registerAndLogin('lock_he_b')
    const mk = async (cookie: string, content: string) => {
      const res = await api('/api/posts', { method: 'POST', cookie, body: JSON.stringify({ content }) })
      expect(res.status).toBe(201)
      return json<{ shortCode: string }>(res)
    }
    const p1 = await mk(ua.cookie, 'collision edit source one')
    const p2 = await mk(ub.cookie, 'collision edit source two')
    // Delta assertion: independent of what earlier tests in this file
    // already associated with the (fixed) collision triple.
    const before = await readCollisionCounts()

    const responses = await stagedCollisionPair(() => [
      api(`/api/posts/${p1.shortCode}`, { method: 'PATCH', cookie: ua.cookie, body: JSON.stringify({ content: 'collision edit one', casNumbers: [CAS_A, CAS_B] }) }),
      api(`/api/posts/${p2.shortCode}`, { method: 'PATCH', cookie: ub.cookie, body: JSON.stringify({ content: 'collision edit two', casNumbers: [CAS_C, CAS_B] }) }),
    ])
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    await assertCollisionCasInvariants({
      [CAS_A]: (before[CAS_A] ?? 0) + 1,
      [CAS_B]: (before[CAS_B] ?? 0) + 2,
      [CAS_C]: (before[CAS_C] ?? 0) + 1,
    })
  })
})
