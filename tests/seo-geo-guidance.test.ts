import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dropTestDatabase, provisionTestDatabase, sql } from './helpers/db'
import { startTestServer, stopTestServer } from './helpers/server'
import { SERVER_URL } from './helpers/env'
import { api, registerAndLogin } from './helpers/http'

const read = (p: string) => readFileSync(resolve(p), 'utf8')

let samplePostCode = ''
let sampleUserCookie = ''

beforeAll(async () => {
  await provisionTestDatabase()
  await startTestServer()

  // Seed chemicals: one active, one banned
  await sql(`
    INSERT INTO "Chemical" (id, "casNumber", "name", "smiles", "banned", "postCount", "createdAt", "updatedAt")
    VALUES
      ('chem_100_00_5', '100-00-5', 'Chlorobenzene', 'c1ccccc1Cl', false, 2, now(), now()),
      ('chem_200_00_5', '200-00-5', 'Banned Chem', null, true, 1, now(), now())
    ON CONFLICT ("casNumber") DO UPDATE SET
      "name" = EXCLUDED."name",
      "smiles" = EXCLUDED."smiles",
      "banned" = EXCLUDED."banned",
      "postCount" = EXCLUDED."postCount"
  `)

  // Create a user and a post for testing post JSON-LD
  const user = await registerAndLogin('seouser')
  await sql('UPDATE "User" SET "verificationStatus" = \'verified\', "verifiedAt" = now() WHERE username = $1', [user.username])
  const createRes = await api('/api/posts', {
    method: 'POST',
    cookie: user.cookie,
    body: JSON.stringify({
      content: 'Chlorobenzene 100-00-5 reaction synthesis notes for community review.',
      casNumbers: ['100-00-5'],
    }),
  })
  expect(createRes.status).toBe(201)
  const postData = await createRes.json()
  expect(typeof postData.shortCode).toBe('string')
  expect(postData.shortCode.length).toBeGreaterThan(0)
  samplePostCode = postData.shortCode
  sampleUserCookie = user.cookie
})

afterAll(async () => {
  await stopTestServer()
  await dropTestDatabase()
})

