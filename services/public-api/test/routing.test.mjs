import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ||= 'postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder'

const { resolveRoute } = await import('../dist/routes.js')
const { TokenBucketLimiter } = await import('../dist/rate-limit.js')

test('public API router matches only declared method/path pairs', () => {
  assert.ok(resolveRoute('GET', '/api/v1/me'))
  assert.ok(resolveRoute('GET', '/api/v1/timeline'))
  assert.ok(resolveRoute('GET', '/api/v1/posts/Ab3xY9zK'))
  assert.ok(resolveRoute('DELETE', '/api/v1/posts/Ab3xY9zK/like'))
  assert.equal(resolveRoute('GET', '/api/v1/posts'), null)
  assert.equal(resolveRoute('GET', '/api/admin/users'), null)
  assert.equal(resolveRoute('POST', '/api/v1/timeline'), null)
})

test('route parameters are decoded without changing the route contract', () => {
  const matchedRoute = resolveRoute('GET', '/api/v1/users/test_user/posts')
  assert.ok(matchedRoute)
  assert.equal(matchedRoute.params.username, 'test_user')
})

test('token bucket limits identities independently', () => {
  const limiter = new TokenBucketLimiter(2, 1)
  assert.equal(limiter.consume('key-a'), true)
  assert.equal(limiter.consume('key-a'), true)
  assert.equal(limiter.consume('key-a'), false)
  assert.equal(limiter.consume('key-b'), true)
})
