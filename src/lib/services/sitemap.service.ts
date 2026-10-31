/**
 * Sitemap service — live-post counting and post-shard XML generation with
 * origin-side result reuse across two bounded tiers.
 *
 * Why a dedicated cache: the shard route (`src/app/(shell)/p/sitemap/[index]/
 * route.ts`) is a dynamic route handler. In the Next 16.4.3 production build
 * this segment renders dynamic (ƒ) and — measured on that build — every
 * request re-executed the handler; a bare `export const revalidate` never
 * engaged the ISR cache for it. (This is this route's observed behavior,
 * not a general claim about dynamic params.) With ~50,000 rows per shard
 * that meant a full COUNT + 50k-row query + ~7.5 MB XML assembly per hit.
 *
 * Reuse design:
 * - Tier 1 (memory): per-(origin, index) XML strings, 1 h TTL, byte- and
 *   entry-bounded LRU (48 MiB / 64 entries — roughly six full shards).
 *   Eviction from tier 1 loses nothing durable: tier 2 still holds the XML.
 * - Tier 2 (disk): the same XML published atomically (tmp + rename) under a
 *   regenerable cache root (`.next/cache/sitemap-shards/<origin-hash>/`,
 *   relocatable via SITEMAP_CACHE_DIR). Versioned filenames
 *   (`shard-<index>-<storedAtMs>.xml`) carry the generation stamp — freshness
 *   never depends on filesystem mtimes. Tier 2 is what lets the FULL shard
 *   working set be reused across sequential sweeps: a shard evicted from
 *   memory is re-served from disk without re-querying. Pruning is bounded:
 *   TTL-expired files, superseded versions of an index, orphaned tmp files
 *   and a hard file cap (oldest first).
 * - Generation: single-flight per key (concurrent cold requests coalesce
 *   onto one disk-read-or-generate task; the in-flight record lives until
 *   the disk publish — or its failure handling — completes, so an L1
 *   eviction mid-publish cannot trigger a duplicate generation). Each cold
 *   generation task runs under one of at most 2 parallel slots that spans
 *   rows → memory store → atomic disk publish → bounded cleanup and is
 *   released only after the publish finishes. Rows stream in 10k
 *   cursor-forward batches of the unchanged (createdAt DESC, id DESC)
 *   skip/take window — peak memory holds one batch plus the XML parts, not
 *   the full query result. A failed publish keeps the already-stored memory
 *   result servable; every slot/in-flight record is released in `finally`.
 * - Counting: the live-post count (same `deletedAt: null` rule as the row
 *   selection) refreshes at most once per 5 s. Cache hits NEVER block on it:
 *   a fresh count range-gates the hit (so shard removal still converges
 *   within the window), a stale one triggers a background refresh — with
 *   failure backoff, no periodic scanning — while the valid XML is served
 *   immediately. A count failure therefore never discards a cached result;
 *   only the miss path (which must range-gate before generating) awaits it.
 * - Freshness: results carry `ageSeconds` since their generation stamp, and
 *   the route emits it as the HTTP `Age` header, so downstream caches derive
 *   the REMAINING hour of the advertised freshness, not a fresh full hour.
 *   Cold responses compute it after the awaited publish, so the write wait
 *   counts as consumed time.
 * - Keys embed the `SiteConfig` origin (memory key + tier-2 directory hash):
 *   after an origin update revalidates that data cache, new keys miss and
 *   regenerate — the old domain is never served persistently.
 *
 * Accuracy semantics are unchanged from `src/lib/sitemap.ts`: each shard is
 * an independent snapshot; transient overlap/miss near boundaries while
 * writes are in flight converges once writes stop and windows expire
 * (shards 1 h TTL, count 5 s TTL, robots 1 h ISR).
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getSiteConfig } from '@/lib/site'
import {
  EMPTY_URLSET,
  formatUrlRow,
  joinUrlsetXml,
  shardCountFor,
  SITEMAP_PAGE_SIZE,
} from '@/lib/sitemap'

/** How long a generated shard XML is reused (matches the public cache-control window). */
const SHARD_TTL_MS = 60 * 60 * 1000
/** How long the live-post count is trusted before recounting. Short so a
 *  crossed 50k boundary converges quickly while counting stays bounded
 *  (≤12/min, and ≤12 attempts/min even under persistent failure) regardless
 *  of request rate. */
