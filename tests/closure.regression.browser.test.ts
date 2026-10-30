// Browser (mobile viewport) regression suite for the closure work:
//   C1 — notification list pagination must advance past the SSR page
//   D  — server props that DID arrive must converge into PostActions state
// Asserts post-fix behavior; run on the baseline first for red evidence.
import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { chromium, type Browser, type Page } from 'playwright'
import { provisionTestDatabase, dropTestDatabase, sql } from './helpers/db'
import { TEST_DATABASE_URL, SERVER_URL } from './helpers/env'
import { startProdTestServer, stopProdTestServer } from './helpers/server-prod'
import { api, registerAndLogin, type Session } from './helpers/http'

vi.setConfig({ hookTimeout: 900_000, testTimeout: 60_000 })

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }))
const db = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => db)
let pool: Pool
let browser: Browser
let a: Session, b: Session
let aid: string, bid: string

beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(TEST_DATABASE_URL).hostname)) {
    throw new Error('Local regression only')
  }
  await provisionTestDatabase()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  pool = new Pool({ connectionString: TEST_DATABASE_URL })
  db.prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  // Production build against the throwaway DB, then `next start`. The target
  // of these suites is client hydration behavior — dev-mode HMR plumbing
  // must not be a variable (and production mode is what ships).
  execFileSync('npx', ['next', 'build'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, JWT_SECRET: 'browser-suite-build-secret' },
    stdio: 'inherit',
  })
  await startProdTestServer()
  a = await registerAndLogin('uia')
  b = await registerAndLogin('uib')
  aid = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [a.username]))[0].id
  bid = (await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [b.username]))[0].id
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await browser?.close()
  await stopProdTestServer()
  await db.prisma?.$disconnect()
  await pool?.end()
  await dropTestDatabase()
})

async function sessionPage(cookie: string): Promise<{ context: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addCookies([{ name: 'feed_session', value: cookie.slice('feed_session='.length), url: SERVER_URL }])
  const page = await context.newPage()
  return { context, page }
}

async function seedNotifications(count: number, sameTs: boolean) {
  await sql('DELETE FROM "Notification" WHERE "userId"=$1', [bid])
  await sql(`DELETE FROM "User" WHERE username LIKE 'closure_ui_%'`)
  // One synthetic actor per row — the (userId, fromId, type) partial unique
  // arbiter requires one visible notification per actor, like production.
  await sql(`INSERT INTO "User" (id, email, username, "passwordHash", "createdAt", "updatedAt")
    SELECT 'closure_ui_actor_'||i, 'closure_ui_actor_'||i||'@test.local', 'closure_ui_'||i, 'x', now(), now()
    FROM generate_series(1, ${count} + 1) i`, [])
  const tsExpr = sameTs ? "'2026-06-01'::timestamp" : "timezone('utc',now())+i*interval '1 millisecond'"
  await sql(
    `INSERT INTO "Notification" (id,"userId","fromId",type,"createdAt")
     SELECT 'closure_ui_'||i,$1,'closure_ui_actor_'||i,'FOLLOW',${tsExpr} FROM generate_series(1,${count}) i`,
    [bid],
  )
}

/** Rows link to their actor's profile: /u/closure_ui_<n>. */
const rowLocator = (page: Page) => page.locator('a.border-b[href^="/u/closure_ui_"]')

// ── C1: the infinite list must reach the last notification and stop ──

it('notification list advances past 30 SSR rows to the true end and stops requesting', async () => {
  await seedNotifications(31, false)
  const { context, page } = await sessionPage(b.cookie)
  const notificationRequests: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/notifications')) notificationRequests.push(r.url()) })
  try {
    await page.goto(`${SERVER_URL}/notifications`, { waitUntil: 'networkidle' })
    const rows = rowLocator(page)
    expect(await rows.count()).toBe(30)
    // First page comes from SSR seed; scrolling must FETCH page 2.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(1500)
    expect(await rows.count()).toBe(31)
    expect(notificationRequests.some((u) => u.includes('cursor='))).toBe(true)
    // The 31st (oldest) notification is visible.
    await rows.nth(30).scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    const lastBox = await rows.nth(30).boundingBox()
    expect(lastBox).not.toBeNull()
    // End of list: no further requests after another scroll attempt.
    const before = notificationRequests.length
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(1200)
    expect(notificationRequests.length).toBe(before)
  } finally { await context.close() }
})

