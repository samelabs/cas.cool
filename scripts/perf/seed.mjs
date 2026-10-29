/**
 * Seed a throwaway near-production-scale database for feed performance
 * measurement. Pure SQL through pg — no app imports, no path aliases.
 *
 * Usage:  node scripts/perf/seed.mjs [dbname]
 * Env:    PGUSER/PGPASSWORD/PGHOST or defaults (cascool/cascool/localhost)
 *
 * Scale (matching the production shape referenced in src/lib/feed.ts):
 *   20 000 users · 800 000 posts (620k roots / 180k replies)
 *   ~450k follow edges · 5 000 chemicals · ~300k post↔chemical links
 *   1 % soft-deleted · engagement counts heavily zipf-skewed
 *
 * Recreates <dbname> (default cascool_perf). The name must end in _perf.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Client } from 'pg'

const DB_NAME = process.argv[2] ?? 'cascool_perf'
if (DB_NAME.length > 63 || !/^[a-z][a-z0-9_]*_perf$/.test(DB_NAME)) {
  throw new Error('Performance seed database name must be at most 63 lowercase characters and end in _perf.')
}
const HOST = process.env.PGHOST ?? 'localhost'
const PORT = Number(process.env.PGPORT ?? 5432)
const USER = process.env.PGUSER ?? 'cascool'
const PASSWORD = process.env.PGPASSWORD ?? 'cascool'
const adminUrl = new URL('postgresql://localhost/postgres')
adminUrl.hostname = HOST
adminUrl.port = String(PORT)
adminUrl.username = USER
adminUrl.password = PASSWORD
const dbUrl = new URL(adminUrl)
dbUrl.pathname = `/${DB_NAME}`
const DB_URL = dbUrl.toString()

const USERS = 20_000
const POSTS = 800_000
const REPLIES = 180_000
const CHEMICALS = 5_000
const FOLLOWS_PER_USER = 30

function log(step) {
  console.log(`[seed] ${step}`)
}

async function admin(sql, params = []) {
  const c = new Client({ connectionString: adminUrl.toString() })
  await c.connect()
  try {
    await c.query(sql, params)
  } finally {
    await c.end()
  }
}

async function main() {
  log(`recreate ${DB_NAME}`)
  await admin('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DB_NAME])
  await admin(`DROP DATABASE IF EXISTS "${DB_NAME}"`)
  await admin(`CREATE DATABASE "${DB_NAME}"`)

  log('prisma migrate deploy')
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: DB_URL },
    stdio: 'inherit',
  })

  const c = new Client({ connectionString: DB_URL })
  await c.connect()
  const t0 = Date.now()
  try {
    log('short54() SQL function (deterministic 8-char base54 codes)')
    // 54^8 ≈ 7.2e13; g·7919 is a bijection because 7919 is coprime with 54.
    await c.query(`
      CREATE OR REPLACE FUNCTION short54(g bigint) RETURNS text AS $fn$
      DECLARE
        alphabet text := '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
        code text := '';
        i int;
      BEGIN
        FOR i IN 1..8 LOOP
          code := substr(alphabet, (g % 54)::int + 1, 1) || code;
          g := (g / 54)::bigint;
        END LOOP;
        RETURN code;
      END $fn$ LANGUAGE plpgsql IMMUTABLE
    `)

    log('SiteConfig row 1')
    await c.query(`
      INSERT INTO "SiteConfig" (id, origin, name, "shortName", "keyPrefix", description, tagline, "updatedAt")
      VALUES (1, 'https://cas.cool', 'cas.cool', 'cas', 'cas', 'Social timeline for chemistry.', 'Breaking down the walls around chemical data.', now())
      ON CONFLICT (id) DO NOTHING
    `)

    log(`users (${USERS})`)
    await c.query(`
      INSERT INTO "User" (id, email, username, "displayName", "passwordHash", "role",
        "verificationStatus", status, "createdAt", "updatedAt")
      SELECT
        'u-' || lpad(g::text, 8, '0'),
        'u' || lpad(g::text, 6, '0') || '@seed.local',
        'u' || lpad(g::text, 6, '0'),
        'User ' || g,
        '$2a$10$seedseedseedseedseedseedseedseedseedseedseedseedse',
        'user'::"UserRole",
        CASE WHEN g % 10 < 3 THEN 'verified' ELSE 'unverified' END::"UserVerificationStatus",
        'active'::"UserAccountStatus",
        now() - (random() * 700) * interval '1 day',
        now()
      FROM generate_series(1, ${USERS}) g
    `)

    log('perf_reader + API keys')
    await c.query(`
      INSERT INTO "User" (id, email, username, "displayName", "passwordHash", role,
        "verificationStatus", status, "createdAt", "updatedAt")
      VALUES ('perf-reader', 'perf@test.local', 'perf_reader', 'Perf Reader',
        '$2a$10$seedseedseedseedseedseedseedseedseedseedseedseedse',
        'user', 'verified', 'active', now() - interval '400 days', now())
    `)
    // One read key per measured scenario — each gets its own fresh
    // rate-limit bucket so p50/p95 loops never trip 429s.
    const keys = ['latest', 'following', 'foryou', 'detail', 'extra1', 'warm']
    for (const k of keys) {
      const raw = `perf_key_${k}_${Date.now().toString(36)}`
      await c.query(
        `INSERT INTO "ApiKey" (id, "userId", name, "keyHash", prefix, access, "createdAt")
         VALUES ($1, 'perf-reader', $2, $3, $4, 'read', now())`,
        [`k-${k}`, `perf-${k}`, createHash('sha256').update(raw).digest('hex'), raw.slice(0, 12)],
      )
      console.log(`        key ${k}: ${raw}`)
    }

    log(`chemicals (${CHEMICALS})`)
    await c.query(`
      INSERT INTO "Chemical" (id, "casNumber", name, banned, "postCount", "createdAt", "updatedAt")
      SELECT
        'c-' || lpad(g::text, 8, '0'),
        ((g * 7919) % 9000000 + 100000)::text
          || '-' || lpad(((g * 31) % 90 + 10)::text, 2, '0')
          || '-' || ((g * 7) % 9)::text,
        NULL, g % 500 = 0, 0, now() - interval '300 days', now()
      FROM generate_series(1, ${CHEMICALS}) g
      ON CONFLICT ("casNumber") DO NOTHING
    `)

    log(`posts (${POSTS}: ${POSTS - REPLIES} roots + ${REPLIES} replies) — chunked`)
    const ROOTS = POSTS - REPLIES
    const CHUNK = 100_000
    for (let from = 1; from <= ROOTS; from += CHUNK) {
      const n = Math.min(CHUNK, ROOTS - from + 1)
      await c.query(`
        INSERT INTO "Post" (id, "authorId", "parentId", "conversationId", content,
          "quotePostId", images, views, "likeCount", "replyCount", "repostCount",
          "bookmarkCount", "shortCode", "isPinned", "createdAt", "updatedAt")
        SELECT
          'p-' || lpad(g::text, 9, '0'),
          'u-' || lpad(((g::bigint * 7919 % ${USERS}) + 1)::text, 8, '0'),
          NULL, NULL,
          repeat('x', 40 + (g % 6) * 60),
          CASE WHEN g % 25 = 0 THEN 'p-' || lpad((g % 100000 + 1)::text, 9, '0') ELSE NULL END,
          CASE WHEN g % 12 = 0 THEN ARRAY['/uploads/seed.webp'] ELSE ARRAY[]::text[] END,
          (random() * 5000)::int,
          (random() * random() * 2000)::int,
          (random() * random() * 200)::int,
          (random() * random() * 400)::int,
          (random() * random() * 300)::int,
          short54(g::bigint * 7919 + 11),
          false,
          now() - (power(random(), 1.2) * 365) * interval '1 day',
          now()
        FROM generate_series(${from}, ${from + n - 1}) g
      `)
      process.stdout.write(`        roots ${from + n - 1}/${ROOTS}\r`)
    }

    for (let from = 0; from < REPLIES; from += CHUNK) {
      const n = Math.min(CHUNK, REPLIES - from)
      const base = POSTS - REPLIES // replies reference a root post id
      await c.query(`
        INSERT INTO "Post" (id, "authorId", "parentId", "conversationId", content,
          images, views, "likeCount", "replyCount", "repostCount", "bookmarkCount",
          "shortCode", "createdAt", "updatedAt")
        SELECT
          'p-' || lpad((g + ${base})::text, 9, '0'),
          'u-' || lpad((((g::bigint * 104729) % ${USERS}) + 1)::text, 8, '0'),
          'p-' || lpad(((g * 7919) % ${base} + 1)::text, 9, '0'),
          NULL,
          repeat('r', 20 + (g % 5) * 40),
          ARRAY[]::text[],
          (random() * 500)::int,
          (random() * random() * 400)::int, 0, 0, 0,
          short54((g + ${base})::bigint * 7919 + 11),
          now() - (power(random(), 1.2) * 365) * interval '1 day',
          now()
        FROM generate_series(${from + 1}, ${from + n}) g
      `)
      process.stdout.write(`        replies ${from + n}/${REPLIES}\r`)
    }

    log('reply conversationId self-join')
    await c.query(`
      UPDATE "Post" r SET "conversationId" = COALESCE(p."conversationId", p.id)
      FROM "Post" p WHERE p.id = r."parentId" AND r."conversationId" IS NULL
    `)

    log('soft-delete 1 %')
    await c.query(`UPDATE "Post" SET "deletedAt" = now(), content = '', images = ARRAY[]::text[]
      WHERE id IN (SELECT id FROM "Post" WHERE (id LIKE 'p-000%') AND (substring(id from 8 for 2))::int % 100 = 0)`)

    log(`follows (~${(USERS * FOLLOWS_PER_USER / 1000) | 0}k edges)`)
    await c.query(`
      INSERT INTO "Follow" (id, "followerId", "followingId", "createdAt")
      SELECT
        'f-' || lpad(g::text, 10, '0'),
        'u-' || lpad(((g::bigint * 7919 % ${USERS}) + 1)::text, 8, '0'),
        'u-' || lpad(((g::bigint * 104729 + 17) % ${USERS} + 1)::text, 8, '0'),
        now() - (random() * 365) * interval '1 day'
      FROM generate_series(1, ${USERS * FOLLOWS_PER_USER}) g
      ON CONFLICT DO NOTHING
    `)
    // perf_reader follows 40 recent, active posters so the Following tab
    // always has fresh content.
    await c.query(`
      INSERT INTO "Follow" (id, "followerId", "followingId", "createdAt")
      SELECT 'fr-' || lpad(row_number() over ()::text, 6, '0'), 'perf-reader', "authorId", now()
      FROM (SELECT DISTINCT "authorId" FROM "Post"
            WHERE "createdAt" > now() - interval '7 days' AND "deletedAt" IS NULL
            LIMIT 40) s
      ON CONFLICT DO NOTHING
    `)

    log('post ↔ chemical links (~300k)')
    await c.query(`
      INSERT INTO "_ChemicalToPost" ("A", "B")
      SELECT
        'c-' || lpad(((g::bigint * 7919 % ${CHEMICALS}) + 1)::text, 8, '0'),
        'p-' || lpad(g::text, 9, '0')
      FROM generate_series(1, ${POSTS - REPLIES}) g
      WHERE g % 10 < 4
      ON CONFLICT DO NOTHING
    `)

    log('reader likes 100 recent posts (interaction-state realism)')
    await c.query(`
      INSERT INTO "Like" (id, "postId", "userId", "createdAt")
      SELECT 'lk-' || lpad(row_number() over ()::text, 6, '0'), id, 'perf-reader', now()
      FROM (SELECT id FROM "Post" WHERE "deletedAt" IS NULL AND "createdAt" > now() - interval '2 days'
            ORDER BY "createdAt" DESC LIMIT 100) s
      ON CONFLICT DO NOTHING
    `)

    log('denormalized counts')
    await c.query(`
      UPDATE "User" u SET "postCount" = COALESCE(s.cnt, 0) FROM
        (SELECT "authorId", count(*) cnt FROM "Post" WHERE "deletedAt" IS NULL GROUP BY "authorId") s
      WHERE s."authorId" = u.id
    `)
    await c.query(`
      UPDATE "User" u SET "followerCount" = COALESCE(s.cnt, 0) FROM
        (SELECT "followingId", count(*) cnt FROM "Follow" GROUP BY "followingId") s
      WHERE s."followingId" = u.id
    `)
    await c.query(`
      UPDATE "User" u SET "followingCount" = COALESCE(s.cnt, 0) FROM
        (SELECT "followerId", count(*) cnt FROM "Follow" GROUP BY "followerId") s
      WHERE s."followerId" = u.id
    `)
    await c.query(`
      UPDATE "Chemical" c SET "postCount" = COALESCE(s.cnt, 0) FROM
        (SELECT "A", count(*) cnt FROM "_ChemicalToPost" GROUP BY "A") s
      WHERE s."A" = c.id
    `)

    log('ANALYZE')
    await c.query('ANALYZE')

    const stats = await c.query(`
      SELECT
        (SELECT count(*) FROM "User") users,
        (SELECT count(*) FROM "Post") posts,
        (SELECT count(*) FROM "Post" WHERE "deletedAt" IS NOT NULL) deleted,
        (SELECT count(*) FROM "Follow") follows,
        (SELECT count(*) FROM "_ChemicalToPost") links,
        (SELECT count(*) FROM "Post" WHERE "createdAt" > now() - interval '30 days') window30d,
        (SELECT count(*) FROM "Post" WHERE "createdAt" > now() - interval '24 hours') last24h
    `)
    console.log('[seed] done in', ((Date.now() - t0) / 1000).toFixed(1), 's')
    console.log('[seed]', stats.rows[0])
  } finally {
    await c.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