const COUNT_TTL_MS = 5 * 1000
/** Hard cap on retained in-memory shard XML bytes (~6 full 7.5 MB shards). */
const MAX_CACHED_BYTES = 48 * 1024 * 1024
/** Hard cap on retained in-memory shard entries (bounds sweep cost and stale-origin keys). */
const MAX_CACHED_ENTRIES = 64
/** Hard cap on live shard files retained on disk (oldest pruned first). */
const MAX_DISK_FILES = 64
/** Orphaned tmp publish files older than this are pruned. */
const TMP_MAX_AGE_MS = 10 * 60 * 1000
/** How many shard generations may run at once; others wait for a slot. */
const MAX_PARALLEL_GENERATIONS = 2
/** Row-batch size for streaming a shard out of the database. */
const FETCH_BATCH_ROWS = 10_000

/** One includable condition for both counting and row selection. */
const LIVE_POST_WHERE = { deletedAt: null }
const SHARD_ORDER_BY: Prisma.PostOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }]
const SHARD_SELECT = { id: true, shortCode: true, createdAt: true, updatedAt: true } as const

export type SitemapShardResult = {
  xml: string
  cache: 'hit' | 'disk' | 'miss' | 'empty'
  /** Seconds since this XML was generated (0 for empty); the route emits it as `Age`. */
  ageSeconds: number
}

const EMPTY_RESULT: SitemapShardResult = { xml: EMPTY_URLSET, cache: 'empty', ageSeconds: 0 }

interface CachedShard {
  xml: string
  bytes: number
  storedAt: number
  expiresAt: number
}

interface SitemapCacheState {
  shards: Map<string, CachedShard>
  shardBytes: number
  inflight: Map<string, Promise<SitemapShardResult>>
  count: { value: number; expiresAt: number } | null
  countInflight: Promise<number> | null
  /** Last time a count query was issued (success or failure) — failure backoff. */
  countAttemptedAt: number
  generationSlots: number
  generationWaiters: Array<() => void>
}

// Turbopack can re-instantiate modules per route segment; keep the cache on
// globalThis (same idiom as the prisma client in src/lib/db.ts) so the shard
// route and robots.txt genuinely share one instance.
const globalForSitemap = globalThis as unknown as { __sitemapShardCache?: SitemapCacheState }

function state(): SitemapCacheState {
  if (!globalForSitemap.__sitemapShardCache) {
    globalForSitemap.__sitemapShardCache = {
      shards: new Map(),
      shardBytes: 0,
      inflight: new Map(),
      count: null,
      countInflight: null,
      countAttemptedAt: 0,
      generationSlots: MAX_PARALLEL_GENERATIONS,
      generationWaiters: [],
    }
  }
  return globalForSitemap.__sitemapShardCache
}

/**
 * Live-post count, refreshed at most once per COUNT_TTL_MS and shared by
 * robots.txt and the shard route. Concurrent refreshes coalesce; the miss
 * path and robots await this directly, cache hits use the non-blocking
 * {@link refreshCountInBackground}.
 */
export async function getLivePostCount(): Promise<number> {
  const s = state()
  if (s.count && s.count.expiresAt > Date.now()) return s.count.value
  if (!s.countInflight) {
    s.countAttemptedAt = Date.now()
    s.countInflight = prisma.post
      .count({ where: LIVE_POST_WHERE })
      .then((value) => {
        s.count = { value, expiresAt: Date.now() + COUNT_TTL_MS }
        return value
      })
      .finally(() => {
        s.countInflight = null
      })
  }
  return s.countInflight
}

/** Range gate from the count cache alone — no DB access. `unknown` means the
 *  count window has lapsed and the caller should refresh in the background. */
