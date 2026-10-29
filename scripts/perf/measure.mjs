/**
 * Feed performance measurement — sequential HTTP against a production
 * `next start` server, Twitter-mobile-style (one request at a time).
 *
 * Usage:
 *   node scripts/perf/measure.mjs --base http://127.0.0.1:3201 \
 *        --pid <server-pid> [--n 120] [--warmup 10] [--out results.json]
 *
 * Env: DATABASE_URL for the seeded _perf database, plus KEY_LATEST,
 * KEY_FOLLOWING, KEY_FORYOU, KEY_DETAIL, KEY_EXTRA1 and KEY_WARM (printed by
 * the seed script).
 *
 * Reports per scenario: p50/p95/mean/min/max latency, average response
 * bytes, status counts, and the server process RSS range during the run.
 */

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { Client } from 'pg'

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : dflt
}

const BASE = arg('base', 'http://127.0.0.1:3201')
const SERVER_PID = Number(arg('pid', '0'))
const N = Number(arg('n', '120'))
const WARMUP = Number(arg('warmup', '10'))
const OUT = arg('out', '')
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_perf')) {
  throw new Error('DATABASE_URL must point to the seeded _perf database.')
}
for (const name of ['KEY_LATEST', 'KEY_FOLLOWING', 'KEY_FORYOU', 'KEY_DETAIL', 'KEY_EXTRA1', 'KEY_WARM']) {
  if (!process.env[name]) throw new Error(`${name} is required for a valid measurement.`)
}

async function pickDetailCode() {
  const c = new Client({ connectionString: DATABASE_URL })
  await c.connect()
  try {
    const r = await c.query(
      `SELECT "shortCode" FROM "Post" WHERE "deletedAt" IS NULL AND "parentId" IS NULL
       ORDER BY "createdAt" DESC OFFSET 25 LIMIT 1`,
    )
    return r.rows[0].shortCode
  } finally {
    await c.end()
  }
}

function rss() {
  if (!SERVER_PID) return 0
  try {
    return Number(execSync(`ps -o rss= -p ${SERVER_PID}`).toString().trim())
  } catch {
    return 0
  }
}

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b)
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  return { p50: pct(50), p95: pct(95), mean, min: s[0], max: s[s.length - 1] }
}

async function run() {
  const detailCode = await pickDetailCode()
  // Every keyed scenario gets its OWN ApiKey (= its own 120/min rate bucket);
  // anonymous callers share the single IP bucket, so at most one anonymous
  // scenario per run.
  const scenarios = [
    { name: 'latest-key', path: '/api/posts?tab=latest', bearer: process.env.KEY_LATEST },
    { name: 'latest-page2-key', path: null, bearer: process.env.KEY_EXTRA1, derive: 'latest-key' },
    { name: 'following-key', path: '/api/posts?tab=following', bearer: process.env.KEY_FOLLOWING },
    { name: 'foryou-key', path: '/api/posts?tab=foryou', bearer: process.env.KEY_FORYOU },
    { name: 'detail-key', path: `/api/posts/${detailCode}`, bearer: process.env.KEY_DETAIL },
    { name: 'foryou-anon', path: '/api/posts?tab=foryou', bearer: null },
  ]

  const rssSamples = []
  const results = { base: BASE, n: N, warmup: WARMUP, scenarios: {} }
  let latestNextCursor = null

  for (const sc of scenarios) {
    let path = sc.path
    if (sc.derive === 'latest-key') {
      path = `/api/posts?tab=latest&cursor=${encodeURIComponent(latestNextCursor)}`
    }

    // Anonymous scenario runs last with a reduced N to stay inside the
    // shared 120/min IP bucket.
    const n = sc.bearer ? N : Math.min(N, 80)

    // Warmup (also primes any per-process caches; not timed). Uses a
    // dedicated warmup key so the measured key's rate bucket stays untouched.
    for (let i = 0; i < WARMUP; i++) {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${process.env.KEY_WARM}` },
      })
      const text = await res.text()
      if (sc.name === 'latest-key' && i === 0) {
        latestNextCursor = JSON.parse(text).nextCursor
      }
      if (!res.ok) throw new Error(`warmup ${sc.name} -> ${res.status}`)
    }

    const times = []
    const statuses = {}
    let bytesTotal = 0
    for (let i = 0; i < n; i++) {
      rssSamples.push(rss())
      const t0 = performance.now()
      const res = await fetch(`${BASE}${path}`, {
        headers: sc.bearer ? { Authorization: `Bearer ${sc.bearer}` } : {},
      })
      const body = await res.arrayBuffer()
      const t1 = performance.now()
      times.push(t1 - t0)
      bytesTotal += body.byteLength
      statuses[res.status] = (statuses[res.status] ?? 0) + 1
    }

    results.scenarios[sc.name] = {
      path,
      n,
      ...stats(times.map((t) => Math.round(t * 10) / 10)),
      bytesAvg: Math.round(bytesTotal / n),
      statuses,
    }
    console.log(
      `[perf] ${sc.name.padEnd(18)} p50=${results.scenarios[sc.name].p50}ms ` +
        `p95=${results.scenarios[sc.name].p95}ms max=${results.scenarios[sc.name].max}ms ` +
        `bytes=${results.scenarios[sc.name].bytesAvg} statuses=${JSON.stringify(statuses)}`,
    )
  }

  const rssVals = rssSamples.filter((v) => v > 0)
  if (rssVals.length) {
    results.rssKb = { min: Math.min(...rssVals), max: Math.max(...rssVals) }
    console.log(`[perf] server RSS ${Math.round(results.rssKb.min / 1024)}–${Math.round(results.rssKb.max / 1024)} MB over ${rssVals.length} samples`)
  }

  if (OUT) {
    writeFileSync(OUT, JSON.stringify(results, null, 2))
    console.log(`[perf] wrote ${OUT}`)
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
