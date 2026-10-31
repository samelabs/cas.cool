// Media storage configuration unit tests (no DB, no filesystem): the
// contract of resolveUploadDirs — explicit runtime env, absolute roots,
// disjoint public/private trees, and the URL prefixes every consumer
// shares. Run with `npm run test:unit`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PUBLIC_UPLOAD_URL_PREFIX,
  VERIFICATION_MEDIA_PREFIX,
  resolveUploadDirs,
} from '@/lib/media-storage'

const ENV_KEYS = ['UPLOAD_DIR', 'PRIVATE_UPLOAD_DIR'] as const

function setDirs(publicDir?: string, privateDir?: string) {
  // delete (not `= undefined`): assigning undefined to process.env coerces
  // to the literal string "undefined".
  if (publicDir === undefined) delete process.env.UPLOAD_DIR
  else process.env.UPLOAD_DIR = publicDir
  if (privateDir === undefined) delete process.env.PRIVATE_UPLOAD_DIR
  else process.env.PRIVATE_UPLOAD_DIR = privateDir
}

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('resolveUploadDirs configuration validation', () => {
  it('rejects a missing root with an error naming the variable', () => {
    setDirs('/srv/media/public-uploads', undefined)
    expect(() => resolveUploadDirs()).toThrow(/PRIVATE_UPLOAD_DIR is not configured/)
    setDirs(undefined, '/srv/media/private-uploads')
    expect(() => resolveUploadDirs()).toThrow(/UPLOAD_DIR is not configured/)
  })

  it('rejects empty and whitespace-only values', () => {
    setDirs('', '/srv/media/private-uploads')
    expect(() => resolveUploadDirs()).toThrow(/UPLOAD_DIR is not configured/)
    setDirs('   ', '/srv/media/private-uploads')
    expect(() => resolveUploadDirs()).toThrow(/UPLOAD_DIR is not configured/)
    setDirs('/srv/media/public-uploads', '\t')
    expect(() => resolveUploadDirs()).toThrow(/PRIVATE_UPLOAD_DIR is not configured/)
  })

  it('rejects relative paths for both roots', () => {
    setDirs('public/uploads', '/srv/media/private-uploads')
    expect(() => resolveUploadDirs()).toThrow(/UPLOAD_DIR must be an absolute path/)
    setDirs('/srv/media/public-uploads', 'private-uploads')
    expect(() => resolveUploadDirs()).toThrow(/PRIVATE_UPLOAD_DIR must be an absolute path/)
  })

  it('rejects public and private roots that are equal or nested', () => {
    const shared = '/srv/media/shared'
    setDirs(shared, shared)
    expect(() => resolveUploadDirs()).toThrow(/must be disjoint directory trees/)
    setDirs(shared, `${shared}/private`)
    expect(() => resolveUploadDirs()).toThrow(/must be disjoint directory trees/)
    setDirs(`${shared}/public`, shared)
    expect(() => resolveUploadDirs()).toThrow(/must be disjoint directory trees/)
    // A shared parent with two distinct subtrees is fine (sibling layout).
    setDirs(`${shared}/public`, `${shared}/private`)
    expect(resolveUploadDirs()).toEqual({ public: `${shared}/public`, private: `${shared}/private` })
  })

  it('returns normalized absolute roots for a valid configuration', () => {
    setDirs('/srv/media/public-uploads/', '/srv/media//private-uploads')
    expect(resolveUploadDirs()).toEqual({
      public: '/srv/media/public-uploads',
      private: '/srv/media/private-uploads',
    })
  })

  it('keeps the URL prefixes unchanged (routing contract)', () => {
    expect(PUBLIC_UPLOAD_URL_PREFIX).toBe('/uploads')
    expect(VERIFICATION_MEDIA_PREFIX).toBe('/api/media/verification')
  })
})