function rangeGate(index: number): 'in' | 'out' | 'unknown' {
  const c = state().count
  if (c && c.expiresAt > Date.now()) return index < shardCountFor(c.value) ? 'in' : 'out'
  return 'unknown'
}

/**
 * Fire-and-forget count refresh for cache hits. Failures are logged, never
 * thrown and never discard a cached shard. Backed off to at most one attempt
 * per count window, so a persistently failing count cannot turn every hit
 * into a count attempt (and this never becomes a periodic scanner).
 */
function refreshCountInBackground(): void {
  const s = state()
  if (s.countInflight) return
  if (Date.now() - s.countAttemptedAt < COUNT_TTL_MS) return
  void getLivePostCount().catch((error) => {
    console.error('[Sitemap] live-post count refresh failed; cached shards keep serving:', error)
  })
}

/**
 * Post-sitemap shard XML for `index` (offset `skip` precomputed and validated
 * by the caller). Beyond-range indices return the empty urlset without
 * generating or caching anything.
 */
export async function getPostSitemapShard(index: number, skip: number): Promise<SitemapShardResult> {
  const s = state()
  const origin = await getSiteConfig().then((site) => site.origin)
  // Resolve the tier-2 root once per request so a read/write pair always
  // targets the same directory even if the env override changes mid-flight.
  const root = cacheRoot()
  const key = `${origin}|${index}`
  const now = Date.now()

  // Tier 1 — memory. Hits never touch the DB: a fresh count range-gates,
  // a stale one is refreshed in the background while the XML is served.
  const hit = s.shards.get(key)
  if (hit) {
    if (hit.expiresAt > now) {
      const gate = rangeGate(index)
      if (gate === 'out') return EMPTY_RESULT
      if (gate === 'unknown') refreshCountInBackground()
      s.shards.delete(key)
      s.shards.set(key, hit) // re-insert to mark LRU recency
      return { xml: hit.xml, cache: 'hit', ageSeconds: ageSeconds(hit.storedAt) }
    }
    s.shards.delete(key)
    s.shardBytes -= hit.bytes
  }

  // Single-flight covers the disk tier and generation alike: concurrent cold
  // requests coalesce onto one read-or-generate task. The check-and-set runs
  // synchronously, so it is atomic.
  const existing = s.inflight.get(key)
  if (existing) return existing

  const task = (async (): Promise<SitemapShardResult> => {
    const disk = await readDiskShard(root, origin, index)
    if (disk) {
      const gate = rangeGate(index)
      if (gate === 'out') return EMPTY_RESULT
      if (gate === 'unknown') refreshCountInBackground()
      storeShard(key, disk.xml, disk.storedAt)
      return { xml: disk.xml, cache: 'disk', ageSeconds: ageSeconds(disk.storedAt) }
    }
    // Miss: the range check needs the count; this path may hit the DB.
    const count = await getLivePostCount()
    if (index >= shardCountFor(count)) return EMPTY_RESULT

    // One generation slot spans the whole cold task — rows, memory store,
    // atomic disk publish and bounded cleanup — and is released only after
    // the publish finishes (or its failure handling completes). The memory
    // result is stored first, so a failed publish still leaves it servable.
    await acquireGenerationSlot()
    try {
      const xml = await generateShard(skip, origin)
      const storedAt = Date.now()
      storeShard(key, xml, storedAt)
      await publishDiskShard(root, origin, index, xml, storedAt)
      // Age counts the time actually consumed, including the publish wait.
      return { xml, cache: 'miss', ageSeconds: ageSeconds(storedAt) }
    } finally {
      releaseGenerationSlot()
    }
  })().finally(() => {
    // Keep the single-flight record until the publish (or its failure
    // handling) ends: an L1 eviction before the first publish completes
    // must coalesce onto this task, not start a duplicate generation.
    s.inflight.delete(key)
  })
  s.inflight.set(key, task)
  return task
}

