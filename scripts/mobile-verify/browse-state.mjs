/**
 * Browse-state lifecycle verification — WebKit + Chromium against a
 * production build. Real-behavior regression harness for the
 * identity-owned browse cache (BrowseStateProvider): pages/cursors/
 * scroll restoration on back-navigation, tab isolation, publish and
 * interactions, identity switching, and CLS including pull-to-refresh.
 *
 * Usage: node scripts/mobile-verify/browse-state.mjs [--base https://127.0.0.1:8443]
 * Env:   none (test users below must exist in the target database)
 *
 * Database prerequisites (throwaway DB, migrated + SiteConfig row 1):
 *   - six authors ba1..ba6 with ~20 posts each (CAS 67-56-5 tagged),
 *     viewer bview following ba1..ba5 (NOT ba6 — keeps Latest and
 *     Following tops distinct),
 *   - all users share password "password-123", emails <name>@local.test.
 *   Serve the build behind scripts/mobile-verify/tls-proxy.mjs (WebKit
 *   requires TLS for the Secure session cookie).
 *
 * Checks: A detail→back restores pages/cursor/scroll with no refetch
 * storm · B Latest⇄Following switch + cache · C publish · D like ·
 * E in-place identity switch clears previous identity's state ·
 * F CLS (Chromium; pull-to-refresh included — layout-shift is
 * unavailable on this Playwright WebKit build).
 */

/**
 * Browse-state lifecycle verification — WebKit + Chromium against the
 * production build (cascool_browse_test).
 *
 * Scenarios:
 *  A. login → Latest, paginate to ≥4 pages → open post detail → browser
 *     back: pages/cursor restored, scroll restored, no page refetch storm.
 *  B. Latest ⇄ Following switch: distinct content, cached on return.
 *  C. Publish: new post appears at top of Latest.
 *  D. Interaction: like toggles state on a card.
 *  E. Identity switch (login as another user in-place): previous
 *     identity's pages/scroll must NOT leak (first page only, top scroll).
 *  F. CLS (Chromium only): load + pagination + pull-to-refresh gestures.
 */
import { chromium, webkit } from 'playwright'

const BASE = process.env.BASE ?? 'https://127.0.0.1:8443'
const VIEWER = { id: 'bview@local.test', password: 'password-123' }
const OTHER = { id: 'ba1@local.test', password: 'password-123' }

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function countCards(page) {
  return page.locator('main article').count()
}

async function cardLinks(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('main article a[aria-label="Open post"]')].map((a) =>
      a.getAttribute('href'),
    ),
  )
}

async function scrollToPages(page, minCards) {
  for (let i = 0; i < 60; i++) {
    const n = await countCards(page)
    if (n >= minCards) return n
    await page.evaluate(() => window.scrollBy(0, 1200))
    await page.waitForTimeout(450)
  }
  return countCards(page)
}

async function login(page, creds) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type="text"]', creds.id)
  await page.fill('input[type="password"]', creds.password)
  await page.click('button[type="submit"]')
  await page.waitForURL(`${BASE}/`, { timeout: 15000 })
  await page.waitForSelector('main article', { timeout: 15000 })
}

