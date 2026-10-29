/**
 * Module-boundary rules — the import-path closure pinned as tests:
 *
 * The feed/post core (generic reads, generic write steps, serialization)
 * and generic interactions must not load the chemical product layer; only
 * application composition (post.service.ts, post-write.service.ts,
 * search.service.ts) may import it. This is a static property of the
 * source (import statements), so it is verified by reading the files —
 * a runtime graph check would only re-derive the same strings after
 * bundling.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(resolve(p), 'utf8')

const CHEMISTRY_FREE = [
  'src/lib/services/post-core.service.ts', // timeline/detail core reads
  'src/lib/services/post-core-write.service.ts', // generic post transaction steps
  'src/lib/services/interaction.service.ts', // like/bookmark/repost
  'src/lib/feed.ts', // generic feed queries
  'src/lib/serialize.ts', // generic post projection
]

const CHEMISTRY_EXPECTED = [
  'src/lib/services/post.service.ts', // application read composition
  'src/lib/services/post-write.service.ts', // application write composition
  'src/lib/services/search.service.ts', // search attaches product tags
]

function localSource(specifier: string, importer: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve('src', specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(importer, '..', specifier)
      : null
  if (!base) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function chemistryPath(start: string): string[] | null {
  const seen = new Set<string>()
  function visit(file: string, path: string[]): string[] | null {
    if (seen.has(file)) return null
    seen.add(file)
    if (file.includes('/src/lib/chemistry/')) return path
    const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles
    for (const imported of imports) {
      const next = localSource(imported.fileName, file)
      if (next) {
        const found = visit(next, [...path, next])
        if (found) return found
      }
    }
    return null
  }
  return visit(resolve(start), [resolve(start)])
}

describe('module boundary: chemistry stays at application composition', () => {
  for (const file of CHEMISTRY_FREE) {
    it(`${file} cannot transitively load the chemical product module`, () => {
      expect(chemistryPath(file), `${file} must not reach chemistry through imports`).toBeNull()
    })
  }

  for (const file of CHEMISTRY_EXPECTED) {
    it(`${file} imports the chemistry module explicitly`, () => {
      expect(read(file)).toMatch(/from '@\/lib\/chemistry\//)
    })
  }

  it('core data contracts and queries contain no product fields', () => {
    for (const file of CHEMISTRY_FREE) {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
      const names: string[] = []
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node)) names.push(node.text)
        ts.forEachChild(node, visit)
      }
      visit(source)
      expect(names, `${file} has product-specific identifiers`).not.toContain('casNumber')
      expect(names, `${file} has product-specific identifiers`).not.toContain('chemicals')
    }
    const types = ts.createSourceFile('src/lib/types.ts', read('src/lib/types.ts'), ts.ScriptTarget.Latest, true)
    const core = types.statements.find((node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'CorePost')
    expect(core?.members.map((member) => member.name?.getText(types)), 'CorePost must stay product-free').not.toContain('chemicals')
  })

  it('moderation deletion reuses the product post-delete use case', () => {
    expect(read('src/app/api/admin/reports/[id]/resolve/route.ts')).toMatch(/deleteReportedPost/)
  })

  it('interaction routes use the interaction service, not the write service', () => {
    const src = read('src/app/api/posts/[code]/[action]/route.ts')
    expect(src).toMatch(/interaction\.service/)
    expect(src).not.toMatch(/post-write\.service/)
  })
})

describe('client navigation rule: preserve Next router history state', () => {
  // TimelineFeed's tab sync calls history.replaceState. Passing `null` as
  // the state wipes Next.js's router bookkeeping from the history entry;
  // back-navigation then arrives without a Next state, the router ignores
  // the popstate, and the PREVIOUS page's tree stays mounted at the wrong
  // URL (reproduced on WebKit + Chromium, fixed 2026-10-28 — see
  // docs/FEED-PERF.md). Pin the fix's shape against silent regression.
  it('TimelineFeed passes the existing history.state through replaceState', () => {
    const src = read('src/components/posts/TimelineFeed.tsx')
    expect(src).toMatch(/replaceState\(window\.history\.state/)
    expect(src).not.toMatch(/replaceState\(null/)
  })

  it('no client component wipes history state with replaceState(null)', () => {
    const offenders = [
      ...walkClientComponents(resolve('src')),
    ].filter((f) => /replaceState\(\s*null/.test(readFileSync(f, 'utf8')))
    expect(offenders, `these files call replaceState(null): ${offenders.join(', ')}`).toEqual([])
  })
})

describe('browse-state rules: identity-owned cache, overlays, scroll lifecycle', () => {
  // Feed refresh affordances must never occupy layout space: the pull
  // indicator grew an in-flow container height while pulling and accounted
  // for the measured pull-to-refresh CLS 0.061 (Chromium, 2026-10-28,
  // docs/FEED-PERF.md). Both it and the new-posts banner are fixed
  // overlays now — pin that shape against silent regression.
  it('pull indicator and new-posts banner are fixed overlays, not in-flow', () => {
    const src = read('src/components/posts/TimelineFeed.tsx')
    const overlays = src.match(/pointer-events-none fixed left-1\/2 top-16 z-40/g) ?? []
    expect(overlays.length, 'PullIndicator and NewPostsBanner must both be overlays').toBe(2)
    expect(src, 'no element may grow/shrink a layout height in TimelineFeed').not.toMatch(
      /style=\{\{\s*height/,
    )
  })

  it('every infinite list owns a scroll lifecycle in the identity browse state', () => {
    expect(read('src/components/posts/TimelineFeed.tsx')).toMatch(/useBrowseScroll\(tab \? `home:/)
    expect(read('src/components/posts/InfinitePostList.tsx')).toMatch(/useBrowseScroll\(basePath/)
  })

  it('each infinite-list instance keeps one key for its whole lifetime', () => {
    expect(read('src/components/posts/TimelineFeed.tsx')).toMatch(/TimelineFeedInner\s+key=\{tab\}/)
    expect(read('src/components/posts/InfinitePostList.tsx')).toMatch(/InfinitePostListInner\s+key=\{basePath\}/)
  })

  it('browse state is owned by identity at the app root and remounts on switch', () => {
    expect(read('src/components/Providers.tsx')).toMatch(/BrowseStateProvider identityKey=\{currentUser\?\.id \?\? 'anon'}/)
    expect(read('src/components/posts/BrowseStateProvider.tsx')).toMatch(/BrowseStateInner key=\{identityKey}/)
  })

  it('the remembered scroll position is consumed before the first save overwrites it', () => {
    const src = read('src/components/posts/BrowseStateProvider.tsx')
    const takeAt = src.indexOf('store.take(key)')
    const firstSaveAt = src.indexOf('store.save(key, window.scrollY)')
    expect(takeAt, 'take must exist').toBeGreaterThan(-1)
    expect(firstSaveAt, 'save must exist and come after the take').toBeGreaterThan(takeAt)
  })
})

describe('search query parametrization', () => {
  it('search.service.ts binds cursor parameters without SQL string interpolation', () => {
    const src = read('src/lib/services/search.service.ts')
    expect(src, 'no cursorDate interpolation').not.toContain("'${cursorDate}'")
    expect(src, 'no cursorId interpolation').not.toContain("'${cursorId}'")
    expect(src, 'no timestamptz literal interpolation').not.toMatch(/< \('\$\{[^}]+\}'::timestamptz/)
  })
})

describe('seo, tombstone, and config convergence invariants', () => {
  it('post detail has canonical URL, preserves 200 tombstone without noindex, and guards tombstone JSON-LD', () => {
    const src = read('src/app/(shell)/p/[code]/page.tsx')
    expect(src, 'canonical URL for active posts').toMatch(/alternates:\s*\{\s*canonical:\s*`\$\{site\.origin\}\/p\/\$\{code\}`/)
    expect(src, 'no claim that google naturally indexes tombstones').not.toContain('Google indexes the tombstone naturally')
    expect(src, 'no noindex on tombstone').not.toMatch(/deletedAt[\s\S]*?robots:\s*\{\s*index:\s*false/)
    expect(src, 'tombstone guards SocialMediaPosting JSON-LD').toMatch(/post\.deletedAt\s*\?\s*null\s*:/)
  })

  it('sitemap is sharded into bounded segment sitemaps and omits redirecting /search', () => {
    const src = read('src/app/sitemap.ts')
    expect(src, 'omits redirecting /search').not.toContain('/search')
    expect(read('src/app/(shell)/p/sitemap/[index]/route.ts'), 'post sitemap shard route exists').toContain('export async function GET')
    expect(read('src/app/(shell)/u/sitemap.ts'), 'user sitemap exists').toContain('export default async function sitemap')
    expect(read('src/app/(shell)/cas/sitemap.ts'), 'cas sitemap exists').toContain('export default async function sitemap')
    const robots = read('src/app/robots.ts')
    expect(robots, 'robots lists sharded sitemaps').toContain('/p/sitemap')
    expect(robots, 'robots lists sharded sitemaps').toContain('/u/sitemap.xml')
    expect(robots, 'robots lists sharded sitemaps').toContain('/cas/sitemap.xml')
  })

  it('nginx configuration and ecosystem templates do not drift or leak private host values', () => {
    const nginxTemplate = read('deploy/nginx.conf.template')
    expect(nginxTemplate, 'nginx template does not statically alias /llms.txt').not.toMatch(/location\s*=\s*\/llms\.txt/)
    expect(nginxTemplate, 'nginx preserves client IP header').toContain('proxy_set_header X-Real-IP $remote_addr;')
    expect(nginxTemplate, 'nginx preserves forwarded for header').toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;')

    const nginxConcrete = read('deploy/cas.cool.nginx.conf')
    expect(nginxConcrete, 'concrete nginx config does not statically alias /llms.txt').not.toMatch(/location\s*=\s*\/llms\.txt/)
    expect(nginxConcrete, 'nginx config contains no private deployment paths').not.toContain('/var/www/cas.cool')
    expect(nginxConcrete, 'nginx config contains no private cert paths').not.toContain('/etc/letsencrypt/live/cas.cool')

    const agents = read('AGENTS.md')
    expect(agents, 'AGENTS.md has no pm2 restart command').not.toContain('pm2 restart cascool')
    expect(agents, 'AGENTS.md has no hardcoded RAM limit').not.toContain('3.6GB RAM')

    const ecosystem = read('ecosystem.config.cjs')
    expect(ecosystem, 'ecosystem uses relative dirname instead of hardcoded /var/www').not.toContain("'/var/www/cas.cool'")
  })
})

function walkClientComponents(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkClientComponents(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}
