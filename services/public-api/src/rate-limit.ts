interface Bucket {
  tokens: number
  updatedAt: number
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private lastSweep = Date.now()

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
  ) {}

  consume(key: string): boolean {
    const now = Date.now()
    if (now - this.lastSweep >= 5 * 60_000) {
      this.lastSweep = now
      for (const [bucketKey, bucket] of this.buckets) {
        if (now - bucket.updatedAt >= 10 * 60_000) this.buckets.delete(bucketKey)
      }
    }

    const existing = this.buckets.get(key)
    if (!existing) {
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: now })
      return true
    }

    const refill = ((now - existing.updatedAt) * this.refillPerMinute) / 60_000
    existing.tokens = Math.min(this.capacity, existing.tokens + refill)
    existing.updatedAt = now
    if (existing.tokens < 1) return false
    existing.tokens -= 1
    return true
  }
}

export const unauthenticatedLimiter = new TokenBucketLimiter(120, 120)
export const readLimiter = new TokenBucketLimiter(120, 120)
export const writeLimiter = new TokenBucketLimiter(60, 60)
