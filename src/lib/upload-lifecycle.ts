/**
 * Upload asset lifecycle coordination (R5).
 *
 * ── One asset identity ───────────────────────────────────────────────
 * An upload reference is accepted ONLY in its canonical form:
 *   /uploads/<name>                 → public storage  (public/uploads)
 *   /api/media/verification/<name>  → private storage (private-uploads)
 * where <name> is a single path segment matching CANONICAL_UPLOAD_NAME
 * (no separators, no dots besides the one extension, no escapes). Because
 * the grammar admits exactly one spelling per physical file, the canonical
 * URL is simultaneously the storage location, the lock identity and the
 * database reference identity. Anything else (`/uploads/../uploads/x`,
 * `/uploads/./x`, encoded separators, query strings …) is NOT normalized —
 * it is rejected before any reference is written (400 `bad_request`).
 * `parseUploadUrl` is the single parser; reference writers, the
 * reference-counted cleanup, the outbox cleaner and the sweep all use it.
 *
 * ── Mutual exclusion ─────────────────────────────────────────────────
 * Reference writes (post images, avatar/banner, verification submissions)
 * and asset deletion (edit/delete cleanup, outbox cleanup, sweep) are
 * MUTUALLY EXCLUSIVE through a per-asset PostgreSQL advisory transaction
 * lock:
 *   - A reference write acquires the lock inside its own transaction and
 *     asserts the file EXISTS before writing the reference. If a deletion
 *     removed the file first, the write is rejected (409 asset_gone).
 *   - A deletion holds the same lock across the final reference check AND
 *     the unlink; a concurrent reference write blocks until the deletion
 *     commits and then observes the missing file.
 *
 * ── Lock resource and global order ───────────────────────────────────
 * The resource is the two-key advisory lock
 *   (UPLOAD_ASSET_LOCK_CLASS, hashtext(canonicalUrl))
 * Two-int4 advisory keys live in a lock space disjoint from single-bigint
 * keys (pg_locks objsubid 2 vs 1), so asset locks can never collide with
 * the Chemical admission locks (`hashtext('cascool:chemical:'||cas)::int8`,
 * single-key form) whatever the hash values are.
 *
 * Within the asset domain `hashtext` is 32-bit: distinct URLs can share a
 * resource, and sorting URLs does NOT sort resources. A multi-asset caller
 * therefore (same rule as the Chemical domain):
 *   1. computes the real resource key for every canonical URL in SQL and
 *      deduplicates by key (colliding/duplicate URLs → one resource);
 *   2. sorts the keys numerically — one global order over the resources;
 *   3. acquires each key in its own statement, in that order.
 * Every transaction acquires ALL of its asset locks in ONE call to
 * `lockUploadAssets`, before any other lock domain it touches afterwards
 * (Post row locks, Chemical advisory/row locks). Request-key arbitration
 * (createPost) precedes it but holds no resource another asset holder
 * waits on. Deletion transactions hold only the asset lock.
 */

import path from 'node:path'
import { stat } from 'node:fs/promises'
import { Prisma, type PrismaClient } from '@prisma/client'
import { PUBLIC_UPLOAD_DIR, PRIVATE_UPLOAD_DIR, VERIFICATION_MEDIA_PREFIX } from '@/lib/image'
import { PostServiceError } from '@/lib/services/post-core.service'

export type UploadStorage = 'public' | 'private'

/** A canonical upload asset: one spelling per physical file. */
export interface UploadAsset {
  storage: UploadStorage
  filename: string
  /** Canonical URL — the lock identity and the database reference identity. */
  url: string
}

/** Single path segment, one extension, no dots/separators/escapes. Every
 *  file the upload pipeline writes (`<uuid>.webp|gif`) matches. */
const CANONICAL_UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:webp|gif)$/

const PREFIX: Record<UploadStorage, string> = {
  public: '/uploads/',
  private: `${VERIFICATION_MEDIA_PREFIX}/`,
}

