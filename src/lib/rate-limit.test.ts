import { describe, expect, it, vi } from 'vitest'
import { checkRateLimit, consume, LIMITS, rateLimitKey } from './rate-limit'

describe('consume (token bucket)', () => {
  it('allows up to capacity requests, then rejects', () => {
    const key = 'unit-capacity'
    expect(consume(key, 3, 3)).toBe(true)
    expect(consume(key, 3, 3)).toBe(true)
    expect(consume(key, 3, 3)).toBe(true)
    expect(consume(key, 3, 3)).toBe(false)
  })

  it('refills continuously at the per-minute rate', () => {
    vi.useFakeTimers()
    try {
      const key = 'unit-refill'
      consume(key, 3, 3)
      consume(key, 3, 3)
      consume(key, 3, 3)
      expect(consume(key, 3, 3)).toBe(false)
      vi.advanceTimersByTime(20_000) // 20s at 3/min → exactly one token
      expect(consume(key, 3, 3)).toBe(true)
      expect(consume(key, 3, 3)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps refill at capacity', () => {
    vi.useFakeTimers()
    try {
      const key = 'unit-cap'
      consume(key, 2, 2)
      consume(key, 2, 2)
      vi.advanceTimersByTime(10 * 60_000) // long idle — refill capped, not 20 tokens
      expect(consume(key, 2, 2)).toBe(true)
      expect(consume(key, 2, 2)).toBe(true)
      expect(consume(key, 2, 2)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('rateLimitKey (identity precedence)', () => {
  it('prefers apikey, then session user, then IP', () => {
    expect(rateLimitKey({ method: 'apikey', user: { id: 'u' }, apiKeyId: 'k1' })).toBe('key:k1')
    expect(rateLimitKey({ method: 'session', user: { id: 'u1' } })).toBe('u:u1')
    expect(rateLimitKey({ method: 'anonymous', user: null, ip: '1.2.3.4' })).toBe('ip:1.2.3.4')
    expect(rateLimitKey({ method: 'anonymous', user: null })).toBe('ip:unknown')
  })
})

describe('checkRateLimit', () => {
  it('returns null within the write tier, then a 429 with Retry-After', async () => {
    const identity = { method: 'apikey' as const, user: { id: 'u' }, apiKeyId: 'unit-check' }
    for (let i = 0; i < LIMITS.write.capacity; i++) {
      expect(checkRateLimit(identity, 'write')).toBeNull()
    }
    const res = checkRateLimit(identity, 'write')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(429)
    expect(res!.headers.get('Retry-After')).toBe('1')
    expect(res!.headers.get('X-RateLimit-Limit')).toBe(String(LIMITS.write.capacity))
    const body = (await res!.json()) as { error: { code: string } }
    expect(body.error.code).toBe('rate_limited')
  })
})

// ── Exact-math coverage on the real tier numbers (controlled clock) ──
// The integration burst test can only bound refill from wall-clock elapsed
// time; these pin the precise boundaries of the deployed tiers.

describe('exact refill mathematics on deployed tiers', () => {
  it('write tier 60/min: 999ms does not refill a token, 1000ms does', () => {
    vi.useFakeTimers()
    try {
      const key = 'exact-write'
      const { capacity, perMinute } = LIMITS.write
      for (let i = 0; i < capacity; i++) expect(consume(key, capacity, perMinute)).toBe(true)

      vi.advanceTimersByTime(999)
      expect(consume(key, capacity, perMinute)).toBe(false) // 0.999 < 1

      vi.advanceTimersByTime(1)
      expect(consume(key, capacity, perMinute)).toBe(true) // exactly 1.0
      expect(consume(key, capacity, perMinute)).toBe(false) // drained to 0
    } finally {
      vi.useRealTimers()
    }
  })

  it('a denied probe records elapsed time but never resets token accrual', () => {
    vi.useFakeTimers()
    try {
      const key = 'exact-denied-accrual'
      const { capacity, perMinute } = LIMITS.write
      for (let i = 0; i < capacity; i++) expect(consume(key, capacity, perMinute)).toBe(true)

      vi.advanceTimersByTime(500)
      expect(consume(key, capacity, perMinute)).toBe(false) // 0.5 token
      vi.advanceTimersByTime(500)
      // Denial updated `updatedAt`, but the second half-second still adds
      // its half token → exactly 1.0 total.
      expect(consume(key, capacity, perMinute)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('read tier 120/min: 15s refills exactly 30 tokens (2/s, fractional accrual)', () => {
    vi.useFakeTimers()
    try {
      const key = 'exact-read'
      const { capacity, perMinute } = LIMITS.read
      for (let i = 0; i < capacity; i++) expect(consume(key, capacity, perMinute)).toBe(true)

      vi.advanceTimersByTime(15_000)
      for (let i = 0; i < 30; i++) expect(consume(key, capacity, perMinute)).toBe(true)
      expect(consume(key, capacity, perMinute)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('idle bucket never exceeds burst capacity (capped, not minutes×rate)', () => {
    vi.useFakeTimers()
    try {
      const key = 'exact-idle-cap'
      const { capacity, perMinute } = LIMITS.write
      for (let i = 0; i < capacity; i++) expect(consume(key, capacity, perMinute)).toBe(true)
      expect(consume(key, capacity, perMinute)).toBe(false)

      vi.advanceTimersByTime(10 * 60_000)
      for (let i = 0; i < capacity; i++) expect(consume(key, capacity, perMinute)).toBe(true)
      expect(consume(key, capacity, perMinute)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('stale bucket garbage collection', () => {
  it('evicts buckets idle ≥ 10min on the next gc-triggering consume', () => {
    vi.useFakeTimers()
    try {
      const drained = 'gc-drained'
      const { capacity, perMinute } = LIMITS.write
      for (let i = 0; i < capacity; i++) expect(consume(drained, capacity, perMinute)).toBe(true)
      expect(consume(drained, capacity, perMinute)).toBe(false)

      // 11 idle minutes (> 10min stale window, > 5min gc interval). A
      // consume on any other identity runs gc() over the shared map; the
      // drained stale bucket is evicted, so the identity starts fresh at
      // full capacity.
      vi.advanceTimersByTime(11 * 60_000)
      expect(consume('gc-bystander', capacity, perMinute)).toBe(true)

      for (let i = 0; i < capacity; i++) expect(consume(drained, capacity, perMinute)).toBe(true)
      expect(consume(drained, capacity, perMinute)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps buckets younger than the stale window (cap still applies)', () => {
    vi.useFakeTimers()
    try {
      const key = 'gc-young'
      const { capacity, perMinute } = LIMITS.write
      for (let i = 0; i < capacity; i++) expect(consume(key, capacity, perMinute)).toBe(true)

      vi.advanceTimersByTime(9 * 60_000) // < 10min stale window
      expect(consume('gc-bystander2', capacity, perMinute)).toBe(true) // runs gc(), evicts nothing

      // Bucket kept → the 9 idle minutes are capped at capacity, not 540.
      for (let i = 0; i < capacity; i++) expect(consume(key, capacity, perMinute)).toBe(true)
      expect(consume(key, capacity, perMinute)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('deployed tier preset numbers', () => {
  it('pins read/write/anon capacities and refill rates', () => {
    expect(LIMITS.read).toEqual({ capacity: 120, perMinute: 120 })
    expect(LIMITS.write).toEqual({ capacity: 60, perMinute: 60 })
    expect(LIMITS.anon).toEqual({ capacity: 60, perMinute: 60 })
  })
})
