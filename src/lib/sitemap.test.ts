import { describe, expect, it } from 'vitest'
import { buildUrlsetXml, parseSitemapIndex, shardCountFor, shardSkip, SITEMAP_PAGE_SIZE } from './sitemap'

describe('sitemap shard boundaries', () => {
  it('shardCountFor crosses the 50,000 boundary correctly', () => {
    expect(SITEMAP_PAGE_SIZE).toBe(50_000)
    expect(shardCountFor(0)).toBe(1)
    expect(shardCountFor(1)).toBe(1)
    expect(shardCountFor(49_999)).toBe(1)
    expect(shardCountFor(50_000)).toBe(1) // exactly at the cap still fits one shard
    expect(shardCountFor(50_001)).toBe(2) // first crossing
    expect(shardCountFor(100_000)).toBe(2)
    expect(shardCountFor(100_001)).toBe(3) // second crossing
  })

  it('shardSkip rejects offsets that are not safe integers before any query runs', () => {
    expect(shardSkip(0)).toBe(0)
    expect(shardSkip(1)).toBe(50_000)
    expect(shardSkip(2)).toBe(100_000)
    // Number.MAX_SAFE_INTEGER × 50,000 overflows float64 precision — the
    // route must answer these with an empty urlset without querying.
    expect(shardSkip(9007199254740991)).toBeNull()
    // Still representable (9e12 < MAX_SAFE_INTEGER), but only meaningful
    // after the count-range check; past ~1.8e11 the product is no longer a
    // safe integer (2e11 × 5e4 = 1e16 > 2^53).
    expect(shardSkip(180_000_000)).toBe(9_000_000_000_000)
    expect(shardSkip(1_000_000_000)).toBe(50_000_000_000_000)
    expect(shardSkip(200_000_000_000)).toBeNull()
  })

  it('parseSitemapIndex accepts 0, 12 and 12.xml, rejects garbage and negatives', () => {
    expect(parseSitemapIndex('0')).toBe(0)
    expect(parseSitemapIndex('12')).toBe(12)
    expect(parseSitemapIndex('12.xml')).toBe(12)
    expect(parseSitemapIndex('9007199254740991.xml')).toBe(9007199254740991)
    expect(parseSitemapIndex('abc')).toBeNull()
    expect(parseSitemapIndex('-1')).toBeNull()
    expect(parseSitemapIndex('1.5')).toBeNull()
    expect(parseSitemapIndex('')).toBeNull()
  })

  it('buildUrlsetXml emits a valid empty document and escapes URLs', () => {
    expect(buildUrlsetXml([])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n',
    )
    const xml = buildUrlsetXml([
      {
        url: 'https://x.example/p/a&b<c',
        lastModified: new Date('2026-10-28T12:34:56.789Z'),
        changeFrequency: 'daily',
        priority: 0.7,
      },
    ])
    expect(xml).toContain('<loc>https://x.example/p/a&amp;b&lt;c</loc>')
    expect(xml).toContain('<lastmod>2026-10-28T12:34:56+00:00</lastmod>')
    expect(xml).toContain('<changefreq>daily</changefreq>')
    expect(xml).toContain('<priority>0.7</priority>')
  })
})
