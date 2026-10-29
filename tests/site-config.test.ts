/**
 * Site identity derivation — every public surface (agent discovery, robots,
 * web manifest, sitemap) reads the same SiteConfig row through
 * src/lib/site.ts. Propagation caveats (verified against a production
 * build, recorded in docs/API-BASELINE.md):
 *
 *   - robots / manifest / sitemap are prerendered with 1h revalidation;
 *     llms.txt is dynamic but reads the same cached SiteConfig row.
 *   - getSiteConfig revalidates hourly; a cold build picks up a new row
 *     immediately, while a database-only change waits for revalidation.
 *
 * This test pins the DERIVATION (same identity everywhere) in dev mode.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropTestDatabase, provisionTestDatabase, sql } from './helpers/db'
import { startTestServer, stopTestServer } from './helpers/server'
import { SERVER_URL } from './helpers/env'

beforeAll(async () => {
  await provisionTestDatabase()
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
  await dropTestDatabase()
})

describe('site identity surfaces derive from SiteConfig row 1', () => {
  it('llms.txt: name, origin and key prefix from the row', async () => {
    const res = await fetch(`${SERVER_URL}/llms.txt`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('# CAS.cool')
    expect(body).toContain('Base URL: https://cas.cool')
    expect(body).toContain('Bearer cas_...')
  })

  it('robots.txt: sitemap URL from the row origin; API paths disallowed', async () => {
    const body = await (await fetch(`${SERVER_URL}/robots.txt`)).text()
    expect(body).toContain('Sitemap: https://cas.cool/sitemap.xml')
    expect(body).toContain('Sitemap: https://cas.cool/p/sitemap/0.xml')
    expect(body).toContain('Disallow: /api/')
  })

  it('manifest.webmanifest: name/short_name from the row', async () => {
    const manifest = (await (await fetch(`${SERVER_URL}/manifest.webmanifest`)).json()) as {
      name: string
      short_name: string
    }
    expect(manifest.name).toBe('CAS.cool')
    expect(manifest.short_name).toBe('CAS.cool')
  })

  it('sitemap.xml: URLs prefixed with the row origin', async () => {
    const root = await (await fetch(`${SERVER_URL}/sitemap.xml`)).text()
    expect(root).toContain('https://cas.cool/explore')
    const postsRes = await fetch(`${SERVER_URL}/p/sitemap/0.xml`)
    expect(postsRes.status).toBe(200)
    expect(postsRes.headers.get('content-type')).toContain('xml')
  })

  it('the row is the single source — directly readable and validated', async () => {
    const rows = await sql<{ origin: string; name: string; keyPrefix: string }>(
      'SELECT origin, name, "keyPrefix" FROM "SiteConfig" WHERE id = 1',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].origin).toBe('https://cas.cool')
    expect(rows[0].keyPrefix).toBe('cas_')
  })

  it('renders the visible home wordmark from the SiteConfig row', async () => {
    await sql('UPDATE "SiteConfig" SET name = $1 WHERE id = 1', ['Feed Example'])
    await stopTestServer()
    await startTestServer()
    const response = await fetch(SERVER_URL)
    expect(response.status).toBe(200)
    const html = await response.text()
    const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0]
    expect(header).toContain('Feed Example')
  })
})
