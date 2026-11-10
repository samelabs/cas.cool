import { describe, it, expect } from 'vitest'
import { cjkBigramTokens } from '@/lib/cjk-bigrams'

describe('cjkBigramTokens (must mirror cas_content_bigrams in DB)', () => {
  it('2-char word → single bigram', () => {
    expect(cjkBigramTokens('乙醇')).toEqual(['乙醇'])
  })

  it('3-char word → two adjacent bigrams', () => {
    expect(cjkBigramTokens('苯乙烯')).toEqual(['苯乙', '乙烯'])
  })

  it('multiple CJK runs are split independently (non-CJK breaks the run)', () => {
    expect(cjkBigramTokens('苯乙醇-C4H8')).toEqual(['苯乙', '乙醇'])
  })

  it('mixed with CJK between ASCII: runs extracted separately', () => {
    expect(cjkBigramTokens('今天合成苯酚了')).toEqual(['今天', '天合', '合成', '成苯', '苯酚', '酚了'])
  })

  it('single CJK char → no bigram from it', () => {
    expect(cjkBigramTokens('苯')).toBeNull()
    expect(cjkBigramTokens('苯a')).toBeNull()
  })

  it('pure ASCII / digits → null (plain ILIKE path)', () => {
    expect(cjkBigramTokens('styrene')).toBeNull()
    expect(cjkBigramTokens('50-00-0')).toBeNull()
  })

  it('longer query keeps order', () => {
    expect(cjkBigramTokens('咔唑类化合物')).toEqual([
      '咔唑', '唑类', '类化', '化合', '合物',
    ])
  })
})
