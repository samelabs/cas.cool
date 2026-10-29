import { describe, expect, it } from 'vitest'
import { createBrowseMemory } from './BrowseStateProvider'

const list = (n: number) => `/api/posts?tab=latest&author=user-${n}`

describe('identity browse-memory lifetime', () => {
  it('evicts an inactive list as one unit while retaining the active list and unrelated SWR state', () => {
    const { cache, scrollStore } = createBrowseMemory(2)
    const first = list(1)
    cache.set(first, { data: 'first page' })
    cache.set(`${first}&cursor=next`, { data: 'second page' })
    cache.set(`$inf$${first}`, { data: ['first page', 'second page'], size: 2 })
    cache.set('/api/notifications', { data: 'unrelated' })

    scrollStore.open(first)
    scrollStore.save(first, 6000)
    scrollStore.close(first)
    for (const n of [2, 3]) {
      scrollStore.open(list(n))
      cache.set(list(n), { data: `user-${n}` })
      scrollStore.close(list(n))
    }

    expect(cache.has(first)).toBe(false)
    expect(cache.has(`${first}&cursor=next`)).toBe(false)
    expect(cache.has(`$inf$${first}`)).toBe(false)
    expect(scrollStore.take(first)).toBeNull()
    expect(cache.has(list(2))).toBe(true)
    expect(cache.has(list(3))).toBe(true)
    expect(cache.has('/api/notifications')).toBe(true)
  })

  it('refreshes recency on revisit and never evicts a still-mounted list', () => {
    const { cache, scrollStore } = createBrowseMemory(2)
    const first = list(1)
    const second = list(2)
    const third = list(3)
    for (const key of [first, second]) {
      scrollStore.open(key)
      cache.set(key, { data: key })
      scrollStore.close(key)
    }

    scrollStore.open(first)
    scrollStore.open(first) // two consumers may share the same list key
    scrollStore.close(first)
    scrollStore.open(third)
    cache.set(third, { data: third })
    scrollStore.close(third)
    expect(cache.has(first)).toBe(true)
    expect(cache.has(second)).toBe(true)

    scrollStore.close(first)
    expect(cache.has(second)).toBe(false)
    expect(cache.has(first)).toBe(true)
    expect(cache.has(third)).toBe(true)
  })

  it('keeps cache entries bounded across many distinct profile and CAS lists', () => {
    const { cache, scrollStore } = createBrowseMemory(5)
    for (let n = 0; n < 30; n++) {
      const key = n % 2 === 0
        ? `/api/posts?tab=latest&author=user-${n}`
        : `/api/posts?tab=latest&cas=67-56-${n}`
      scrollStore.open(key)
      cache.set(key, { data: n })
      cache.set(`${key}&cursor=next`, { data: n + 1 })
      cache.set(`$inf$${key}`, { data: [n, n + 1], size: 2 })
      scrollStore.save(key, n * 100)
      scrollStore.close(key)
      expect(cache.size).toBeLessThanOrEqual(15)
    }
    expect(cache.size).toBe(15)
  })
})
