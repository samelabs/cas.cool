import { describe, expect, it } from 'vitest'
import { extractCASNumber, jsonLdScript, sanitizeUsername } from './utils'

describe('extractCASNumber', () => {
  it('extracts a valid CAS number from prose', () => {
    expect(extractCASNumber('dissolve ethanol 64-17-5 carefully')).toBe('64-17-5')
    expect(extractCASNumber('formaldehyde 50-00-0 in water')).toBe('50-00-0')
  })

  it('rejects malformed patterns', () => {
    expect(extractCASNumber('bad 1234-56-78')).toBeNull() // check digit must be one digit
    expect(extractCASNumber('too short 1-23-4')).toBeNull()
    expect(extractCASNumber('no cas here')).toBeNull()
  })
})

describe('sanitizeUsername', () => {
  it('lowercases, strips invalid chars, caps at 20', () => {
    expect(sanitizeUsername('Alice-Test!')).toBe('alicetest')
    expect(sanitizeUsername('A'.repeat(30))).toHaveLength(20)
  })
})

describe('jsonLdScript', () => {
  it('escapes < and U+2028/2029 so content cannot break out of a script tag', () => {
    const out = jsonLdScript({ x: '</script><script>alert(1)</script>', y: 'a\u2028b\u2029c' })
    expect(out).not.toContain('<')
    expect(out).toContain('\\u003c')
    expect(out).toContain('\\u2028')
    expect(out).toContain('\\u2029')
  })
})