/**
 * Drop retained in-memory shard XML and the cached count; the disk tier is
 * left intact (delete the cache directory for a full reset). In-flight
 * generations are not aborted; they finish and repopulate. Operational hook
 * for forced freshness — not part of the request path.
 */
export function resetSitemapCache(): void {
  const s = state()
  s.shards.clear()
  s.shardBytes = 0
  s.count = null
}

function ageSeconds(storedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - storedAt) / 1000))
}

/** Stream the shard's rows into XML. Runs inside a generation slot owned by
 *  the caller (the slot spans the publish too). */
async function generateShard(skip: number, origin: string): Promise<string> {
  const rows: string[] = []
  let scanned = 0
  let cursor: { createdAt: Date; id: string } | null = null
  while (scanned < SITEMAP_PAGE_SIZE) {
    const take = Math.min(FETCH_BATCH_ROWS, SITEMAP_PAGE_SIZE - scanned)
    // First batch positions the window with OFFSET; every later batch
    // seeks by cursor, so a deep shard pays the OFFSET scan once.
    const args: Prisma.PostFindManyArgs = cursor
      ? {
          where: LIVE_POST_WHERE,
          orderBy: SHARD_ORDER_BY,
          cursor: { createdAt: cursor.createdAt, id: cursor.id },
          skip: 1,
          take,
          select: SHARD_SELECT,
        }
      : {
          where: LIVE_POST_WHERE,
          orderBy: SHARD_ORDER_BY,
          skip,
          take,
          select: SHARD_SELECT,
        }
    const batch = await prisma.post.findMany(args)
    if (batch.length === 0) break
    scanned += batch.length
    for (const post of batch) {
      if (!post.shortCode) continue
      rows.push(
        formatUrlRow({
          url: `${origin}/p/${post.shortCode}`,
          lastModified: post.updatedAt ?? post.createdAt,
          changeFrequency: 'daily',
          priority: 0.7,
        }),
      )
    }
    if (batch.length < take) break
    const last = batch[batch.length - 1]
    cursor = { createdAt: last.createdAt, id: last.id }
  }
  return joinUrlsetXml(rows)
}

async function acquireGenerationSlot(): Promise<void> {
  const s = state()
  if (s.generationSlots > 0) {
    s.generationSlots -= 1
    return
  }
  await new Promise<void>((resolve) => s.generationWaiters.push(resolve))
}

function releaseGenerationSlot(): void {
  const s = state()
  const next = s.generationWaiters.shift()
  if (next) {
    // Hand the slot directly to the longest-waiting generation.
    next()
  } else {
    s.generationSlots += 1
  }
}

function storeShard(key: string, xml: string, storedAt: number): void {
  const s = state()
  const now = Date.now()
  // Opportunistic expiry sweep — bounded by MAX_CACHED_ENTRIES.
  for (const [k, entry] of s.shards) {
    if (entry.expiresAt <= now) {
      s.shards.delete(k)
      s.shardBytes -= entry.bytes
    }
  }
  const bytes = Buffer.byteLength(xml, 'utf8')
  if (bytes > MAX_CACHED_BYTES) return // degenerate entry the cap cannot hold
  s.shards.set(key, { xml, bytes, storedAt, expiresAt: storedAt + SHARD_TTL_MS })
  s.shardBytes += bytes
  // Evict least-recently-used entries until both caps hold; never evict the
  // entry that was just stored (tier 2 keeps evicted XML available anyway).
  while ((s.shardBytes > MAX_CACHED_BYTES || s.shards.size > MAX_CACHED_ENTRIES) && s.shards.size > 1) {
    const oldest = s.shards.keys().next().value
    if (oldest === undefined || oldest === key) break
    const entry = s.shards.get(oldest)
    if (!entry) break
    s.shards.delete(oldest)
    s.shardBytes -= entry.bytes
  }
}

// ─── Tier 2 — disk store ──────────────────────────────────────

/** Cache root for tier 2. Regenerable: safe to delete at any time. */
function cacheRoot(): string {
  return process.env.SITEMAP_CACHE_DIR ?? path.join(process.cwd(), '.next', 'cache', 'sitemap-shards')
}

