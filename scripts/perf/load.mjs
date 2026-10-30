/**
 * Concurrent load harness for the closure capacity evidence (R9 rewrite).
 *
 * Usage: node scripts/perf/load.mjs <port> <dbName>
 *
 * Corrections vs the first submission (documented in the closure report):
 *  - Invariant failures FAIL the run (exit 1) instead of printing and exit 0.
 *  - Per-operation counters: like / unlike / create / notify-read / feed
 *    reads / detail reads / retries are counted separately — a "200" is no
 *    longer conflated into "writes".
 *  - REAL like→unlike round-trips (each unlike issued only after its like
 *    succeeded) and a REAL retry scenario execute.
 *  - Network errors (status 0 / fetch throw) and 5xx are counted and
 *    reported separately, plus an overall failure rate.
 *  - Latency measured to FIRST BYTE and to FULL BODY separately.
 *  - pg_stat_activity waiting sessions are sampled CONTINUOUSLY during
 *    each phase (database-side wait events), separately from lock waits.
 *    The Node-side pg pool queue of the SERVER process is not externally
 *    observable — that boundary is declared, not claimed.
 *  - Invariant baselines are read from the database before the run (the
 *    original run hardcoded baseline Like rows as 0 — the sampling flaw
 *    behind the first "hotLikeDeltaPreserved:false" evidence; see the
 *    report's R9 section for the full diagnosis).
 *  - Synthetic identity disclosure: identities × keys are inserted
 *    directly for the experiment; keys per user EXCEED the product's
 *    key-creation limit (5) — this is a rate-bucket fan-out for a
 *    throughput experiment, NOT a user-capacity projection.
 *
 * Honest scope: single machine, localhost (no network hop), warm cache,
 * fixed data distribution — evidence for THIS build on THIS box.
 */

import { performance } from 'node:perf_hooks'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { counterDeltaPreserved } from './metrics.mjs'

const PORT = process.argv[2] ?? '3193'
const DB_NAME = process.argv[3] ?? 'cascool_closure_perf'
if (!/^[a-z][a-z0-9_]*_perf$/.test(DB_NAME) || DB_NAME.length > 63) {
  throw new Error('Load database name must end in _perf.')
}
if (!/^\d{1,5}$/.test(PORT) || Number(PORT) < 1 || Number(PORT) > 65535) {
  throw new Error('Load server port must be between 1 and 65535.')
}
const BASE = `http://127.0.0.1:${PORT}`

const { Client } = pg
const pgUrl = new URL(process.env.DATABASE_URL_TEST ?? `postgresql://cascool:cascool@localhost:5432/${DB_NAME}`)
pgUrl.pathname = `/${DB_NAME}`

const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 24)
const DURATION_MS = Number(process.env.LOAD_DURATION_MS ?? 30_000)
const IDENTITIES = Number(process.env.LOAD_IDENTITIES ?? 100)
const KEYS_PER_IDENTITY = Number(process.env.LOAD_KEYS_PER_IDENTITY ?? 8)

const opStats = () => ({
  like: { n: 0, ok: 0, net: 0, s5xx: 0, s4xx: 0, ttfb: [], body: [] },
  unlike: { n: 0, ok: 0, net: 0, s5xx: 0, s4xx: 0, ttfb: [], body: [] },
  create: { n: 0, ok: 0, net: 0, s5xx: 0, s4xx: 0, ttfb: [], body: [] },
  notifyRead: { n: 0, ok: 0, net: 0, s5xx: 0, s4xx: 0, ttfb: [], body: [] },
  feedRead: { n: 0, ok: 0, net: 0, s5xx: 0, s4xx: 0, ttfb: [], body: [] },
  detailRead: { n: 0, ok: 0, net: 0, s5xx: 0, s4xx: 0, ttfb: [], body: [] },
  retry: { n: 0, ok: 0, net: 0, s5xx: 0, s4xx: 0, ttfb: [], body: [] },
})
let ops = opStats()