const DEFAULT_DIRS: Record<UploadStorage, string> = {
  public: PUBLIC_UPLOAD_DIR,
  private: PRIVATE_UPLOAD_DIR,
}

/** Lock-space class for upload assets (ASCII "UPLD"); see header. */
export const UPLOAD_ASSET_LOCK_CLASS = 0x55504c44

/** Build the canonical asset for a stored filename, or null if the name is
 *  not a canonical upload name. */
export function uploadAssetFromFile(storage: UploadStorage, filename: string): UploadAsset | null {
  if (!CANONICAL_UPLOAD_NAME.test(filename)) return null
  return { storage, filename, url: PREFIX[storage] + filename }
}

/** Parse a reference URL. Returns null for anything that is not EXACTLY a
 *  canonical upload URL (optionally restricted to one storage). */
export function parseUploadUrl(url: string, storage?: UploadStorage): UploadAsset | null {
  for (const s of ['public', 'private'] as const) {
    if (storage && storage !== s) continue
    if (url.startsWith(PREFIX[s])) return uploadAssetFromFile(s, url.slice(PREFIX[s].length))
  }
  return null
}

/** Physical location of an asset (dirs injectable for tests/sweep). */
export function uploadAssetPath(
  asset: UploadAsset,
  dirs: Record<UploadStorage, string> = DEFAULT_DIRS,
): string {
  return path.join(dirs[asset.storage], asset.filename)
}

/**
 * Acquire the advisory locks for a set of assets in the global resource
 * order (dedupe by real key → numeric sort → one statement per key).
 * Xact-scoped: released at commit/rollback. Must be called at most once per
 * transaction, with the transaction's complete asset set.
 */
export async function lockUploadAssets(
  tx: Prisma.TransactionClient | PrismaClient,
  assets: UploadAsset[],
): Promise<void> {
  const urls = [...new Set(assets.map((a) => a.url))]
  if (urls.length === 0) return
  const rows = await tx.$queryRaw<{ key: number }[]>`
    SELECT DISTINCT hashtext(u) AS key
    FROM unnest(ARRAY[${Prisma.join(urls)}]::text[]) AS u`
  const keys = rows.map((r) => Number(r.key)).sort((a, b) => a - b)
  for (const key of keys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${UPLOAD_ASSET_LOCK_CLASS}::int4, ${key}::int4)`
  }
}

/**
 * Lock + availability assertion for the reference-write side. Must be
 * called inside the transaction that writes the references, with the
 * transaction's complete asset set. Non-canonical URLs are rejected (400)
 * before any lock or reference write; missing files are rejected (409).
 */
export async function assertUploadAssetsAvailable(
  tx: Prisma.TransactionClient | PrismaClient,
  urls: string[],
  storage: UploadStorage = 'public',
): Promise<void> {
  const assets: UploadAsset[] = []
  for (const url of urls) {
    const asset = parseUploadUrl(url, storage)
    if (!asset) throw new PostServiceError(400, 'bad_request', 'Invalid image file.')
    assets.push(asset)
  }
  await lockUploadAssets(tx, assets)
  await assertLockedUploadAssetsExist(assets)
}

/** Availability check after the caller has acquired the complete asset set.
 *  Allows ownership validation under those same locks before checking files. */
export async function assertLockedUploadAssetsExist(assets: UploadAsset[]): Promise<void> {
  // Existence is checked while holding the locks: a concurrent deletion
  // cannot be running (it holds the same lock across check + unlink), and
  // a completed deletion is observed here as a missing file.
  for (const asset of assets) {
    let exists: boolean
    try {
      exists = (await stat(uploadAssetPath(asset))).isFile()
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      exists = false
    }
    if (!exists) {
      throw new PostServiceError(
        409,
        'asset_gone',
        'A referenced image is no longer available. Re-upload the image and retry.',
      )
    }
  }
}
