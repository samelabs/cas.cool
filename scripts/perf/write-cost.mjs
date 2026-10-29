/**
 * Interaction write-cost benchmark — replays the exact interaction
 * transactions (like / bookmark / reply / repost, each with its undo) as
 * raw SQL against the perf database, isolating database cost from HTTP.
 *
 * Usage: node scripts/perf/write-cost.mjs [--db cascool_perf] [--cycles 2000]
 * Env:   PGPASSWORD/PGUSER/PGHOST/PGPORT (defaults cascool/cascool/localhost/5432)
 *
 * Reports per interaction: cycles/s, per-cycle p50/p95 (op + undo),
 * WAL bytes per cycle, and growth of Post + Post_feedRank_cover_idx during
 * the run. Run once with the covering index present and once without
 * (drop/recreate it between runs) to price the index's write cost.
 */

import { randomBytes } from 'node:crypto'
import { Client } from 'pg'

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ'
/** Random 8-char base54 code — cannot collide with any deterministic domain. */
function benchCode(prefix) {
  const bytes = randomBytes(8)
  let code = ''
  for (let i = 0; i < 8; i++) code += ALPHABET[bytes[i] % 54]
  return prefix + code
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : dflt
}

const DB = arg('db', 'cascool_perf')
const CYCLES = Number(arg('cycles', '2000'))
if (DB.length > 63 || !/^[a-z][a-z0-9_]*_perf$/.test(DB)) {
  throw new Error('Write-cost benchmark requires a lowercase _perf database name (max 63 characters).')
}
if (!Number.isInteger(CYCLES) || CYCLES < 1 || CYCLES > 100_000) {
  throw new Error('--cycles must be an integer from 1 to 100000.')
}
const dbUrl = new URL('postgresql://localhost/cascool_perf')
dbUrl.hostname = process.env.PGHOST ?? 'localhost'
dbUrl.port = process.env.PGPORT ?? '5432'
dbUrl.username = process.env.PGUSER ?? 'cascool'
dbUrl.password = process.env.PGPASSWORD ?? 'cascool'
dbUrl.pathname = `/${DB}`

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b)
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  return { p50: pct(50), p95: pct(95), max: s[s.length - 1] }
}

async function sizeOf(c, rel) {
  const r = await c.query(`SELECT pg_relation_size($1) AS s`, [rel])
  return Number(r.rows[0].s)
}

