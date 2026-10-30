import { expect, it } from 'vitest'
import { counterDeltaPreserved } from '../scripts/perf/metrics.mjs'

it('accepts matching row/counter growth and shrinkage, preserving any baseline drift', () => {
  expect(counterDeltaPreserved(10, 10, 11, 11)).toBe(true)
  expect(counterDeltaPreserved(10, 10, 9, 9)).toBe(true)
  expect(counterDeltaPreserved(110, 10, 111, 11)).toBe(true)
  expect(counterDeltaPreserved(110, 10, 110, 10)).toBe(true)
})

it('rejects over-counting and under-counting even when relation rows change', () => {
  expect(counterDeltaPreserved(10, 10, 12, 11)).toBe(false)
  expect(counterDeltaPreserved(10, 10, 10, 11)).toBe(false)
  expect(counterDeltaPreserved(110, 10, 110, 9)).toBe(false)
})