it('notification list pages through 61 items across multiple fetches without duplicates', async () => {
  await seedNotifications(61, false)
  const { context, page } = await sessionPage(b.cookie)
  const responses: { ids: string[] }[] = []
  page.on('response', async (r) => {
    if (r.url().includes('/api/notifications')) {
      try {
        const body = (await r.json()) as { notifications: { id: string }[] }
        responses.push({ ids: body.notifications.map((n) => n.id) })
      } catch { /* redirect/empty */ }
    }
  })
  try {
    await page.goto(`${SERVER_URL}/notifications`, { waitUntil: 'networkidle' })
    const rows = rowLocator(page)
    for (let i = 0; i < 4; i++) {
      if ((await rows.count()) >= 61) break
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(1200)
    }
    expect(await rows.count()).toBe(61)
    // No duplicate rows were rendered.
    const rendered = await rowLocator(page).evaluateAll(
      (els) => els.map((e) => e.getAttribute('href') + '|' + e.textContent?.slice(0, 40)),
    )
    expect(new Set(rendered).size).toBe(rendered.length)
    expect(responses.length).toBeGreaterThanOrEqual(2)
  } finally { await context.close() }
})

it('notification list with 0 items renders the empty state without runtime errors', async () => {
  await seedNotifications(0, false)
  const { context, page } = await sessionPage(b.cookie)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    page.on('console', (m) => { if (m.type() === 'error') console.log('EMPTY-PAGE-CONSOLE:', m.text().slice(0, 500)) })
    await page.goto(`${SERVER_URL}/notifications`, { waitUntil: 'networkidle' })
    expect(await rowLocator(page).count()).toBe(0)
    console.log('EMPTY-PAGE pageerrors:', JSON.stringify(errors))
    const home = await context.newPage()
    const homeErrors: string[] = []
    home.on('pageerror', (e) => homeErrors.push(e.message.slice(0, 120)))
    await home.goto(`${SERVER_URL}/`, { waitUntil: 'networkidle' })
    console.log('HOME pageerrors:', JSON.stringify(homeErrors))
    const login = await context.newPage()
    const loginErrors: string[] = []
    login.on('pageerror', (e) => loginErrors.push(e.message.slice(0, 120)))
    await login.goto(`${SERVER_URL}/login`, { waitUntil: 'networkidle' })
    console.log('LOGIN pageerrors:', JSON.stringify(loginErrors))
    await login.close()
    await home.close()
    expect(errors).toEqual([])
  } finally { await context.close() }
})

it('notification list with same-millisecond timestamps pages without gaps or repeats', async () => {
  await seedNotifications(45, true)
  const { context, page } = await sessionPage(b.cookie)
  try {
    await page.goto(`${SERVER_URL}/notifications`, { waitUntil: 'networkidle' })
    const rows = rowLocator(page)
    for (let i = 0; i < 4; i++) {
      if ((await rows.count()) >= 45) break
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(1200)
    }
    expect(await rows.count()).toBe(45)
  } finally { await context.close() }
})

// ── D: production convergence through the REAL refetch chain:
// out-of-band like → SWR focus revalidation (dispatched after the 5s
// focusThrottleInterval; the page-load focus starts that window) →
// refetched list delivers new props → the SAME PostActions instance
// converges without reload or remount. Also covers the lost-update fix:
// props arriving while an interaction is pending are applied after it
// settles. ──

