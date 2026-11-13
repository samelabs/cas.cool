import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { dropTestDatabase, provisionTestDatabase, sql } from './helpers/db'
import { startTestServer, stopTestServer } from './helpers/server'
import { SERVER_URL } from './helpers/env'

/**
 * Post-detail SEO contract regression (2026-11 perf round).
 *
 * The /p/[code] route was made faster by parallelizing chain/replies/follow
 * and deduping the post read across generateMetadata + page via React
 * cache(). This file pins the contract that must NOT drift with such
 * changes — most importantly the missing-post HTTP status:
 *
 *   A missing short code must answer HTTP 404 — NOT a streamed 200 with a
 *   noindex meta (which is exactly what a `loading.tsx` segment introduces;
 *   empirically rejected in that round).
 */
describe('post detail SEO contract', () => {
  beforeAll(async () => {
    await provisionTestDatabase()
    await startTestServer()
    await sql(`
      INSERT INTO "User" (id, email, username, "displayName", "passwordHash", "createdAt", "updatedAt")
      VALUES ('u_contract_1', 'contract@example.com', 'contractuser', 'Contract User', 'x', now(), now())
      ON CONFLICT (id) DO NOTHING
    `)
    await sql(`
      INSERT INTO "Post" (id, "authorId", content, "shortCode", "createdAt", "updatedAt")
      VALUES ('p_contract_1', 'u_contract_1', 'Contract post body 64-17-5', 'Cnt00001', now(), now())
      ON CONFLICT (id) DO NOTHING
    `)
  })

  afterAll(async () => {
    await stopTestServer()
    await dropTestDatabase()
  })

  it('an existing post answers 200 with JSON-LD and Open Graph metadata', async () => {
    const res = await fetch(`${SERVER_URL}/p/Cnt00001`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('application/ld+json')
    expect(html).toContain('og:title')
  })

  it('a missing post answers HTTP 404 (never a streamed 200 + noindex)', async () => {
    const res = await fetch(`${SERVER_URL}/p/zzzNope9`)
    expect(res.status).toBe(404)
  })

  it('a soft-deleted post stays a 200 tombstone (reply-chain stability contract)', async () => {
    await sql(`UPDATE "Post" SET "deletedAt" = now() WHERE id = 'p_contract_1'`)
    const res = await fetch(`${SERVER_URL}/p/Cnt00001`)
    expect(res.status).toBe(200)
  })
})
