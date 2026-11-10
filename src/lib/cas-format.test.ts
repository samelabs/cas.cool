import { describe, it, expect } from 'vitest'
import { isValidCasFormat, isValidCasChecksum, isValidCasNumber } from './cas-format'

describe('CAS format + checksum', () => {
  it('known real CAS numbers pass fully', () => {
    expect(isValidCasNumber('50-00-0')).toBe(true) // formaldehyde
    expect(isValidCasNumber('64-17-5')).toBe(true) // ethanol
    expect(isValidCasNumber('7732-18-5')).toBe(true) // water
    expect(isValidCasNumber('9002-86-2')).toBe(true) // PVC
  })

  it('well-formed but wrong check digit is rejected', () => {
    expect(isValidCasNumber('12-34-5')).toBe(false) // computed check is 0
    expect(isValidCasNumber('50-00-1')).toBe(false) // real number, wrong check
  })

  it('format gate rejects malformed input', () => {
    expect(isValidCasNumber('5000-0')).toBe(false)
    expect(isValidCasNumber('50-00')).toBe(false)
    expect(isValidCasNumber('50-000-0')).toBe(false) // middle group must be 2 digits
    expect(isValidCasNumber('abc-00-0')).toBe(false)
    expect(isValidCasNumber('')).toBe(false)
  })

  it('surrounding whitespace is trimmed', () => {
    expect(isValidCasNumber('  64-17-5  ')).toBe(true)
  })

  it('longest form (7-2-1) validates', () => {
    // 1234567-89-5: 1×9+2×8+3×7+4×6+5×5+6×4+7×3+8×2+9×1 = 165 → check 5
    expect(isValidCasChecksum('1234567-89-5')).toBe(true)
    expect(isValidCasNumber('1234567-89-5')).toBe(true)
  })

  it('format-only helper stays permissive (post-attach parity)', () => {
    expect(isValidCasFormat('12-34-5')).toBe(true)
    expect(isValidCasChecksum('50-00-0')).toBe(true)
  })
})