function record(op, status, ttfbMs, bodyMs) {
  const s = ops[op]
  s.n++
  s.ttfb.push(ttfbMs)
  s.body.push(bodyMs)
  if (status === 0) s.net++
  else if (status >= 500) s.s5xx++
  else if (status >= 400) s.s4xx++
  else s.ok++
}

let stop = false

async function timedFetch(op, path, init) {
  const t0 = performance.now()
  try {
    const res = await fetch(`${BASE}${path}`, init)
    const ttfb = performance.now() - t0
    await res.arrayBuffer().catch(() => {})
    record(op, res.status, ttfb, performance.now() - t0)
    return res.status
  } catch {
    const now = performance.now() - t0
    record(op, 0, now, now)
    return 0
  }
}

const keyFor = (identityIdx, seq) => `load_key_${identityIdx}_${seq}_perf_runner_20261030`

async function serverStats() {
  const out = execSync(`ps -o rss=,pcpu= -p $(lsof -ti tcp:${PORT} -sTCP:LISTEN | head -1)`).toString().trim()
  const [rssKb, cpu] = out.split(/\s+/)
  return { rssMb: (Number(rssKb) / 1024).toFixed(1), cpu }
}

async function sampleDbWaits(client, sink) {
  while (!stop) {
    try {
      const r = await client.query(
        `SELECT count(*) FILTER (WHERE wait_event IS NOT NULL AND state='active') AS waiting,
                count(*) FILTER (WHERE wait_event_type='Lock') AS lock_waiting
         FROM pg_stat_activity WHERE datname=$1`, [DB_NAME])
      sink.push({ t: Date.now(), waiting: Number(r.rows[0].waiting), lockWaiting: Number(r.rows[0].lock_waiting) })
    } catch { /* sampling must never break the load */ }
    await new Promise((r) => setTimeout(r, 500))
  }
}

function percentile(arr, p) {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function phaseReport(name, elapsedSec, samples) {
  console.log(`[${name}] concurrency=${CONCURRENCY} duration=${elapsedSec.toFixed(1)}s`)
  const waitingPeak = Math.max(0, ...samples.map((s) => s.waiting))
  const lockPeak = Math.max(0, ...samples.map((s) => s.lockWaiting))
  console.log(`  db-wait sampling: peak active-waiting=${waitingPeak} peak lock-waiting=${lockPeak} (samples=${samples.length}; Node-side server pool queue NOT externally observable - declared boundary)`)
  let totalReq = 0, totalOk = 0, totalNet = 0, total5xx = 0, total4xx = 0
  for (const [op, s] of Object.entries(ops)) {
    if (s.n === 0) continue
    totalReq += s.n; totalOk += s.ok; totalNet += s.net; total5xx += s.s5xx; total4xx += s.s4xx
    console.log(`  ${op.padEnd(11)} n=${String(s.n).padStart(6)} ok=${String(s.ok).padStart(6)} 4xx=${String(s.s4xx).padStart(5)} 5xx=${String(s.s5xx).padStart(3)} net=${String(s.net).padStart(3)} ` +
      `ttfb p50=${percentile(s.ttfb, 0.5).toFixed(0)} p95=${percentile(s.ttfb, 0.95).toFixed(0)} p99=${percentile(s.ttfb, 0.99).toFixed(0)} ` +
      `body p50=${percentile(s.body, 0.5).toFixed(0)} p95=${percentile(s.body, 0.95).toFixed(0)} p99=${percentile(s.body, 0.99).toFixed(0)}`)
  }
  const failRate = totalReq ? (((totalNet + total5xx) / totalReq) * 100).toFixed(3) : '0'
  console.log(`  throughput=${(totalReq / elapsedSec).toFixed(1)} req/s | failure rate (net+5xx)=${failRate}% of ${totalReq}`)
  return { name, totalReq, totalOk, totalNet, total5xx, total4xx, throughput: totalReq / elapsedSec }
}

async function runPhase(client, name, workerTask) {
  ops = opStats()
  stop = false
  const samples = []
  const sampler = sampleDbWaits(client, samples)
  const started = performance.now()
  const cutoff = setTimeout(() => { stop = true }, DURATION_MS)
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => (async () => {
    let seq = 0
    while (!stop) await workerTask(i, seq++)
  })()))
  clearTimeout(cutoff)
  stop = true
  await sampler
  return phaseReport(name, (performance.now() - started) / 1000, samples)
}