function originDir(root: string, origin: string): string {
  const hash = createHash('sha256').update(origin).digest('hex').slice(0, 16)
  return path.join(root, hash)
}

function shardFileName(index: number, storedAt: number): string {
  return `shard-${index}-${storedAt}.xml`
}

/** Anchored — `shard-1-…` never matches `shard-11-…`. */
function shardFileRe(index: number): RegExp {
  return new RegExp(`^shard-${index}-(\\d{1,16})\\.xml$`)
}

async function readDiskShard(
  root: string,
  origin: string,
  index: number,
): Promise<{ xml: string; storedAt: number } | null> {
  const dir = originDir(root, origin)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null // no directory / not readable — treat as a miss
  }
  let storedAt = -1
  for (const name of names) {
    const m = shardFileRe(index).exec(name)
    if (m) storedAt = Math.max(storedAt, Number(m[1]))
  }
  if (storedAt < 0) return null
  if (storedAt + SHARD_TTL_MS <= Date.now()) return null // expired on disk
  try {
    const xml = await readFile(path.join(dir, shardFileName(index, storedAt)), 'utf8')
    return xml.length > 0 ? { xml, storedAt } : null
  } catch {
    return null // deleted between listing and read — treat as a miss
  }
}

/** Publish a shard atomically (tmp + rename), drop superseded versions and
 *  run the bounded cleanup. Failures are logged: tier 1 still serves. */
async function publishDiskShard(
  root: string,
  origin: string,
  index: number,
  xml: string,
  storedAt: number,
): Promise<void> {
  try {
    const dir = originDir(root, origin)
    await mkdir(dir, { recursive: true })
    const finalPath = path.join(dir, shardFileName(index, storedAt))
    const tmpPath = path.join(dir, `tmp-${storedAt}-${Math.random().toString(36).slice(2, 10)}.xml`)
    await writeFile(tmpPath, xml, 'utf8')
    await rename(tmpPath, finalPath)
    for (const name of await readdir(dir)) {
      if (name !== path.basename(finalPath) && shardFileRe(index).test(name)) {
        await unlink(path.join(dir, name)).catch(() => {})
      }
    }
    await pruneDiskCache(root)
  } catch (error) {
    console.error('[Sitemap] shard disk publish failed (memory tier still serves):', error)
  }
}

/** Bounded disk cleanup, run after publishes only (never on the read path):
 *  TTL-expired files, superseded versions per index, orphaned tmp files and
 *  a hard cap on live shard files (oldest first). Best effort throughout. */
async function pruneDiskCache(root: string): Promise<void> {
  const live = new Map<string, { file: string; storedAt: number }>()
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const file = path.join(dir, name)
        if (name.startsWith('tmp-')) {
          const ts = Number(/^tmp-(\d{1,16})-/.exec(name)?.[1] ?? 0)
          if (ts + TMP_MAX_AGE_MS <= Date.now()) await unlink(file).catch(() => {})
          continue
        }
        const m = /^shard-(\d+)-(\d{1,16})\.xml$/.exec(name)
        if (!m) continue
        const storedAt = Number(m[2])
        if (storedAt + SHARD_TTL_MS <= Date.now()) {
          await unlink(file).catch(() => {})
          continue
        }
        const k = `${entry.name}|${m[1]}`
        const prev = live.get(k)
        if (!prev) {
          live.set(k, { file, storedAt })
        } else if (prev.storedAt < storedAt) {
          await unlink(prev.file).catch(() => {})
          live.set(k, { file, storedAt })
        } else {
          await unlink(file).catch(() => {})
        }
      }
    }
    const candidates = [...live.values()].sort((a, b) => a.storedAt - b.storedAt)
    for (let i = 0; i < candidates.length - MAX_DISK_FILES; i++) {
      await unlink(candidates[i].file).catch(() => {})
    }
  } catch {
    /* best effort */
  }
}
