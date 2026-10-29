import { describe, expect, it } from 'vitest'
import { filterEditCas, filterValidCas, isValidCas, resolvePostChemicals } from './post-chemicals'

describe('isValidCas / CAS_FORMAT', () => {
  it('accepts well-formed CAS numbers, rejects malformed ones', () => {
    expect(isValidCas('64-17-5')).toBe(true)
    expect(isValidCas('50-00-0')).toBe(true)
    expect(isValidCas(' 64-17-5 ')).toBe(true) // trimmed
    expect(isValidCas('1234-56-78')).toBe(false) // check digit must be one digit
    expect(isValidCas('1-23-4')).toBe(false)
    expect(isValidCas('64-17-55')).toBe(false)
  })
})

describe('filterValidCas', () => {
  it('keeps only well-formed strings, trimmed', () => {
    expect(filterValidCas(['64-17-5', ' bad ', 42, null, '50-00-0', ' 7732-18-5 '])).toEqual([
      '64-17-5',
      '50-00-0',
      '7732-18-5',
    ])
  })
})

it('keeps the existing edit rule: untrimmed CAS values are rejected', () => {
  expect(filterEditCas(['64-17-5', ' 64-17-5 ', '50-00-0'])).toEqual(['64-17-5', '50-00-0'])
})

describe('resolvePostChemicals (manual + auto-extract merge)', () => {
  it('merges array input with content extraction, deduped in insertion order', () => {
    expect(
      resolvePostChemicals({ content: 'dissolve 64-17-5 in water', casNumbers: ['50-00-0', '64-17-5'] }),
    ).toEqual(['50-00-0', '64-17-5'])
  })

  it('accepts a comma-separated string body value', () => {
    expect(resolvePostChemicals({ content: 'plain text', casNumbers: '50-00-0,64-17-5' })).toEqual([
      '50-00-0',
      '64-17-5',
    ])
  })

  it('drops invalid manual entries but keeps a valid extraction', () => {
    expect(resolvePostChemicals({ content: 'uses 64-17-5 today', casNumbers: ['nonsense'] })).toEqual(['64-17-5'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(resolvePostChemicals({ content: 'no numbers here', casNumbers: null })).toEqual([])
    expect(resolvePostChemicals({ content: '', casNumbers: [] })).toEqual([])
  })
})