async function main() {
  const c = new Client({ connectionString: dbUrl.toString() })
  await c.connect()

  const seedMarker = await c.query(
    'SELECT 1 FROM "User" WHERE id = $1 AND email = $2',
    ['perf-reader', 'perf@test.local'],
  )
  if (seedMarker.rowCount !== 1) {
    await c.end()
    throw new Error('Database is not the expected performance seed; refusing write benchmark.')
  }

  // Fresh actor user + N hot root posts as targets (spread across posts).
  const actor = 'bench-actor'
  // Clean any rows from an earlier (possibly crashed) run first.
  await c.query(`DELETE FROM "Like" WHERE "userId" = $1 OR id LIKE 'bl-%'`, [actor])
  await c.query(`DELETE FROM "Bookmark" WHERE "userId" = $1 OR id LIKE 'bb-%'`, [actor])
  await c.query(`DELETE FROM "Repost" WHERE "userId" = $1 OR id LIKE 'bp-%'`, [actor])
  await c.query(`DELETE FROM "Post" WHERE "authorId" = $1 OR id LIKE 'bq-%' OR id LIKE 'br-%'`, [actor])
  await c.query('DELETE FROM "User" WHERE id = $1', [actor])
  await c.query(
    `INSERT INTO "User" (id, email, username, "displayName", "passwordHash", role,
       "verificationStatus", status, "createdAt", "updatedAt")
     VALUES ($1, 'bench@test.local', 'bench_actor', 'Bench',
       '$2a$10$seedseedseedseedseedseedseedseedseedseedseedseedse',
       'user', 'verified', 'active', now(), now())`,
    [actor],
  )

  const hasIndex = await c.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = 'Post_feedRank_cover_idx'`,
  )
  console.log(`[write-cost] db=${DB} cycles=${CYCLES} coveringIndex=${hasIndex.rowCount ? 'PRESENT' : 'ABSENT'}`)

  const targets = (
    await c.query(
      `SELECT id FROM "Post" WHERE "deletedAt" IS NULL AND "parentId" IS NULL
       ORDER BY "createdAt" DESC LIMIT $1`,
      [CYCLES],
    )
  ).rows.map((r) => r.id)
  if (targets.length < CYCLES) throw new Error('not enough target posts')

  const postSize0 = await sizeOf(c, '"Post"')
  const idxSize0 = hasIndex.rowCount ? await sizeOf(c, '"Post_feedRank_cover_idx"') : 0
  const wal0 = (await c.query('SELECT pg_current_wal_lsn() AS lsn')).rows[0].lsn

  const benches = []

  // ── like (op + undo per cycle) ──
  benches.push(['like', async (i) => {
    const postId = targets[i % targets.length]
    await c.query('BEGIN')
    await c.query('INSERT INTO "Like" (id, "postId", "userId", "createdAt") VALUES ($1, $2, $3, now())', [`bl-${i}`, postId, actor])
    await c.query('UPDATE "Post" SET "likeCount" = "likeCount" + 1 WHERE id = $1', [postId])
    await c.query('COMMIT')
    await c.query('BEGIN')
    await c.query('DELETE FROM "Like" WHERE id = $1', [`bl-${i}`])
    await c.query('UPDATE "Post" SET "likeCount" = "likeCount" - 1 WHERE id = $1', [postId])
    await c.query('COMMIT')
  }])

  // ── bookmark ──
  benches.push(['bookmark', async (i) => {
    const postId = targets[i % targets.length]
    await c.query('BEGIN')
    await c.query('INSERT INTO "Bookmark" (id, "postId", "userId", "createdAt") VALUES ($1, $2, $3, now())', [`bb-${i}`, postId, actor])
    await c.query('UPDATE "Post" SET "bookmarkCount" = "bookmarkCount" + 1 WHERE id = $1', [postId])
    await c.query('COMMIT')
    await c.query('BEGIN')
    await c.query('DELETE FROM "Bookmark" WHERE id = $1', [`bb-${i}`])
    await c.query('UPDATE "Post" SET "bookmarkCount" = "bookmarkCount" - 1 WHERE id = $1', [postId])
    await c.query('COMMIT')
  }])

  // ── reply (create + soft-delete with counters) ──
  benches.push(['reply', async (i) => {
    const parent = targets[i % targets.length]
    await c.query('BEGIN')
    const r = await c.query(
      `INSERT INTO "Post" (id, "authorId", "parentId", "conversationId", content, images, views,
         "likeCount", "replyCount", "repostCount", "bookmarkCount", "shortCode", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $3, 'bench reply', ARRAY[]::text[], 0, 0, 0, 0, 0, $4, now(), now())
       RETURNING id`,
      [`br-${i}`, actor, parent, benchCode('b')],
    )
    await c.query('UPDATE "Post" SET "replyCount" = "replyCount" + 1 WHERE id = $1', [parent])
    await c.query('UPDATE "User" SET "postCount" = "postCount" + 1 WHERE id = $1', [actor])
    await c.query('COMMIT')
    await c.query('BEGIN')
    await c.query('UPDATE "Post" SET "deletedAt" = now(), content = \'\' WHERE id = $1', [r.rows[0].id])
    await c.query('UPDATE "Post" SET "replyCount" = "replyCount" - 1 WHERE id = $1', [parent])
    await c.query('UPDATE "User" SET "postCount" = "postCount" - 1 WHERE id = $1', [actor])
    await c.query('COMMIT')
  }])

  // ── repost (dual record + undo) ──
  benches.push(['repost', async (i) => {
    const target = targets[i % targets.length]
    await c.query('BEGIN')
    await c.query('INSERT INTO "Repost" (id, "postId", "userId", "createdAt") VALUES ($1, $2, $3, now())', [`bp-${i}`, target, actor])
    await c.query(
      `INSERT INTO "Post" (id, "authorId", content, "quotePostId", images, views,
         "likeCount", "replyCount", "repostCount", "bookmarkCount", "shortCode", "createdAt", "updatedAt")
       VALUES ($1, $2, '', $3, ARRAY[]::text[], 0, 0, 0, 0, 0, $4, now(), now())`,
      [`bq-${i}`, actor, target, benchCode('c')],
    )
    await c.query('UPDATE "Post" SET "repostCount" = "repostCount" + 1 WHERE id = $1', [target])
    await c.query('UPDATE "User" SET "postCount" = "postCount" + 1 WHERE id = $1', [actor])
    await c.query('COMMIT')
    await c.query('BEGIN')
    await c.query('DELETE FROM "Repost" WHERE id = $1', [`bp-${i}`])
    await c.query('DELETE FROM "Post" WHERE id = $1', [`bq-${i}`])
    await c.query('UPDATE "Post" SET "repostCount" = "repostCount" - 1 WHERE id = $1', [target])
    await c.query('UPDATE "User" SET "postCount" = "postCount" - 1 WHERE id = $1', [actor])
    await c.query('COMMIT')
  }])

  for (const [name, cycle] of benches) {
    const times = []
    for (let i = 0; i < CYCLES; i++) {
      const t0 = performance.now()
      await cycle(i)
      times.push(performance.now() - t0)
    }
    const s = stats(times.map((t) => Math.round(t * 100) / 100))
    const ops = Math.round(CYCLES / (times.reduce((a, b) => a + b, 0) / 1000))
    console.log(
      `[write-cost] ${name.padEnd(9)} cycles=${CYCLES} ops/s=${ops} ` +
        `p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms`,
    )
    const walMid = (await c.query('SELECT pg_current_wal_lsn() AS lsn')).rows[0].lsn
    const wal = (
      await c.query('SELECT pg_wal_lsn_diff($1, $2) AS bytes', [walMid, wal0])
    ).rows[0].bytes
    if (name === 'repost') {
      console.log(`[write-cost] WAL total=${(wal / 1024 / 1024).toFixed(1)}MB over ${CYCLES * 4} interaction cycles`)
    }
  }

  const postSize1 = await sizeOf(c, '"Post"')
  const idxSize1 = hasIndex.rowCount ? await sizeOf(c, '"Post_feedRank_cover_idx"') : 0
  const wal1 = (await c.query('SELECT pg_current_wal_lsn() AS lsn')).rows[0].lsn
  const walBytes = Number((await c.query('SELECT pg_wal_lsn_diff($1, $2) AS b', [wal1, wal0])).rows[0].b)
  console.log(
    `[write-cost] Post size ${postSize0 / 1e6}MB -> ${postSize1 / 1e6}MB ` +
      `(+${((postSize1 - postSize0) / (CYCLES * 4)).toFixed(0)}B/cycle); ` +
      `index ${idxSize0 / 1e6}MB -> ${idxSize1 / 1e6}MB (Δ${(idxSize1 - idxSize0) / 1024}KB); ` +
      `WAL ${(walBytes / 1e6).toFixed(1)}MB total (${(walBytes / (CYCLES * 4)).toFixed(0)}B/cycle)`,
  )

  await c.query('DELETE FROM "User" WHERE id = $1', [actor])
  await c.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
