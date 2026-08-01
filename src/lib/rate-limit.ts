/**
 * Unified rate limiter for all API routes.
 *
 * Token-bucket per identity key. Keys are either:
 *   - `key:<apiKeyId>` for API Key callers
 *   - `u:<userId>` for session callers
 *   - `ip:<address>` for anonymous callers
 *
 * Limits are per-route-tier, not global:
 *   read  → 120/min
 *   write → 60/min
 *   anon  → 60/min (pre-auth, applied by proxy.ts)
 */

interface Bucket {
  tokens: number
  updatedAt: number
}

const GC_INTERVAL_MS = 5 * 60_000
const STALE_MS = 10 * 60_000

// Single global map — all tiers share it, keyed by `${tier}:${identity}`.
const buckets = new Map<string, Bucket>()
let lastGc = Date.now()

function gc(): void {
  const now = Date.now()
  if (now - lastGc < GC_INTERVAL_MS) return
  lastGc = now
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt >= STALE_MS) buckets.delete(key)
  }
}

/**
 * Consume one token from the bucket.
 * Returns true if allowed, false if rate-limited.
 */
export function consume(
  identityKey: string,
  capacity: number,
  refillPerMinute: number,
): boolean {
  gc()
  const now = Date.now()
  const key = `${capacity}:${identityKey}`
  const existing = buckets.get(key)

  if (!existing) {
    buckets.set(key, { tokens: capacity - 1, updatedAt: now })
    return true
  }

  const refill = ((now - existing.updatedAt) * refillPerMinute) / 60_000
  existing.tokens = Math.min(capacity, existing.tokens + refill)
  existing.updatedAt = now

  if (existing.tokens < 1) return false
  existing.tokens -= 1
  return true
}

// ── Tier presets ──────────────────────────────────────────────

export const LIMITS = {
  read: { capacity: 120, perMinute: 120 },
  write: { capacity: 60, perMinute: 60 },
  anon: { capacity: 60, perMinute: 60 },
} as const

/** Build the rate-limit identity key from an AuthIdentity. */
export function rateLimitKey(identity: {
  method: string
  user: { id: string } | null
  apiKeyId?: string
}): string {
  if (identity.method === 'apikey' && identity.apiKeyId) return `key:${identity.apiKeyId}`
  if (identity.method === 'session' && identity.user) return `u:${identity.user.id}`
  return 'ip:anonymous'
}

/**
 * Check rate limit for a resolved identity.
 * Returns null if allowed, or a 429 Response.
 */
export function checkRateLimit(
  identity: {
    method: string
    user: { id: string } | null
    apiKeyId?: string
  },
  tier: keyof typeof LIMITS = 'read',
): Response | null {
  const limit = LIMITS[tier]
  const key = rateLimitKey(identity)
  if (!consume(key, limit.capacity, limit.perMinute)) {
    const retryAfter = Math.ceil(60 / limit.perMinute)
    return Response.json(
      { error: { code: 'rate_limited', message: 'Too many requests.' } },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(limit.capacity),
        },
      },
    )
  }
  return null
}
