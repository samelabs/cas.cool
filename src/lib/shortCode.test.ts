import { describe, expect, it } from 'vitest'
import { generateShortCode, postUrl } from './shortCode'

// Contract pin: 8 chars from the 54-char unambiguous alphabet (no 0/O/1/I/l).
const CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ]{8}$/

describe('generateShortCode', () => {
  it('produces 8-char codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateShortCode()).toMatch(CODE_RE)
    }
  })

  it('does not repeat across 1000 draws', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateShortCode()))
    expect(seen.size).toBe(1000)
  })
})

describe('postUrl', () => {
  it('builds /p/:code and falls back to empty code (never a UUID)', () => {
    expect(postUrl({ id: 'x', shortCode: 'Ab3xY9zK' })).toBe('/p/Ab3xY9zK')
    expect(postUrl({ id: 'x', shortCode: null })).toBe('/p/')
    expect(postUrl({ id: 'x' })).toBe('/p/')
  })
})