async function runEngine(engineName, engine) {
  console.log(`\n=== ${engineName} ===`)
  const browser = await engine.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()

  // CLS accumulation (layout-shift is Chromium-only; WebKit reports
  // unavailable — same caveat as docs/FEED-PERF.md).
  await page.addInitScript(() => {
    window.__cls = 0
    window.__shifts = []
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue
          window.__cls += e.value
          if (e.value > 0.01) window.__shifts.push(e.value)
        }
      })
      po.observe({ type: 'layout-shift', buffered: true })
    } catch {
      window.__cls = null
    }
  })

  const apiRequests = []
  page.on('request', (r) => {
    if (r.url().includes('/api/posts')) apiRequests.push(r.url())
  })

  // ── A. detail → back ──
  await login(page, VIEWER)
  await page.waitForTimeout(1200)

  // Hold the first Following page while the user switches tabs and leaves.
  // On back, Next may replay a Latest SSR tree at ?tab=following. That
  // snapshot must never be displayed or seeded under the Following key.
  const latestBeforeSwitch = (await cardLinks(page))[0]
  const pausedFollowing = []
  await page.route('**/api/posts?tab=following**', async (route) => {
    await new Promise((resolve) => { pausedFollowing.push(resolve) })
    // Leaving the route can cancel the original request while it is paused.
    // The back-navigation request is held separately by the same handler.
    await route.continue().catch((error) => {
      if (!String(error).includes('Route is already handled')) throw error
    })
  })
  await page.getByRole('button', { name: 'Following', exact: true }).click()
  await page.waitForTimeout(300)
  check('A0 pending Following shows no Latest cards', (await countCards(page)) === 0)
  await page.locator('nav.mobile-bottom-nav a[href="/explore"]').click()
  await page.waitForURL(/\/explore/)
  await page.goBack()
  await page.waitForURL(/tab=following/)
  check('A0b replayed SSR tree does not show Latest on Following', (await countCards(page)) === 0)
  if (pausedFollowing.length === 0) throw new Error('Following request was not intercepted')
  await page.unroute('**/api/posts?tab=following**')
  pausedFollowing.forEach((release) => release())
  await page.waitForFunction(() => document.querySelectorAll('main article').length >= 20)
  check('A0c Following resolves with its own first page', (await cardLinks(page))[0] !== latestBeforeSwitch)

  await page.waitForTimeout(1500)
  const n1 = await scrollToPages(page, 80)
  check('A1 paginated to ≥80 cards (4 pages)', n1 >= 80, `cards=${n1}`)

  // Pin an exact leave position; the detail target must already be in
  // view there, so Playwright's click does not auto-scroll past it.
  await page.evaluate(() => window.scrollTo(0, 6000))
  await page.waitForTimeout(600)
  const y1 = await page.evaluate(() => window.scrollY)
  const links1 = await cardLinks(page)
  check('A2 scrolled deep (position recorded)', y1 > 1500, `scrollY=${Math.round(y1)}`)

  apiRequests.length = 0
  // Click the card at the exact viewport center — Playwright will not
  // auto-scroll, so the recorded scrollY IS the leave position.
  const centerIdx = await page.evaluate(() => {
    const links = [...document.querySelectorAll('main article a[aria-label="Open post"]')]
    const mid = window.innerHeight / 2
    let best = 0
    let bd = Infinity
    links.forEach((a, i) => {
      const r = a.getBoundingClientRect()
      const d = Math.abs(r.top + r.height / 2 - mid)
      if (d < bd) { bd = d; best = i }
    })
    return best
  })
  await page.locator('main article a[aria-label="Open post"]').nth(centerIdx).click()
  await page.waitForURL(/\/p\//, { timeout: 15000 })
  const detailOk = await page.locator('main article').first().isVisible()
  check('A3 post detail opened', detailOk)

  await page.goBack()
  await page.waitForSelector('main article', { timeout: 15000 })
  await page.waitForTimeout(1500)
  const n2 = await countCards(page)
  const y2 = await page.evaluate(() => window.scrollY)
  const links2 = await cardLinks(page)
  check('A4 pages restored after back (no first-page-only)', n2 >= n1, `cards=${n2}/${n1}`)
  const sameSeq = JSON.stringify(links1.slice(0, n1 - 5)) === JSON.stringify(links2.slice(0, n1 - 5))
  check('A5 cursor chain identical (same posts, same order)', sameSeq, `${links2.length} links`)
  check('A6 scroll position restored', Math.abs(y2 - y1) <= 120, `scrollY=${Math.round(y2)} vs ${Math.round(y1)}`)

  const postReqs = apiRequests.filter((u) => u.includes('/api/posts'))
  const pageReqs = postReqs.filter((u) => u.includes('tab=') && !u.includes('since') && !u.includes('repliesOf'))
  check('A7 no page-refetch storm on back (≤2 list requests)', pageReqs.length <= 2, `${pageReqs.length} requests`)

  // ── B. tab switch (currently on Following from flow A) ──
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.waitForTimeout(1200)
  const latestFirst = (await cardLinks(page))[0]
  await page.getByRole('button', { name: 'Following', exact: true }).click()
  await page.waitForTimeout(1500)
  const followingCards = await countCards(page)
  const followingTop = (await cardLinks(page))[0]
  check('B1 Following tab shows its own feed', followingCards >= 20, `cards=${followingCards}`)
  console.log(`    [dbg] latestFirst=${latestFirst} followingTop=${followingTop}`)
  check('B1b tabs have distinct content', latestFirst !== followingTop)

  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.waitForTimeout(1200)
  const latestCards = await countCards(page)
  const latestTop = (await cardLinks(page))[0]
  check('B2 Latest tab renders', latestCards >= 20, `cards=${latestCards}`)

  await page.getByRole('button', { name: 'Following', exact: true }).click()
  await page.waitForTimeout(800)
  const followingTop2 = (await cardLinks(page))[0]
  console.log(`    [dbg] followingTop2=${followingTop2} latestTop=${latestTop}`)
  check('B3 Following cached on return', followingTop2 === followingTop && latestTop !== followingTop)

  // ── C. publish (currently on Following; switch to Latest) ──
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.waitForTimeout(800)
  const marker = `fresh post ${Date.now().toString(36)}`
  await page.fill('main textarea', marker)
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  await page.waitForTimeout(1500)
  const firstCardText = await page.locator('main article').first().innerText()
  console.log(`    [dbg] marker=${marker} first=${firstCardText.slice(0, 60).replaceAll('\n', ' ')}`)
  check('C1 published post appears at top of Latest', firstCardText.includes(marker))

  // ── D. like ──
  const likeBtn = page.locator('main article [aria-label="Like"]').first()
  await likeBtn.click()
  await page.waitForTimeout(900)
  const pressed = await page
    .locator('main article [aria-label="Unlike"], main article [aria-label="Like"]')
    .first()
    .getAttribute('aria-pressed')
  check('D1 like toggled', pressed === 'true', `aria-pressed=${pressed}`)

  // ── E. identity switch (in-place login as another user) ──
  apiRequests.length = 0
  // End the viewer session the way the app does (clears client identity),
  // then sign in as another user IN PLACE — same Providers instance, so
  // the identityKey change must remount and clear the browse state.
  await page.request.post(`${BASE}/api/auth/logout`)
  await login(page, OTHER)
  await page.waitForTimeout(1500)
  const afterSwitchCards = await countCards(page)
  const yAfterSwitch = await page.evaluate(() => window.scrollY)
  check(
    'E1 identity switch cleared previous identity’s pages',
    afterSwitchCards <= 21 && yAfterSwitch < 400,
    `cards=${afterSwitchCards} scrollY=${Math.round(yAfterSwitch)}`,
  )

  // ── F. CLS ──
  const cls = await page.evaluate(() => window.__cls)
  if (cls == null) {
    console.log('  NOTE layout-shift unavailable on this engine (as documented)')
  } else {
    check('F1 CLS load+paginate+tabs+publish ≈ 0', cls < 0.02, `CLS=${cls.toFixed(4)}`)
  }

  await browser.close()
  return { engineName }
}

