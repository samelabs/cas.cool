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
import { dropTestDatabase, provisionTestDatabase, promoteUser, sql } from './helpers/db'
import { startTestServer, stopTestServer } from './helpers/server'
import { SERVER_URL } from './helpers/env'
import { api, registerAndLogin } from './helpers/http'

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

  describe('Admin site profile management and cache revalidation', () => {
    it('enforces authentication and admin role boundary on /api/admin/site', async () => {
      // 1. Anonymous GET -> 401
      const anonRes = await fetch(`${SERVER_URL}/api/admin/site`)
      expect(anonRes.status).toBe(401)

      // 2. Normal member GET -> 403
      const member = await registerAndLogin('normalluser')
      const memberRes = await api('/api/admin/site', { cookie: member.cookie })
      expect(memberRes.status).toBe(403)

      // 3. Normal member PATCH -> 403
      const memberPatch = await api('/api/admin/site', {
        method: 'PATCH',
        cookie: member.cookie,
        body: JSON.stringify({ name: 'Hacked' }),
      })
      expect(memberPatch.status).toBe(403)
    })

    it('validates input parameters on PATCH /api/admin/site', async () => {
      const adminUser = await registerAndLogin('siteadmin')
      await promoteUser(adminUser.username, { admin: true, verified: true })

      // Empty name
      const resEmpty = await api('/api/admin/site', {
        method: 'PATCH',
        cookie: adminUser.cookie,
        body: JSON.stringify({ name: '', shortName: 'Short', tagline: 'Tag', description: 'Desc' }),
      })
      expect(resEmpty.status).toBe(400)

      // Invalid GitHub URL
      const resBadUrl = await api('/api/admin/site', {
        method: 'PATCH',
        cookie: adminUser.cookie,
        body: JSON.stringify({
          name: 'Valid Name',
          shortName: 'Short',
          tagline: 'Tag',
          description: 'Desc',
          githubUrl: 'not-a-valid-url',
        }),
      })
      expect(resBadUrl.status).toBe(400)
    })

    it('allows admin to read and update site profile, invalidating cache immediately', async () => {
      const adminUser = await registerAndLogin('siteadmin2')
      await promoteUser(adminUser.username, { admin: true, verified: true })

      // GET
      const getRes = await api('/api/admin/site', { cookie: adminUser.cookie })
      expect(getRes.status).toBe(200)
      const getData = await getRes.json()
      expect(getData.site.origin).toBe('https://cas.cool')
      expect(getData.site.keyPrefix).toBe('cas_')

      // PATCH
      const patchRes = await api('/api/admin/site', {
        method: 'PATCH',
        cookie: adminUser.cookie,
        body: JSON.stringify({
          name: 'Updated ChemHub',
          shortName: 'ChemHub',
          tagline: 'Connect and explore chemical innovations.',
          description: 'The updated global social platform for the chemical trade.',
          githubUrl: 'https://github.com/cascool/cascool',
        }),
      })
      expect(patchRes.status).toBe(200)
      const patchData = await patchRes.json()
      expect(patchData.site.name).toBe('Updated ChemHub')
      expect(patchData.site.shortName).toBe('ChemHub')
      expect(patchData.site.tagline).toBe('Connect and explore chemical innovations.')
      expect(patchData.site.description).toBe('The updated global social platform for the chemical trade.')

      // Direct database check
      const rows = await sql<{ name: string; shortName: string }>(
        'SELECT name, "shortName" FROM "SiteConfig" WHERE id = 1',
      )
      expect(rows[0].name).toBe('Updated ChemHub')
      expect(rows[0].shortName).toBe('ChemHub')
    })

    it('cache propagation: warm cache -> admin save -> same-process first read reflects new profile on about, home, llms, manifest', async () => {
      // 1. 预热缓存 (Warm up cache)
      const aboutWarm = await (await fetch(`${SERVER_URL}/about`)).text()
      expect(aboutWarm).toContain('What is')
      const homeWarm = await (await fetch(`${SERVER_URL}`)).text()
      expect(homeWarm).toBeDefined()
      const llmsWarm = await (await fetch(`${SERVER_URL}/llms.txt`)).text()
      expect(llmsWarm).toContain('Base URL:')
      const manifestWarm = await (await fetch(`${SERVER_URL}/manifest.webmanifest`)).json()
      expect(manifestWarm).toHaveProperty('name')

      // 2. 管理员保存 (Admin saves new profile via PATCH /api/admin/site)
      const adminUser = await registerAndLogin('siteadmin_cache')
      await promoteUser(adminUser.username, { admin: true, verified: true })

      const newName = 'ChemStream Enterprise'
      const newShort = 'ChemStream'
      const newTagline = 'Real-time trade feeds for chemical professionals worldwide.'
      const newDesc = 'The global social commerce network for verified chemical suppliers.'

      const patchRes = await api('/api/admin/site', {
        method: 'PATCH',
        cookie: adminUser.cookie,
        body: JSON.stringify({
          name: newName,
          shortName: newShort,
          tagline: newTagline,
          description: newDesc,
          githubUrl: 'https://github.com/cascool/enterprise',
        }),
      })
      expect(patchRes.status).toBe(200)

      // 3. 同进程首次读取 (Same-process first read immediately after save)
      // About: reads new description and new name
      const aboutAfter = await (await fetch(`${SERVER_URL}/about`)).text()
      expect(aboutAfter).toContain(newName)
      expect(aboutAfter).toContain(newDesc)

      // 首页 (Home): reads new tagline and name in timeline top bar / header
      const homeAfter = await (await fetch(`${SERVER_URL}`)).text()
      expect(homeAfter).toContain(newName)
      expect(homeAfter).toContain(newTagline)

      // llms.txt: reads new name in title
      const llmsAfter = await (await fetch(`${SERVER_URL}/llms.txt`)).text()
      expect(llmsAfter).toContain(`# ${newName}`)

      // manifest.webmanifest: reads new name and short_name
      const manifestAfter = (await (await fetch(`${SERVER_URL}/manifest.webmanifest`)).json()) as {
        name: string
        short_name: string
      }
      expect(manifestAfter.name).toBe(newName)
      expect(manifestAfter.short_name).toBe(newShort)
    })
  })
})