async function main() {
  const client = new Client({ connectionString: pgUrl.toString() })
  await client.connect()

  const hot = await client.query(`SELECT id, "shortCode", "likeCount" FROM "Post" WHERE "deletedAt" IS NULL AND "parentId" IS NULL ORDER BY "likeCount" DESC LIMIT 1`)
  const hotPost = hot.rows[0]
  console.log(`hot post: ${hotPost.shortCode}`)

  for (let i = 0; i < IDENTITIES; i++) {
    const uid = `perf-writer-${i}`
    await client.query(`
      INSERT INTO "User" (id, email, username, "passwordHash", role, "verificationStatus", "verifiedAt", status, "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 'x', 'user', 'verified', now() - interval '10 days', 'active', now(), now())
      ON CONFLICT (id) DO NOTHING`, [uid, `${uid}@perf.local`, `loadw${i}x`])
    for (let k = 0; k < KEYS_PER_IDENTITY; k++) {
      const raw = keyFor(i, k)
      const hash = createHash('sha256').update(raw).digest('hex')
      await client.query(`
        INSERT INTO "ApiKey" (id, "userId", name, "keyHash", prefix, "createdAt")
        VALUES ($1, $2, 'load', $3, $4, now())
        ON CONFLICT ("keyHash") DO NOTHING`, [`k-load-${i}-${k}`, uid, hash, raw.slice(0, 12)])
    }
  }
  const keyOf = (workerIdx, seq) => {
    const identity = (workerIdx * 7 + seq * 13) % IDENTITIES
    const key = (workerIdx * 3 + seq * 5) % KEYS_PER_IDENTITY
    return keyFor(identity, key)
  }
  const auth = (raw) => ({ Authorization: `Bearer ${raw}` })
  const authJson = (raw) => ({ ...auth(raw), 'Content-Type': 'application/json' })

  // Baseline invariants BEFORE any load (read from the database).
  const baseline = {
    likeCount: Number(hotPost.likeCount),
    likeRows: Number((await client.query('SELECT count(*)::int AS n FROM "Like" WHERE "postId"=$1', [hotPost.id])).rows[0].n),
    postRows: Number((await client.query('SELECT count(*)::int AS n FROM "Post"')).rows[0].n),
    userPostCountSum: Number((await client.query('SELECT coalesce(sum("postCount"),0)::int AS n FROM "User"')).rows[0].n),
  }
  baseline.likeDelta = baseline.likeCount - baseline.likeRows
  console.log('baseline:', JSON.stringify(baseline))
  console.log('server before:', JSON.stringify(await serverStats()))

  const results = []

  results.push(await runPhase(client, 'reads', async (w, seq) => {
    const key = keyOf(w, seq)
    if (seq % 2 === 0) await timedFetch('feedRead', '/api/posts?tab=latest&take=20', { headers: auth(key) })
    else await timedFetch('detailRead', `/api/posts/${hotPost.shortCode}`, { headers: auth(key) })
  }))

  let roundTrips = 0
  results.push(await runPhase(client, 'write-mixed', async (w, seq) => {
    const branch = seq % 3
    const key = keyOf(w, seq)
    if (branch === 0) {
      const like = await timedFetch('like', `/api/posts/${hotPost.shortCode}/like`, { method: 'POST', headers: auth(key) })
      if (like === 200) {
        roundTrips++
        await timedFetch('unlike', `/api/posts/${hotPost.shortCode}/like`, { method: 'DELETE', headers: auth(key) })
      }
    } else if (branch === 1) {
      await timedFetch('create', '/api/posts', { method: 'POST', headers: authJson(key), body: JSON.stringify({ content: `load write ${Date.now()}-${w}-${seq}` }) })
    } else {
      await timedFetch('notifyRead', '/api/notifications', { headers: auth(key) })
    }
  }))
  console.log(`  like->unlike round-trips completed: ${roundTrips}`)

  results.push(await runPhase(client, 'read-retry', async (w, seq) => {
    const key = keyOf(w, seq)
    const s = await timedFetch('feedRead', '/api/posts?tab=latest&take=5', { headers: auth(key) })
    if (s !== 200 || seq % 8 === 0) {
      await timedFetch('retry', '/api/posts?tab=latest&take=5', { headers: auth(keyOf(w, seq + 1)) })
    }
  }))

  console.log('server after:', JSON.stringify(await serverStats()))

  const after = {
    likeCount: Number((await client.query('SELECT "likeCount" FROM "Post" WHERE id=$1', [hotPost.id])).rows[0].likeCount),
    likeRows: Number((await client.query('SELECT count(*)::int AS n FROM "Like" WHERE "postId"=$1', [hotPost.id])).rows[0].n),
    postRows: Number((await client.query('SELECT count(*)::int AS n FROM "Post"')).rows[0].n),
    userPostCountSum: Number((await client.query('SELECT coalesce(sum("postCount"),0)::int AS n FROM "User"')).rows[0].n),
  }
  after.likeDelta = after.likeCount - after.likeRows

  const dupNotif = await client.query(`SELECT count(*)::int AS n FROM (
      SELECT "userId","fromId",type,"postId",count(*) c FROM "Notification" GROUP BY 1,2,3,4 HAVING count(*) > 1) d`)
  const dupNullNotif = await client.query(`SELECT count(*)::int AS n FROM (
      SELECT "userId","fromId",type,count(*) c FROM "Notification" WHERE "postId" IS NULL GROUP BY 1,2,3 HAVING count(*) > 1) d`)
  const pending = await client.query(`SELECT count(*)::int AS n FROM "SideEffectTask" WHERE status='pending'`)
  const loadPosts = Number((await client.query(`SELECT count(*)::int AS n FROM "Post" WHERE content LIKE 'load write%'`)).rows[0].n)

  const invariants = {
    hotLikeDeltaPreserved: counterDeltaPreserved(baseline.likeCount, baseline.likeRows, after.likeCount, after.likeRows),
    likeDeltaBefore: baseline.likeDelta,
    likeDeltaAfter: after.likeDelta,
    postRowsDeltaMatchesCounterDelta: (after.postRows - baseline.postRows) === (after.userPostCountSum - baseline.userPostCountSum),
    duplicateNotifications: Number(dupNotif.rows[0].n),
    duplicateNullPostNotifications: Number(dupNullNotif.rows[0].n),
    pendingOutboxTasks: Number(pending.rows[0].n),
    loadCreatedPosts: loadPosts,
    roundTrips,
  }
  console.log('INVARIANTS:', JSON.stringify(invariants))

  const invariantFailures = []
  if (!invariants.hotLikeDeltaPreserved) invariantFailures.push('hotLikeDeltaPreserved')
  if (!invariants.postRowsDeltaMatchesCounterDelta) invariantFailures.push('postRowsDeltaMatchesCounterDelta')
  if (invariants.duplicateNotifications > 0) invariantFailures.push('duplicateNotifications')
  if (invariants.duplicateNullPostNotifications > 0) invariantFailures.push('duplicateNullPostNotifications')
  if (invariants.pendingOutboxTasks > 0) invariantFailures.push('pendingOutboxTasks')
  if (results.some((r) => r.total5xx > 0)) invariantFailures.push('5xx observed')
  if (results.some((r) => r.totalNet > 0)) invariantFailures.push('network failures observed')
  console.log('SUMMARY:', JSON.stringify(results))

  await client.end()
  if (invariantFailures.length > 0) {
    console.error('INVARIANT FAILURES:', invariantFailures.join(', '))
    process.exit(1)
  }
  console.log('ALL INVARIANTS HELD')
}

main().catch((e) => { console.error(e); process.exit(1) })
