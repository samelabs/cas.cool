/**
 * Production-build HTTP regression for the post sitemap shard route.
 *
 * Opt-in (not part of the default suite — it runs a full `next build`):
 *   RUN_PROD_HTTP=1 npx vitest run tests/prod-sitemap.http.test.ts
 *
 * Pins the acceptance rule: NO numeric shard index may produce a 500 in a
 * production build — 0 (in-range with content), beyond the current range,
 * and the float64-overflow index 9007199254740991 must all answer; only
 * malformed segments 404.
 */

import { execFileSync, spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropTestDatabase, provisionTestDatabase, sql } from './helpers/db'
import { TEST_DATABASE_URL } from './helpers/env'

const enabled = !!process.env.RUN_PROD_HTTP
const PORT = Number(process.env.TEST_PROD_PORT ?? 3211)
const BASE = `http://127.0.0.1:${PORT}`

let child: ReturnType<typeof spawn> | null = null

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/robots.txt`)
      if (res.status === 200) return
    } catch {
      // not accepting connections yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('next start did not become ready within 60s')
}

describe.skipIf(!enabled)('production-build sitemap shard HTTP regression', () => {
  beforeAll(async () => {
    await provisionTestDatabase()
    // A couple of live posts so shard 0 has real content.
    const [author] = await sql<{ id: string }>(`
      INSERT INTO "User" (id, email, username, "passwordHash", "postCount", "createdAt", "updatedAt")
      VALUES ('prod_smoke_author', 'prodsmoke@example.test', 'prod_smoke_author', 'x', 2, now(), now())
      RETURNING id`)
    await sql(`
      INSERT INTO "Post" (id, "shortCode", "authorId", content, images, "createdAt", "updatedAt") VALUES
        ('prod_smoke_1', 'prdsmk01', $1, 'prod smoke one', '{}'::text[], now(), now()),
        ('prod_smoke_2', 'prdsmk02', $1, 'prod smoke two', '{}'::text[], now(), now())`, [author.id])

    execFileSync('npx', ['next', 'build'], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: 'pipe',
    })
    child = spawn('npx', ['next', 'start', '--port', String(PORT)], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    await waitUntilReady()
  }, 300_000)

  afterAll(async () => {
    const c = child
    child = null
    if (c && c.exitCode === null) {
      await new Promise<void>((resolve) => {
        c.on('exit', () => resolve())
        try {
          process.kill(-c.pid!, 'SIGTERM')
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            process.kill(-c.pid!, 'SIGKILL')
          } catch {
            /* already gone */
          }
          resolve()
        }, 5000)
      })
    }
    await dropTestDatabase()
  })

  it('0.xml serves content; beyond-range, overflow and malformed indices never 500', async () => {
    const inRange = await fetch(`${BASE}/p/sitemap/0.xml`)
    expect(inRange.status).toBe(200)
    const xml = await inRange.text()
    expect(xml).toContain('/p/prdsmk01')
    expect(xml).toContain('/p/prdsmk02')

    // Beyond the current shard range (2 live posts → 1 shard): valid empty.
    const beyond = await fetch(`${BASE}/p/sitemap/1.xml`)
    expect(beyond.status).toBe(200)
    expect((await beyond.text()).match(/<url>/g) ?? []).toHaveLength(0)

    // float64-overflow offset: must be answered empty, not 500.
    const overflow = await fetch(`${BASE}/p/sitemap/9007199254740991.xml`)
    expect(overflow.status).toBe(200)
    expect((await overflow.text()).match(/<url>/g) ?? []).toHaveLength(0)

    // Malformed segment is the only 404.
    const malformed = await fetch(`${BASE}/p/sitemap/not-a-number.xml`)
    expect(malformed.status).toBe(404)

    // robots lists only the existing shard.
    const robots = await (await fetch(`${BASE}/robots.txt`)).text()
    expect(robots).toContain('/p/sitemap/0.xml')
    expect(robots).not.toContain('/p/sitemap/1.xml')
  })
})
