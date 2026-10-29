/**
 * Mobile feed verification on real browser ENGINES — Playwright WebKit
 * (Safari's engine) and Chromium (Chrome's engine), mobile device
 * descriptors with touch. The iOS-Simulator Safari leg of this batch was
 * blocked by the host's "Allow remote automation" gate (needs interactive
 * authorization) — recorded as a limitation; engine-level verification is
 * what this harness provides instead.
 *
 * Usage: node scripts/mobile-verify/engines.mjs [--base http://127.0.0.1:3201]
 * Env:   LOGIN_CREDS="identifier<TAB>password"  (pre-registered, verified)
 *
 * Phases per engine: home load (FCP/CLS/requests) · scroll pagination ·
 * detail→back (SWR cache focus) · CAS page · profile tabs · login ·
 * following tab ⇄ latest · compose · like · new-posts banner ·
 * pull-to-refresh touch gesture (chromium via CDP, webkit best-effort).
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { chromium, webkit, devices } from 'playwright'

const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > -1 ? process.argv[i + 1] : 'http://127.0.0.1:3201'
})()

const DEVICE = devices['iPhone 13'] // 390×844, touch, isMobile

// Injected BEFORE any page script on every navigation: fetch hook +
// paint/shift/LCP observers with buffered entries.
const INIT = `(() => {
  const supported = PerformanceObserver.supportedEntryTypes || []
  const hasLayoutShift = supported.includes('layout-shift')
  const hasLongTask = supported.includes('longtask')
  window.__ev = {
    fetches: [], cls: hasLayoutShift ? 0 : null, shifts: [], lcp: null, fcp: null,
    longTasks: hasLongTask ? 0 : null,
    supported: { layoutShift: hasLayoutShift, longTask: hasLongTask },
  }
  const origFetch = window.fetch
  window.fetch = function(...args) {
    const url = String(args[0])
    window.__ev.fetches.push({ t: Math.round(performance.now()), url: url.replace(location.origin, '').slice(0, 110) })
    return origFetch.apply(this, args)
  }
  if (hasLayoutShift) try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__ev.cls += e.value; window.__ev.shifts.push({ t: Math.round(e.startTime), v: Math.round(e.value * 1000) / 1000 }) } }).observe({ type: 'layout-shift', buffered: true }) } catch (e) { window.__ev.cls = null; window.__ev.supported.layoutShift = false }
  try { new PerformanceObserver(l => { const es = l.getEntries(); if (es.length) window.__ev.lcp = { t: Math.round(es[es.length - 1].startTime), size: es[es.length - 1].size, tag: es[es.length - 1].element ? es[es.length - 1].element.tagName : null } }).observe({ type: 'largest-contentful-paint', buffered: true }) } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__ev.fcp = Math.round(e.startTime) }).observe({ type: 'paint', buffered: true }) } catch (e) {}
  if (hasLongTask) try { new PerformanceObserver(l => { window.__ev.longTasks += l.getEntries().length }).observe({ type: 'longtask', buffered: true }) } catch (e) { window.__ev.longTasks = null; window.__ev.supported.longTask = false }
})()`

const COLLECT = `(() => {
  const cursorFetches = window.__ev.fetches.filter(f => /cursor=/.test(f.url))
  return {
    path: location.pathname + location.search,
    articles: document.querySelectorAll('article').length,
    apiCount: window.__ev.fetches.filter(f => f.url.includes('/api/')).length,
    lastApi: (window.__ev.fetches.filter(f => f.url.includes('/api/')).slice(-3).map(f => f.url.slice(0, 80))),
    cursorCalls: cursorFetches.length,
    lastCursor: cursorFetches.length ? decodeURIComponent((cursorFetches[cursorFetches.length - 1].url.match(/cursor=([^&]+)/) || [])[1] || '').slice(0, 50) : null,
    cls: window.__ev.cls === null ? null : Math.round(window.__ev.cls * 1000) / 1000,
    shifts: window.__ev.shifts.length,
    fcp: window.__ev.fcp, lcp: window.__ev.lcp, longTasks: window.__ev.longTasks,
    supported: window.__ev.supported,
    scrollY: Math.round(window.scrollY),
    netRequests: performance.getEntriesByType('resource').length,
    jsKB: Math.round(performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script').reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
  }
})()`

function log(engine, ...a) {
  console.log(`[${engine}]`, ...a)
}

async function collect(page) {
  return page.evaluate(COLLECT)
}

async function runEngine(name, browserType, evidence) {
  const browser = await browserType.launch()
  // ignoreHTTPSErrors: the verification base is a local self-signed TLS
  // proxy (production builds mark the session cookie Secure, which browsers
  // refuse over plain http://127.0.0.1 — real deployments sit behind TLS).
  const context = await browser.newContext({
    ...DEVICE,
    locale: 'en-US',
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  await page.addInitScript(INIT)
  evidence[name].ua = await page.evaluate(() => navigator.userAgent).catch(() => null)
  const phase = async (label) => {
    const s = await collect(page)
    evidence[name].phases[label] = s
    log(name, label, JSON.stringify(s))
    return s
  }

  // ── home load ──
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await phase('home-load')

  // ── scroll pagination: 4 scrolls to bottom (mobile WebKit has no
  //    mouse.wheel; IntersectionObserver is layout-driven, so programmatic
  //    scrollTo exercises the same pagination path a touch scroll does) ──
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })`)
    await page.waitForTimeout(1300)
  }
  await phase('home-scrolled')

  // ── detail → back (SWR cache focus) ──
  const beforeBack = await page.evaluate(`window.__ev.fetches.length`)
  const scrollBefore = await page.evaluate(`Math.round(window.scrollY)`)
  await page.locator('article a[href^="/p/"]').first().click()
  await page.waitForURL('**/p/**', { timeout: 8000 })
  await page.waitForTimeout(1800)
  await phase('detail')
  await page.goBack()
  await page.waitForTimeout(2800)
  const back = await phase('back-from-detail')
  assert.equal(back.path, '/', `${name}: browser Back must return to the home URL`)
  assert.ok(back.articles >= 20, `${name}: browser Back must render the feed tree, not the detail tree`)
  evidence[name].phases['back-from-detail'].newRequestsDuringBack =
    await page.evaluate(`window.__ev.fetches.length`) - beforeBack
  evidence[name].phases['back-from-detail'].scrollYBeforeDetail = scrollBefore

  // ── CAS page (a CAS number that exists in the perf seed, 124 posts) ──
  await page.goto(`${BASE}/cas/3695000-30-8`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2800)
  await phase('cas-load')
  await page.evaluate(`window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })`)
  await page.waitForTimeout(1500)
  await page.evaluate(`window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })`)
  await page.waitForTimeout(1500)
  await phase('cas-scrolled')

  // ── profile page + tab switch (tabs are Links; u014656 has 20+ posts) ──
  await page.goto(`${BASE}/u/u014656`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2800)
  await phase('profile-load')
  await page.getByRole('link', { name: 'Replies' }).click()
  await page.waitForTimeout(2200)
  await phase('profile-replies-tab')

  // ── login via real form ──
  const [identifier, password] = (process.env.LOGIN_CREDS || '').split('\t')
  if (!identifier) throw new Error('LOGIN_CREDS env required')
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.locator('input').first().fill(identifier)
  await page.locator('input[type=password], input').nth(1).fill(password)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(`${BASE}/`, { timeout: 10000 })
  await page.waitForTimeout(2500)
  await phase('after-login')

  // ── following tab ⇄ latest ──
  await page.getByRole('button', { name: 'Following', exact: true }).click()
  await page.waitForTimeout(2300)
  await phase('following-tab')
  const fetchAtSwitch = await page.evaluate(`window.__ev.fetches.length`)
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.waitForTimeout(2300)
  await phase('latest-tab-back')
  evidence[name].phases['latest-tab-back'].newRequestsOnSwitchBack =
    await page.evaluate(`window.__ev.fetches.length`) - fetchAtSwitch

  // ── compose ──
  const composeText = `engine verify ${name} ${Date.now().toString(36)}`
  await page.locator('textarea').first().fill(composeText)
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Post', exact: true }).first().click()
  await page.waitForTimeout(2300)
  await phase('after-compose')
  evidence[name].phases['after-compose'].firstArticleHasIt = await page
    .locator('article').first().textContent().then((t) => t.includes(composeText))

  // ── like ──
  const likeBtn = page.locator('button[aria-label="Like"], button[aria-label="Unlike"]').first()
  const pressedBefore = await likeBtn.getAttribute('aria-pressed')
  await likeBtn.click()
  await page.waitForTimeout(1400)
  await phase('after-like')
  evidence[name].phases['after-like'].pressedBefore = pressedBefore

  // ── pull-to-refresh touch gesture ──
  if (name === 'chromium') {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 250 }] })
    for (let d = 40; d <= 180; d += 20) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 250 + d }] })
      await page.waitForTimeout(30)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(2000)
    await phase('pull-to-refresh-gesture')
    evidence[name].phases['pull-to-refresh-gesture'].mechanism = 'CDP raw touch events'
  }

  // ── new-posts banner: another account posts via API, ≤60 s poll shows it ──
  const bannerTrigger = await page.evaluate(`fetch('/api/posts', { method: 'POST',
      headers: { Authorization: 'Bearer ' + ('${process.env.BANNER_KEY || 'perf_key_latest_fixed'}'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'banner trigger post 7732-18-5' }) }).then(r => r.status)`)
  log(name, 'banner trigger post ->', bannerTrigger)
  const banner = await page
    .getByRole('button', { name: /new posts/i })
    .waitFor({ timeout: 70000 })
    .then(() => 'banner-visible')
    .catch(() => 'banner-not-seen')
  evidence[name].phases['banner'] = { banner, triggerStatus: bannerTrigger }
  log(name, 'banner', banner)
  if (banner === 'banner-visible') {
    await page.getByRole('button', { name: /new posts/i }).click()
    await page.waitForTimeout(2000)
    await phase('after-banner-click')
  }

  await browser.close()
}

async function main() {
  const evidence = {
    base: BASE,
    note: 'iOS-Simulator Safari blocked by host Safari remote-automation gate; engines verified via Playwright WebKit (Safari engine) and Chromium (Chrome engine), iPhone 13 descriptor (touch, 390x844)',
    webkit: { ua: null, phases: {} },
    chromium: { ua: null, phases: {} },
  }

  await runEngine('webkit', webkit, evidence)
  await runEngine('chromium', chromium, evidence)

  writeFileSync('/tmp/engines-evidence.json', JSON.stringify(evidence, null, 2))
  console.log('[done] evidence → /tmp/engines-evidence.json')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