async function runPullCLS() {
  console.log('\n=== Chromium: pull-to-refresh CLS ===')
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__cls = 0
    window.__shifts = []
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue
          window.__cls += e.value
          if (e.value > 0.01) window.__shifts.push({ v: e.value, src: e.sources?.[0]?.node?.nodeName })
        }
      })
      po.observe({ type: 'layout-shift', buffered: true })
    } catch {
      window.__cls = null
    }
  })
  await login(page, VIEWER)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(800)

  const refreshReqs = []
  page.on('request', (r) => { if (r.url().includes('since=') && r.url().includes('take=50')) refreshReqs.push(r.url()) })
  const cdp = await context.newCDPSession(page)
  const touch = async (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    })
  await touch('touchStart', 195, 300)
  for (let y = 310; y <= 520; y += 10) await touch('touchMove', 195, y)
  await touch('touchEnd', 195, 520)
  await page.waitForTimeout(2500)

  const cls = await page.evaluate(() => window.__cls)
  const shifts = await page.evaluate(() => window.__shifts)
  check('F2 pull-to-refresh CLS ≈ 0 (was 0.061)', cls < 0.01, `CLS=${cls?.toFixed(4)}`)
  check('F3 pull gesture actually refreshed (since&take=50 fired)', refreshReqs.length >= 1, `${refreshReqs.length} refresh fetch`)
  console.log(`    shift entries >0.01: ${JSON.stringify(shifts)}`)
  await browser.close()
}

await runEngine('WebKit', webkit).catch((e) => {
  check('WebKit engine run completed', false, String(e).slice(0, 200))
})
await runEngine('Chromium', chromium).catch((e) => {
  check('Chromium engine run completed', false, String(e).slice(0, 200))
})
await runPullCLS().catch((e) => check('pull CLS run completed', false, String(e).slice(0, 200)))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
