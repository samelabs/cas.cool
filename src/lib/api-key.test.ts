import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateApiKey, hashApiKey } from './api-key'

describe('generateApiKey', () => {
  it('uses the configured prefix and stays within the auth length window (20–128)', () => {
    for (let i = 0; i < 20; i++) {
      const { rawKey } = generateApiKey('ak_')
      expect(rawKey.startsWith('ak_')).toBe(true)
      expect(rawKey.length).toBeGreaterThanOrEqual(20)
      expect(rawKey.length).toBeLessThanOrEqual(128)
      expect(rawKey.length).toBe('ak_'.length + 32)
    }
  })

  it('prefix is the first 8 chars of the random part (safe for UI display)', () => {
    const { rawKey, prefix } = generateApiKey('ak_')
    expect(prefix).toBe(rawKey.slice(3, 11))
    expect(rawKey.includes(prefix)).toBe(true)
  })

  it('keyHash is the SHA-256 hex digest of the raw key (the only stored secret)', () => {
    const { rawKey, keyHash } = generateApiKey('ak_')
    expect(keyHash).toBe(createHash('sha256').update(rawKey).digest('hex'))
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keys are unique', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateApiKey('ak_').rawKey))
    expect(seen.size).toBe(200)
  })
})

describe('hashApiKey', () => {
  it('is stable and hex-encoded', () => {
    expect(hashApiKey('ak_fixed')).toBe(createHash('sha256').update('ak_fixed').digest('hex'))
  })
})