describe('Public copy, SEO/GEO and discovery governance', () => {
  describe('Static governance checks', () => {
    it('application UI has no self-added noindex or nofollow on public accessible profiles and chemical pages', () => {
      const casPage = read('src/app/(shell)/cas/[casNumber]/page.tsx')
      expect(casPage, 'no banned chemical noindex').not.toMatch(/banned[\s\S]*?index:\s*false/)

      const uPage = read('src/app/(shell)/u/[username]/page.tsx')
      expect(uPage, 'no suspended or restricted user noindex').not.toMatch(/user\.status[\s\S]*?index:\s*false/)
      expect(uPage, 'no !user metadata index: false').not.toMatch(/!user[\s\S]*?index:\s*false/)

      const notFoundPage = read('src/app/not-found.tsx')
      expect(notFoundPage, 'not-found relies on 404 HTTP status, no robots meta override').not.toMatch(/robots:\s*\{/)
    })

    it('sitemaps do not impose unconfirmed product exclusions on registered entities', () => {
      const casSitemap = read('src/app/(shell)/cas/sitemap.ts')
      expect(casSitemap, 'includes registered chemicals regardless of postCount').not.toContain('postCount: { gt: 0 }')
      expect(casSitemap, 'does not exclude banned chemicals from sitemap without basis').not.toContain('banned: false')

      const uSitemap = read('src/app/(shell)/u/sitemap.ts')
      expect(uSitemap, 'includes registered users without arbitrary active-only filtering').not.toContain("status: 'active'")
    })

    it('post structured data SocialMediaPosting expresses full text and editedAt dateModified without truncated headline', () => {
      const postPage = read('src/app/(shell)/p/[code]/page.tsx')
      expect(postPage, 'uses text: post.content for full post text').toContain('text: post.content')
      expect(postPage, 'does not truncate into a headline for posts without titles').not.toMatch(/headline:\s*post\.content\.slice/)
      expect(postPage, 'includes dateModified from editedAt').toContain('dateModified:')
      expect(postPage, 'uses public images with origin').toContain('publicImages')
    })

    it('chemical structured data ChemicalSubstance uses hasRepresentation, name, identifier, url, description; no interactionStatistic', () => {
      const casPage = read('src/app/(shell)/cas/[casNumber]/page.tsx')
      expect(casPage, 'uses hasRepresentation instead of non-standard smiles').toContain('hasRepresentation: chemical.smiles')
      expect(casPage, 'does not mount smiles directly on ChemicalSubstance').not.toMatch(/smiles:\s*chemical\.smiles/)
      expect(casPage, 'does not mount interactionStatistic on ChemicalSubstance').not.toContain('interactionStatistic')
      expect(casPage, 'does not mount commentCount on ChemicalSubstance').not.toContain('commentCount')
      expect(casPage, 'provides description in ChemicalSubstance').toContain('description,')
    })

    it('llms.txt is organized around user actions and omits internal implementation leakages', () => {
      const text = read('src/app/llms.txt/route.ts')

      // 5 top-level sections
      expect(text).toContain('## Connecting')
      expect(text).toContain('## Reading')
      expect(text).toContain('## Posting & Interactions')
      expect(text).toContain('## Receiving Notifications')
      expect(text).toContain('## Error Handling & Recovery')

      // Quotas and Retry-After
      expect(text).not.toContain('retryAfterSec')
      expect(text).toContain('Retry-After header')
      expect(text).toContain('Authenticated reads: 120 requests/minute.')
      expect(text).toContain('Authenticated writes: 60 requests/minute.')

      // Search endpoint description
      expect(text).toContain('Search posts by text or CAS number (verified members).')

      // Internal implementation exclusions
      expect(text, 'no password complexity rules in public llms.txt').not.toContain('password-rules')
      expect(text, 'no cookie fallback internal explanations').not.toContain('cookie fallback')
      expect(text, 'no redis/memory bucket key implementation detail').not.toContain('bucket key')
      expect(text, 'no advisory lock / tx arbitration implementation leakage').not.toContain('advisory_xact_lock')
    })

    it('ApiKeysClient provides unified REST and MCP instructions with placeholder and llms.txt entry', () => {
      const client = read('src/components/settings/ApiKeysClient.tsx')
      expect(client, 'contains REST API title').toContain('t.api.restTitle')
      expect(client, 'contains Authorization header example').toContain('Authorization: Bearer YOUR_API_KEY')
      expect(client, 'contains curl example with placeholder').toContain('curl -H "Authorization: Bearer YOUR_API_KEY"')
      expect(client, 'links to llms.txt reference').toContain('href="/llms.txt"')
      expect(client, 'uses t.api.restDocsLink').toContain('t.api.restDocsLink')

      const en = read('src/lib/i18n/en.ts')
      expect(en, 'restDocsLink matches actual content').toContain("restDocsLink: 'API and MCP guide'")
    })

    it('robots.ts keeps concise crawl rules without personal route enumeration', () => {
      const robots = read('src/app/robots.ts')
      expect(robots).toContain("allow: '/'")
      expect(robots).toContain("disallow: '/api/'")
      expect(robots).not.toContain('/settings')
      expect(robots).not.toContain('/messages')
      expect(robots).not.toContain('/notifications')
      expect(robots).not.toContain('/bookmarks')
      expect(robots).not.toContain('/compose')
    })

    it('About page describes the chemical social product accurately in English', () => {
      const about = read('src/app/(shell)/about/page.tsx')
      expect(about, 'uses site.description for product introduction').toContain('site.description')
      const en = read('src/lib/i18n/en.ts')
      expect(en, 'no internal stack description in about').not.toContain('An open-source web app built with Next.js')
    })
  })

  describe('Live HTTP output verification', () => {
    it('robots.txt outputs clean rules and actual sitemap paths over HTTP', async () => {
      const res = await fetch(`${SERVER_URL}/robots.txt`)
      expect(res.status).toBe(200)
      const text = await res.text()

      expect(text).toMatch(/User-Agent:\s*\*/i)
      expect(text).toContain('Allow: /')
      expect(text).toContain('Disallow: /api/')
      expect(text).toContain('Sitemap: https://cas.cool/sitemap.xml')
      expect(text).toContain('Sitemap: https://cas.cool/cas/sitemap.xml')
      expect(text).toContain('Sitemap: https://cas.cool/u/sitemap.xml')

      // Ensure no personal feature paths are enumerated in robots.txt
      expect(text).not.toContain('/settings')
      expect(text).not.toContain('/messages')
      expect(text).not.toContain('/notifications')
      expect(text).not.toContain('/bookmarks')
      expect(text).not.toContain('/compose')
    })

    it('llms.txt outputs accurate public agent instructions with proper content-type over HTTP', async () => {
      const res = await fetch(`${SERVER_URL}/llms.txt`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      const body = await res.text()

      expect(body).toContain('# CAS.cool')
      expect(body).toContain('## Connecting')
      expect(body).toContain('## Reading')
      expect(body).toContain('## Posting & Interactions')
      expect(body).toContain('## Receiving Notifications')
      expect(body).toContain('## Error Handling & Recovery')
      expect(body).toContain('Retry-After header')
      expect(body).toContain('Search posts by text or CAS number (verified members).')
      expect(body).not.toContain('retryAfterSec')
    })

    it('cas detail page serves ChemicalSubstance JSON-LD with hasRepresentation and without interactionStatistic', async () => {
      const res = await fetch(`${SERVER_URL}/cas/100-00-5`)
      expect(res.status).toBe(200)
      const html = await res.text()

      // Must contain JSON-LD script
      expect(html).toContain('application/ld+json')
      const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
      expect(match).toBeTruthy()
      const jsonLd = JSON.parse(match![1])

      expect(jsonLd['@context']).toBe('https://schema.org')
      expect(jsonLd['@type']).toBe('ChemicalSubstance')
      expect(jsonLd.identifier).toBe('CAS 100-00-5')
      expect(jsonLd.name).toBe('Chlorobenzene')
      expect(jsonLd.hasRepresentation).toBe('c1ccccc1Cl')
      expect(jsonLd.description).toContain('Chlorobenzene (CAS 100-00-5)')
      expect(jsonLd.interactionStatistic).toBeUndefined()
      expect(jsonLd.smiles).toBeUndefined()
      expect(jsonLd.commentCount).toBeUndefined()

      // UI stats bar retains post count
      expect(html).toContain('posts')
    })

    it('post detail page serves SocialMediaPosting JSON-LD with full text, dateModified, and no truncated headline', async () => {
      expect(samplePostCode).toBeTruthy()

      const res = await fetch(`${SERVER_URL}/p/${samplePostCode}`)
      expect(res.status).toBe(200)
      const html = await res.text()

      expect(html).toContain('application/ld+json')
      const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
      expect(match).toBeTruthy()
      const jsonLd = JSON.parse(match![1])

      expect(jsonLd['@context']).toBe('https://schema.org')
      expect(jsonLd['@type']).toBe('SocialMediaPosting')
      expect(jsonLd.text).toBe('Chlorobenzene 100-00-5 reaction synthesis notes for community review.')
      expect(jsonLd.headline).toBeUndefined()
      expect(jsonLd.datePublished).toBeTruthy()
      expect(jsonLd.dateModified).toBeUndefined()
      const originalPublished = jsonLd.datePublished

      // Edit the post via real PATCH endpoint
      const editedContent = 'Chlorobenzene 100-00-5 reaction synthesis notes updated community review.'
      const editRes = await api(`/api/posts/${samplePostCode}`, {
        method: 'PATCH',
        cookie: sampleUserCookie,
        body: JSON.stringify({
          content: editedContent,
        }),
      })
      expect(editRes.status).toBe(200)
      const editData = await editRes.json()
      expect(editData.editedAt).toBeTruthy()

      const resEdited = await fetch(`${SERVER_URL}/p/${samplePostCode}`)
      expect(resEdited.status).toBe(200)
      const htmlEdited = await resEdited.text()
      const matchEdited = htmlEdited.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
      expect(matchEdited).toBeTruthy()
      const jsonLdEdited = JSON.parse(matchEdited![1])

      expect(jsonLdEdited.text).toBe(editedContent)
      expect(jsonLdEdited.dateModified).toBe(new Date(editData.editedAt).toISOString())
      expect(jsonLdEdited.datePublished).toBe(originalPublished)
    })

    it('cas sitemap outputs both active and banned registered chemicals up to the cap', async () => {
      const res = await fetch(`${SERVER_URL}/cas/sitemap.xml`)
      expect(res.status).toBe(200)
      const xml = await res.text()

      expect(xml).toContain('https://cas.cool/cas/100-00-5')
      expect(xml).toContain('https://cas.cool/cas/200-00-5')
    })
  })
})
