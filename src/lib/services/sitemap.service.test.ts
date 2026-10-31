/**
 * Sitemap service cache semantics — unit level with the DB and site config
 * mocked and tier 2 on a throwaway temp directory: hot reuse, TTL expiry,
 * count window, single-flight coalescing, bounded parallel generation, error
 * recovery, beyond-range behavior, origin keying, LRU eviction into the disk
 * tier, non-blocking count refresh for hits, failure backoff and Age.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  prisma: {
    post: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

vi.mock('@/lib/site', () => ({
  getSiteConfig: vi.fn(),
}))

// Test-layer write barrier for the tier-2 publish: when armed, every
// writeFile waits on the gate (or fails); writeCalls counts attempts.
const diskGate = vi.hoisted(() => ({ wait: null as null | Promise<void>, fail: false }))
const writeCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:fs/promises', async (actual) => {
  const real = (await actual()) as typeof import('node:fs/promises')
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      writeCalls.count += 1
      if (diskGate.wait) await diskGate.wait
      if (diskGate.fail) throw new Error('disk full')
      return real.writeFile(...args)
    },
  }
})

import { prisma } from '@/lib/db'
import { getSiteConfig } from '@/lib/site'
import {
  getLivePostCount,
  getPostSitemapShard,
  resetSitemapCache,
} from './sitemap.service'

const postCount = prisma.post.count as ReturnType<typeof vi.fn>
const findMany = prisma.post.findMany as ReturnType<typeof vi.fn>
const siteConfig = getSiteConfig as ReturnType<typeof vi.fn>

function row(id: string, shortCode: string, createdAt: Date) {
  return { id, shortCode, createdAt, updatedAt: null }
}

/** One short first batch (< take) so every generation is a single findMany call. */
function serveRows(rows: ReturnType<typeof row>[]) {
  findMany.mockImplementation(async () => rows)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait until tier 2 holds `n` shard files (publish is fire-and-forget).
 *  Iteration-bounded: the fake clock is frozen, so a wall-clock deadline
 *  would never trigger. */
async function waitForDiskFiles(n: number, maxPolls = 150): Promise<void> {
  const dir = path.join(
    process.env.SITEMAP_CACHE_DIR!,
    createHash('sha256').update('https://cas.example').digest('hex').slice(0, 16),
  )
  for (let i = 0; i < maxPolls; i++) {
    try {
      const files = (await readdir(dir)).filter((f) => f.startsWith('shard-'))
      if (files.length >= n) return
    } catch {
      /* dir not created yet */
    }
    await sleep(20)
  }
  throw new Error(`tier 2 did not reach ${n} shard files within ${maxPolls} polls`)
}

let cacheDir: string

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
  vi.resetAllMocks()
  resetSitemapCache()
  diskGate.wait = null
  diskGate.fail = false
  writeCalls.count = 0
  cacheDir = await mkdtemp(path.join(tmpdir(), 'sitemap-cache-'))
  process.env.SITEMAP_CACHE_DIR = cacheDir
  postCount.mockResolvedValue(2)
  siteConfig.mockResolvedValue({ origin: 'https://cas.example' })
})

