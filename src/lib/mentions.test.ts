import { describe, expect, it } from 'vitest'
import { extractMentionCandidates, MENTION_RE } from './mentions'

describe('MENTION_RE', () => {
  it('matches @username at start, after whitespace and after punctuation', () => {
    const hits = (s: string) => [...s.matchAll(MENTION_RE)].map((m) => m[1])
    expect(hits('hi @alice')).toEqual(['alice'])
    expect(hits('@bob start')).toEqual(['bob'])
    expect(hits('(@carol)[@dave];{@eve;,@frank')).toEqual(['carol', 'dave', 'eve', 'frank'])
  })

  it('does not match emails or mid-word @', () => {
    const hits = (s: string) => [...s.matchAll(MENTION_RE)].map((m) => m[1])
    expect(hits('mail me user@domain.com')).toEqual([])
    expect(hits('a@b')).toEqual([])
  })

  it('caps the username at 20 chars', () => {
    expect(extractMentionCandidates('@' + 'a'.repeat(30))).toEqual(['a'.repeat(20)])
  })
})

describe('extractMentionCandidates', () => {
  it('returns unique lowercase candidates in first-appearance order', () => {
    expect(extractMentionCandidates('@Alice hi @alice @Bob')).toEqual(['alice', 'bob'])
  })

  it('returns empty for text without mentions', () => {
    expect(extractMentionCandidates('no mentions here user@example.com')).toEqual([])
    expect(extractMentionCandidates('')).toEqual([])
  })

  it('extracts alongside URLs and CAS numbers', () => {
    const text = 'check https://x.com/@profile and 64-17-5 for @ethanol fan @Cas_User2'
    expect(extractMentionCandidates(text)).toEqual(['profile', 'ethanol', 'cas_user2'])
  })
})