it('out-of-band like converges in place via focus revalidation (no reload)', async () => {
  const created = await api('/api/posts', { method: 'POST', cookie: a.cookie, body: JSON.stringify({ content: 'closure web state sync' }) })
  expect(created.status).toBe(201)
  const post = (await created.json()) as unknown as { shortCode: string; id: string }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addCookies([{ name: 'feed_session', value: b.cookie.slice('feed_session='.length), url: SERVER_URL }])
  const page = await context.newPage()
  const refetches: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/posts?')) refetches.push(r.url()) })
  try {
    await page.goto(`${SERVER_URL}/u/${a.username}`, { waitUntil: 'networkidle' })
    const card = page.locator('article').filter({ hasText: 'closure web state sync' }).first()
    // The like control's accessible NAME flips with state (Like ⇄ Unlike);
    // assertions key on the pressed state itself, never on the label.
    const likeButton = card.getByRole('button', { name: /^(Like|Unlike)$/ })
    expect(await likeButton.getAttribute('aria-pressed')).toBe('false')
    const initialRefetches = refetches.length

    // The same user, from another client, likes the post out of band.
    expect((await api(`/api/posts/${post.shortCode}/like`, { method: 'POST', cookie: b.cookie })).status).toBe(200)

    // Focus AFTER the throttle window opened by the page-load focus event.
    await page.waitForTimeout(6000)
    await page.evaluate(() => {
      window.dispatchEvent(new FocusEvent('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect
      .poll(async () => refetches.length, { timeout: 10_000, interval: 500 })
      .toBeGreaterThan(initialRefetches) // refetch actually happened

    // The SAME instance converged to the server truth (no reload/remount).
    await expect
      .poll(async () => await likeButton.getAttribute('aria-pressed'), { timeout: 10_000, interval: 500 })
      .toBe('true')

    // Reverse: out-of-band UNLIKE must also converge in place.
    expect((await api(`/api/posts/${post.shortCode}/like`, { method: 'DELETE', cookie: b.cookie })).status).toBe(200)
    await page.waitForTimeout(6000)
    await page.evaluate(() => {
      window.dispatchEvent(new FocusEvent('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect
      .poll(async () => await likeButton.getAttribute('aria-pressed'), { timeout: 10_000, interval: 500 })
      .toBe('false')
  } finally { await context.close() }
})

it('props arriving during a pending interaction are applied after it settles (no lost update)', async () => {
  const created = await api('/api/posts', { method: 'POST', cookie: a.cookie, body: JSON.stringify({ content: 'closure pending hold sync' }) })
  expect(created.status).toBe(201)
  const post = (await created.json()) as unknown as { shortCode: string; id: string }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addCookies([{ name: 'feed_session', value: b.cookie.slice('feed_session='.length), url: SERVER_URL }])
  const page = await context.newPage()
  try {
    await page.goto(`${SERVER_URL}/u/${a.username}`, { waitUntil: 'networkidle' })
    const card = page.locator('article').filter({ hasText: 'closure pending hold sync' }).first()

    // Wait for the initial load focus throttle window to clear (SWR default: 5s)
    await page.waitForTimeout(6000)

    // Set up controlled barrier on the like API call
    let releaseLikeResponse!: () => void
    const likeBarrier = new Promise<void>((r) => { releaseLikeResponse = r })
    let likeRequestStarted!: () => void
    const likeRequestStartedPromise = new Promise<void>((r) => { likeRequestStarted = r })

    await page.route(`**/api/posts/${post.shortCode}/like`, async (route) => {
      likeRequestStarted()
      await likeBarrier
      await route.continue()
    })

    const likeButton = card.getByRole('button', { name: /^(Like|Unlike)$/ })
    expect(await likeButton.getAttribute('aria-pressed')).toBe('false')

    // Click like: optimistic UI updates, request is physically held in flight (likePending = true)
    void likeButton.click()
    await likeRequestStartedPromise

    // While like is pending: another interaction (reply and bookmark from user a) commits on the server
    const replyCreated = await api('/api/posts', {
      method: 'POST',
      cookie: a.cookie,
      body: JSON.stringify({ content: 'concurrent reply from a', parentId: post.id }),
    })
    expect(replyCreated.status).toBe(201)
    expect((await api(`/api/posts/${post.shortCode}/bookmark`, { method: 'POST', cookie: a.cookie })).status).toBe(200)

    // Deliver fresh server props (replyCount=1, bookmarkCount=1) to PostActions while likePending is still true
    const propsRefetched = page.waitForResponse((r) => r.url().includes('/api/posts?') && r.status() === 200)
    await page.evaluate(() => {
      window.dispatchEvent(new FocusEvent('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await propsRefetched

    // Deterministically observe that new props have committed to the SAME component:
    // the reply count (rendered directly from post prop) updates to 1 in the DOM
    const replyLink = card.getByRole('link', { name: /Reply/ })
    await expect
      .poll(async () => Number(await replyLink.textContent().catch(() => '0')) || 0, { timeout: 10_000, interval: 200 })
      .toBe(1)

    // And verify the like button remains in pending/disabled state while the request is in flight
    expect(await likeButton.isDisabled()).toBe(true)

    // While like is pending, state convergence holds bookmark updates (still 0 in local state)
    expect(Number(await card.getByRole('button', { name: /Bookmark/ }).textContent().catch(() => '0')) || 0).toBe(0)

    // Set up listener for the write completion BEFORE releasing the barrier
    const likeResponsePromise = page.waitForResponse((r) => r.url().includes(`/api/posts/${post.shortCode}/like`) && r.status() === 200)

    // Release the like response
    releaseLikeResponse()
    await likeResponsePromise

    // Wait for the like button to recover from disabled state after settle
    await expect
      .poll(async () => await likeButton.isDisabled(), { timeout: 10_000, interval: 200 })
      .toBe(false)

    // Assert final settled state: like committed, likePending cleared, held bookmark prop merged
    expect(await likeButton.getAttribute('aria-pressed')).toBe('true')
    expect(Number(await card.getByRole('button', { name: /Unlike/ }).textContent().catch(() => '0')) || 0).toBe(1)
    expect(Number(await card.getByRole('button', { name: /Bookmark/ }).textContent().catch(() => '0')) || 0).toBe(1)
  } finally { await context.close() }
})

it('follow click converges and stays converged across the router refresh it triggers', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addCookies([{ name: 'feed_session', value: b.cookie.slice('feed_session='.length), url: SERVER_URL }])
  const page = await context.newPage()
  try {
    await page.goto(`${SERVER_URL}/u/${a.username}`, { waitUntil: 'networkidle' })
    // The profile HEADER follow button (main content, not sidebar/panel suggestions).
    const followResponses: { url: string; status: number }[] = []
    page.on('response', (r) => { if (r.url().includes('/follow')) followResponses.push({ url: r.url().replace(SERVER_URL, ''), status: r.status() }) })
    // Let hydration settle: networkidle can fire before React finishes
    // attaching handlers, and a click before that is silently dropped.
    await page.waitForTimeout(1000)
    const followButton = page.getByRole('button', { name: 'Follow', exact: true }).first()
    await followButton.click()

    // The optimistic click + POST + router.refresh() must leave the button
    // in the following state (any transient stale render must self-heal via
    // the props→state convergence) and the server relationship must exist.
    // hasText matches the DOM (the following-state button renders both label
    // spans; one is CSS-hidden at a time).
    await expect
      .poll(async () => await page.locator('button', { hasText: 'Following' }).count(), { timeout: 10_000, interval: 500 })
      .toBeGreaterThan(0)
    // Anchor on the server commit first (the POST's response can lag under
    // suite load); UI convergence is asserted afterwards.
    const aidRow = await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [a.username])
    const bidRow = await sql<{ id: string }>('SELECT id FROM "User" WHERE username=$1', [b.username])
    await expect
      .poll(async () => (await sql<{ n: number }>(
        'SELECT count(*)::int n FROM "Follow" WHERE "followerId"=$1 AND "followingId"=$2',
        [bidRow[0].id, aidRow[0].id],
      ))[0].n, { timeout: 15_000, interval: 500 })
      .toBe(1)
    // Settled end state (allows transient stale renders to self-heal).
    await page.waitForTimeout(1500)
    await expect
      .poll(async () => await page.locator('button', { hasText: 'Following' }).count(), { timeout: 10_000, interval: 500 })
      .toBeGreaterThan(0)
    // Clean up for other tests.
    await api(`/api/users/${a.username}/follow`, { method: 'DELETE', cookie: b.cookie })
  } finally { await context.close() }
})

// ── R3: sending must not skip unread incoming messages ──
// Controlled clock (Playwright clock fires the real 15s poll interval; no
// long sleeps). The send response carries the server identity of OUR
// message but must NOT advance the receive boundary past unread incoming
// messages — the next poll must deliver them.

it('sending own message does not skip an unread incoming message', async () => {
  // Fixture: a↔b conversation; make b verified so DM sending works.
  await sql('UPDATE "User" SET "verificationStatus"=\'verified\' WHERE id=$1', [bid])
  const convId = `browser_r3_${Date.now().toString(36)}`
  const [u1, u2] = [aid, bid].sort()
  await sql(`INSERT INTO "Conversation" (id,"user1Id","user2Id") VALUES ($1,$2,$3)`, [convId, u1, u2])
  await sql(`INSERT INTO "DirectMessage" (id,"conversationId","senderId","receiverId",content,"createdAt")
    VALUES ($1||\'_m0\', $1, $2, $3, 'browser r3 initial', now() - interval '2 hours')`, [convId, aid, bid])

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addCookies([{ name: 'feed_session', value: b.cookie.slice('feed_session='.length), url: SERVER_URL }])
  const page = await context.newPage()
  try {
    await page.clock.install()
    await page.goto(`${SERVER_URL}/messages/${convId}`, { waitUntil: 'networkidle' })
    await expect.poll(async () => await page.getByText('browser r3 initial').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))

    // Incoming message from A commits AFTER b's first sync, BEFORE b's send.
    await sql(`INSERT INTO "DirectMessage" (id,"conversationId","senderId","receiverId",content,"createdAt")
      VALUES ($1||\'_m1\', $1, $2, $3, 'browser r3 unseen incoming', now() - interval '1 second')`, [convId, aid, bid])

    // b sends their own message BEFORE any poll observes m1.
    await page.getByPlaceholder('Start a new message').fill('browser r3 my send')
    const sent = page.waitForResponse((r) => r.url().endsWith('/send') && r.request().method() === 'POST', { timeout: 15_000 })
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const sentBody = (await (await sent).json()) as { message: { id: string } }
    expect(sentBody.message.id).toBeTruthy()
    await expect.poll(async () => await page.getByText('browser r3 my send', { exact: true }).count()).toBe(1)

    // Advance the real 15s interval: the poll MUST deliver the unread m1.
    const poll = page.waitForResponse((r) => r.url().includes(`/api/messages/${convId}?`), { timeout: 15_000 })
    await page.clock.runFor(16_000)
    const pollBody = (await (await poll).json()) as { messages: { id: string }[] }
    expect(pollBody.messages.some((m) => m.id === `${convId}_m1`)).toBe(true)
    await expect.poll(async () => await page.getByText('browser r3 unseen incoming', { exact: true }).count(), { timeout: 10_000 }).toBe(1)

    // And m1 is marked read (it was actually returned to b).
    await expect
      .poll(async () => (await sql<{ n: number }>(
        'SELECT count(*)::int n FROM "DirectMessage" WHERE id=$1 AND "readAt" IS NULL', [`${convId}_m1`],
      ))[0].n, { timeout: 10_000 })
      .toBe(0)
  } finally {
    await context.close()
    await sql('DELETE FROM "DirectMessage" WHERE "conversationId"=$1', [convId])
    await sql('DELETE FROM "Conversation" WHERE id=$1', [convId])
    await sql('UPDATE "User" SET "verificationStatus"=\'unverified\' WHERE id=$1', [bid])
  }
}, 90_000)
// ── R7: MessageThread history HTTP error recovery ──────────────

for (const failureStatus of [429, 500] as const) {
  it(`message thread older-history paging recovers from ${failureStatus} HTTP failure on retry`, async () => {
    await sql('UPDATE "User" SET "verificationStatus"=\'verified\' WHERE id=$1', [bid])
    const convId = `browser_r7_${failureStatus}_${Date.now().toString(36)}`
    const [u1, u2] = [aid, bid].sort()
    await sql(`INSERT INTO "Conversation" (id,"user1Id","user2Id") VALUES ($1,$2,$3)`, [convId, u1, u2])

    // Seed 205 messages: SSR delivers the most recent 200 (m006..m205);
    // m001..m005 remain in older history
    await sql(`INSERT INTO "DirectMessage" (id,"conversationId","senderId","receiverId",content,"createdAt")
      SELECT $1||'_m'||lpad(i::text,3,'0'), $1, $2, $3, 'browser r7 msg '||lpad(i::text,3,'0'), '2026-01-01'::timestamp + i*interval '1 second'
      FROM generate_series(1, 205) i`, [convId, aid, bid])

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await context.addCookies([{ name: 'feed_session', value: b.cookie.slice('feed_session='.length), url: SERVER_URL }])
    const page = await context.newPage()

    try {
      const requestedUrls: string[] = []
      let attempts = 0
      await page.route(`**/api/messages/${convId}?*beforeTs*`, async (route) => {
        attempts++
        requestedUrls.push(route.request().url())
        if (attempts === 1) {
          if (failureStatus === 429) {
            await route.fulfill({
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': '1',
              },
              body: JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests.' } }),
            })
          } else {
            await route.fulfill({
              status: 500,
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ error: { code: 'internal_error', message: 'Internal Server Error' } }),
            })
          }
        } else {
          await route.continue()
        }
      })

      await page.goto(`${SERVER_URL}/messages/${convId}`, { waitUntil: 'networkidle' })
      await expect.poll(async () => await page.getByText('browser r7 msg 205').count()).toBeGreaterThan(0)
      // Oldest in the initial SSR batch is m006; m001 is not yet loaded
      expect(await page.getByText('browser r7 msg 001').count()).toBe(0)

      // Scroll to top: triggers loadOlderHistory which hits the error (429 or 500)
      const failedReq = page.waitForResponse((r) => r.url().includes('beforeTs=') && r.status() === failureStatus, { timeout: 10_000 })
      await page.evaluate(() => {
        const el = document.querySelector('div.overflow-y-auto')
        if (el) {
          el.scrollTop = 100
          el.scrollTop = 0
          el.dispatchEvent(new Event('scroll'))
        }
      })
      await failedReq

      // HTTP failure must NOT disable history paging permanently:
      // m001 is still not loaded yet, but retry state is preserved
      expect(await page.getByText('browser r7 msg 001').count()).toBe(0)
      expect(requestedUrls).toHaveLength(1)

      if (failureStatus === 429) {
        // Assert Retry-After cooling: scrolling during cooldown does not dispatch request
        await page.evaluate(() => {
          const el = document.querySelector('div.overflow-y-auto')
          if (el) {
            el.scrollTop = 100
            el.scrollTop = 0
            el.dispatchEvent(new Event('scroll'))
          }
        })
        await page.waitForTimeout(200)
        expect(requestedUrls).toHaveLength(1) // Still 1: cooldown prevented spamming

        // Wait for Retry-After cooldown (1s) to elapse
        await page.waitForTimeout(1100)
      }

      // Listen for the recovery response BEFORE triggering the retry scroll
      const successReq = page.waitForResponse((r) => r.url().includes('beforeTs=') && r.status() === 200, { timeout: 15_000 })

      // Trigger scroll again to recover
      await page.evaluate(() => {
        const el = document.querySelector('div.overflow-y-auto')
        if (el) {
          el.scrollTop = 100
          el.scrollTop = 0
          el.dispatchEvent(new Event('scroll'))
        }
      })
      await successReq

      // Assert that recovery request used the EXACT SAME original cursor parameters
      expect(requestedUrls.length).toBeGreaterThanOrEqual(2)
      const url1 = new URL(requestedUrls[0])
      const url2 = new URL(requestedUrls[1])
      expect(url1.searchParams.get('beforeTs')).toBeTruthy()
      expect(url1.searchParams.get('beforeId')).toBeTruthy()
      expect(url2.searchParams.get('beforeTs')).toBe(url1.searchParams.get('beforeTs'))
      expect(url2.searchParams.get('beforeId')).toBe(url1.searchParams.get('beforeId'))

      // Verify older messages are now prepended and visible
      await expect.poll(async () => await page.getByText('browser r7 msg 001').count(), { timeout: 10_000 }).toBe(1)
      await expect.poll(async () => await page.getByText('browser r7 msg 005').count(), { timeout: 10_000 }).toBe(1)
      // No duplicate m205
      expect(await page.getByText('browser r7 msg 205').count()).toBe(1)
    } finally {
      await context.close()
      await sql('DELETE FROM "DirectMessage" WHERE "conversationId"=$1', [convId])
      await sql('DELETE FROM "Conversation" WHERE id=$1', [convId])
      await sql('UPDATE "User" SET "verificationStatus"=\'unverified\' WHERE id=$1', [bid])
    }
  }, 90_000)
}