afterEach(async () => {
  vi.useRealTimers()
  delete process.env.SITEMAP_CACHE_DIR
  // Fire-and-forget tier-2 publishes may still be mid-flight; let them
  // settle, then remove with retries (ENOTEMPTY races lose their sting).
  await sleep(100)
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('shard result reuse', () => {
  it('serves a hot shard from memory without re-querying, and expires after the TTL in both tiers', async () => {
    serveRows([row('id1', 'aaaaaaaa', new Date('2026-10-01T00:00:00Z'))])
    const first = await getPostSitemapShard(0, 0)
    expect(first.cache).toBe('miss')
    expect(first.ageSeconds).toBe(0)
    expect(first.xml).toContain('<loc>https://cas.example/p/aaaaaaaa</loc>')

    const second = await getPostSitemapShard(0, 0)
    expect(second.cache).toBe('hit')
    expect(second.xml).toBe(first.xml)
    expect(second.ageSeconds).toBe(0)
    expect(findMany).toHaveBeenCalledTimes(1)

    // Past the 1h TTL both the memory entry and the disk file are expired:
    // the shard regenerates.
    vi.setSystemTime(new Date('2026-10-01T02:00:01Z'))
    const third = await getPostSitemapShard(0, 0)
    expect(third.cache).toBe('miss')
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('re-serves memory-evicted shards from the disk tier without re-querying', async () => {
    // Seven full-size shards (~7.2 MB of XML each) overflow the 48 MiB
    // memory tier, so the oldest is evicted from memory — while the disk
    // tier (capped at 64 files) keeps the whole working set.
    postCount.mockResolvedValue(7 * 50_000)
    const bigRows = Array.from({ length: 50_000 }, (_, i) =>
      row(`id${i}`, String(i).padStart(8, '0'), new Date('2026-09-30T00:00:00Z')),
    )
    serveRows(bigRows)
    for (let i = 0; i < 7; i++) {
      await getPostSitemapShard(i, i * 50_000)
    }
    expect(findMany).toHaveBeenCalledTimes(7)
    await waitForDiskFiles(7)

    // Shard 0 was evicted from memory by the byte cap; requesting it again
    // must reuse the disk copy, not regenerate.
    const again = await getPostSitemapShard(0, 0)
    expect(again.cache).toBe('disk')
    expect(again.xml).toContain('/p/00000000')
    expect(findMany).toHaveBeenCalledTimes(7)

    // Even after dropping all memory state, the disk tier still serves.
    resetSitemapCache()
    const afterReset = await getPostSitemapShard(3, 150_000)
    expect(afterReset.cache).toBe('disk')
    expect(findMany).toHaveBeenCalledTimes(7)
  })

  it('coalesces concurrent cold requests for the same shard into one generation', async () => {
    let release!: (rows: ReturnType<typeof row>[]) => void
    findMany.mockImplementation(
      () => new Promise((resolve) => { release = resolve }),
    )
    const pending = Promise.all([
      getPostSitemapShard(0, 0),
      getPostSitemapShard(0, 0),
      getPostSitemapShard(0, 0),
    ])
    // Let the generation start (past the async disk read) before releasing.
    for (let i = 0; i < 200 && findMany.mock.calls.length === 0; i++) {
      await sleep(5)
    }
    expect(findMany).toHaveBeenCalledTimes(1)
    release([row('id1', 'aaaaaaaa', new Date('2026-10-01T00:00:00Z'))])
    const results = await pending
    expect(findMany).toHaveBeenCalledTimes(1)
    for (const r of results) expect(r.xml).toBe(results[0].xml)
  })

  it('bounds parallel generation across different shards', async () => {
    postCount.mockResolvedValue(5 * 50_000)
    let active = 0
    let maxActive = 0
    findMany.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(20)
      active -= 1
      return [] // empty batch → shard completes without rows
    })
    await Promise.all([
      getPostSitemapShard(0, 0),
      getPostSitemapShard(1, 50_000),
      getPostSitemapShard(2, 100_000),
      getPostSitemapShard(3, 150_000),
      getPostSitemapShard(4, 200_000),
    ])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('recovers after a failed generation: the failed request rejects, the next retries', async () => {
    findMany.mockRejectedValueOnce(new Error('db down'))
    await expect(getPostSitemapShard(0, 0)).rejects.toThrow('db down')
    // In-flight record was released — a retry regenerates and succeeds.
    serveRows([row('id1', 'aaaaaaaa', new Date('2026-10-01T00:00:00Z'))])
    const retry = await getPostSitemapShard(0, 0)
    expect(retry.cache).toBe('miss')
    expect(retry.xml).toContain('/p/aaaaaaaa')
  })

  it('answers beyond-range indices with the empty urlset without querying or caching', async () => {
    const result = await getPostSitemapShard(5, 250_000)
    expect(result.cache).toBe('empty')
    expect(result.ageSeconds).toBe(0)
    expect(result.xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n',
    )
    expect(findMany).not.toHaveBeenCalled()
    await getPostSitemapShard(5, 250_000)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('keys the cache by site origin — a new origin regenerates instead of serving the old domain', async () => {
    serveRows([row('id1', 'aaaaaaaa', new Date('2026-10-01T00:00:00Z'))])
    const before = await getPostSitemapShard(0, 0)
    expect(before.xml).toContain('https://cas.example/p/aaaaaaaa')

    siteConfig.mockResolvedValue({ origin: 'https://rebranded.example' })
    const after = await getPostSitemapShard(0, 0)
    expect(after.cache).toBe('miss')
    expect(after.xml).toContain('https://rebranded.example/p/aaaaaaaa')
    expect(after.xml).not.toContain('cas.example')
  })

  it('gates a cached shard to empty once a fresh count puts its index out of range (shrink)', async () => {
    postCount.mockResolvedValue(60_000) // 2 shards: 0 and 1 in range
    serveRows([row('id1', 'bbbbbbbb', new Date('2026-10-01T00:00:00Z'))])
    expect((await getPostSitemapShard(1, 50_000)).cache).toBe('miss')

    // Refresh the count (blocking) to a value with only one shard.
    vi.setSystemTime(new Date(Date.now() + 6_000))
    postCount.mockResolvedValue(2)
    expect(await getLivePostCount()).toBe(2)

    // The cached XML is still valid, but the fresh range gate wins.
    const gated = await getPostSitemapShard(1, 50_000)
    expect(gated.cache).toBe('empty')
    expect(gated.xml).not.toContain('/p/bbbbbbbb')
  })
})

describe('cold task publish lifecycle', () => {
  it('holds each generation slot through the disk publish — slow writes bound cold tasks to 2', async () => {
    postCount.mockResolvedValue(5 * 50_000)
    serveRows([])
    let releaseWrites!: () => void
    diskGate.wait = new Promise((resolve) => { releaseWrites = resolve })

    const pending = [0, 1, 2, 3, 4].map((i) => getPostSitemapShard(i, i * 50_000))
    // Two slots → exactly two cold tasks may generate; the rest must wait
    // for a slot that is only released after the publish completes.
    for (let i = 0; i < 400 && findMany.mock.calls.length < 2; i++) await sleep(5)
    await sleep(150) // any slot leak would surface as extra generations
    expect(findMany.mock.calls.length).toBe(2)
    expect(writeCalls.count).toBe(2)

    releaseWrites()
    const results = await Promise.all(pending)
    expect(findMany.mock.calls.length).toBe(5)
    expect(writeCalls.count).toBe(5)
    for (const r of results) expect(r.cache).toBe('miss')
  })

  it('coalesces a same-key request arriving after L1 eviction but before the first publish completes', async () => {
    serveRows([row('id1', 'aaaaaaaa', new Date('2026-10-01T00:00:00Z'))])
    let releaseWrite!: () => void
    diskGate.wait = new Promise((resolve) => { releaseWrite = resolve })

    const first = getPostSitemapShard(0, 0)
    for (let i = 0; i < 400 && writeCalls.count === 0; i++) await sleep(5)
    expect(findMany.mock.calls.length).toBe(1) // generation done, publish pending

    // Harshest L1 eviction (all memory state dropped) while the publish is
    // still in flight: the next request must join the running task.
    resetSitemapCache()
    const second = getPostSitemapShard(0, 0)
    releaseWrite()
    const [a, b] = await Promise.all([first, second])
    expect(findMany.mock.calls.length).toBe(1) // no duplicate generation
    expect(b.xml).toBe(a.xml)
    expect(b.cache).toBe('miss')
  })

  it('keeps the memory result servable and releases slot and single-flight after a failed publish', async () => {
    postCount.mockResolvedValue(3 * 50_000)
    serveRows([row('id1', 'aaaaaaaa', new Date('2026-10-01T00:00:00Z'))])
    diskGate.fail = true

    const failed = await getPostSitemapShard(0, 0)
    expect(failed.cache).toBe('miss') // response served from the stored memory result
    expect(failed.xml).toContain('/p/aaaaaaaa')
    const warmed = await getPostSitemapShard(0, 0)
    expect(warmed.cache).toBe('hit') // memory tier kept serving despite the disk failure

    // The single-flight record was released: after dropping memory state the
    // shard regenerates (no disk copy exists) instead of hanging on it.
    resetSitemapCache()
    diskGate.fail = false
    const retry = await getPostSitemapShard(0, 0)
    expect(retry.cache).toBe('miss')
    expect(findMany.mock.calls.length).toBe(2)

    // The generation slot was released too: two fresh cold tasks (gated
    // writes) must BOTH reach their publish, which needs both slots.
    let releaseBoth!: () => void
    diskGate.wait = new Promise((resolve) => { releaseBoth = resolve })
    const pending = [getPostSitemapShard(1, 50_000), getPostSitemapShard(2, 100_000)]
    for (let i = 0; i < 400 && writeCalls.count < 2; i++) await sleep(5)
    expect(writeCalls.count).toBe(2)
    releaseBoth()
    const results = await Promise.all(pending)
    for (const r of results) expect(r.cache).toBe('miss')
  })
})

describe('count never blocks or discards hot shards', () => {
  it('serves a memory hit while the count window is expired and the recount is slow', async () => {
    serveRows([row('id1', 'aaaaaaaa', new Date('2026-10-01T00:00:00Z'))])
    await getPostSitemapShard(0, 0) // populates the count and the shard

    vi.setSystemTime(new Date(Date.now() + 6_000)) // count window lapsed, shard still fresh
    let releaseCount!: (n: number) => void
    postCount.mockImplementation(() => new Promise((resolve) => { releaseCount = resolve }))
    const hit = await getPostSitemapShard(0, 0)
    expect(hit.cache).toBe('hit') // resolved without awaiting the recount
    expect(hit.xml).toContain('/p/aaaaaaaa')

    releaseCount(9)
    await Promise.resolve()
    expect(postCount).toHaveBeenCalledTimes(2) // background refresh ran
    expect(await getLivePostCount()).toBe(9) // and its result is cached
  })

  it('keeps serving cached shards while background recounts fail, with bounded retries', async () => {
    serveRows([row('id1', 'aaaaaaaa', new Date('2026-10-01T00:00:00Z'))])
    await getPostSitemapShard(0, 0)
    vi.setSystemTime(new Date(Date.now() + 6_000))

    postCount.mockRejectedValue(new Error('count down'))
    const first = await getPostSitemapShard(0, 0)
    expect(first.cache).toBe('hit') // failure did not discard the result
    await Promise.resolve()
    await Promise.resolve()
    expect(postCount).toHaveBeenCalledTimes(2) // one background attempt

    // Within the backoff window, further hits do not spam count attempts.
    const second = await getPostSitemapShard(0, 0)
    expect(second.cache).toBe('hit')
    expect(postCount).toHaveBeenCalledTimes(2)

    // After the backoff window a hit triggers exactly one more attempt.
    vi.setSystemTime(new Date(Date.now() + 6_000))
    const third = await getPostSitemapShard(0, 0)
    expect(third.cache).toBe('hit')
    expect(postCount).toHaveBeenCalledTimes(3)
  })
})

describe('Age reflects consumed source freshness', () => {
  it('reports the seconds consumed at the source so the remaining hour is what downstream gets', async () => {
    serveRows([row('id1', 'aaaaaaaa', new Date('2026-10-01T00:00:00Z'))])
    await getPostSitemapShard(0, 0) // generated at T0
    await waitForDiskFiles(1) // tier-2 copy must exist before the reset below

    vi.setSystemTime(new Date(Date.now() + 3_590 * 1000)) // 10s before expiry
    const nearExpiry = await getPostSitemapShard(0, 0)
    expect(nearExpiry.cache).toBe('hit')
    expect(nearExpiry.ageSeconds).toBe(3_590) // downstream freshness: 3600 - 3590 = 10s

    // The same stamp is carried through the disk tier after a memory reset.
    resetSitemapCache()
    const fromDisk = await getPostSitemapShard(0, 0)
    expect(fromDisk.cache).toBe('disk')
    expect(fromDisk.ageSeconds).toBe(3_590)
  })
})

describe('live-post count window', () => {
  it('counts once per window and coalesces concurrent recounts', async () => {
    let release!: (n: number) => void
    postCount.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const pending = Promise.all([getLivePostCount(), getLivePostCount()])
    release(7)
    expect(await pending).toEqual([7, 7])
    expect(postCount).toHaveBeenCalledTimes(1)

    expect(await getLivePostCount()).toBe(7)
    expect(postCount).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(Date.now() + 5_500))
    postCount.mockResolvedValue(9)
    expect(await getLivePostCount()).toBe(9)
    expect(postCount).toHaveBeenCalledTimes(2)
  })

  it('retries after a failed count', async () => {
    postCount.mockRejectedValueOnce(new Error('db down'))
    await expect(getLivePostCount()).rejects.toThrow('db down')
    postCount.mockResolvedValue(3)
    expect(await getLivePostCount()).toBe(3)
  })
})
