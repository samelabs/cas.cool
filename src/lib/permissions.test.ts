import { describe, expect, it } from 'vitest'
import {
  canDirectMessage,
  canSearch,
  canUploadMedia,
  computeCapabilities,
  maxPostLength,
  MAX_POST_LENGTH_UNVERIFIED,
  MAX_POST_LENGTH_VERIFIED,
  needsFollowerCheckForDM,
} from './permissions'

const verified = { verificationStatus: 'verified', status: 'active' }
const unverified = { verificationStatus: 'unverified', status: 'active' }
const pending = { verificationStatus: 'pending', status: 'active' }

describe('verification tiers', () => {
  it('post length: 2000 verified, 300 unverified/pending/anonymous', () => {
    expect(MAX_POST_LENGTH_VERIFIED).toBe(2000)
    expect(MAX_POST_LENGTH_UNVERIFIED).toBe(300)
    expect(maxPostLength(verified)).toBe(2000)
    expect(maxPostLength(pending)).toBe(300)
    expect(maxPostLength(unverified)).toBe(300)
    expect(maxPostLength(null)).toBe(300)
  })

  it('media upload and search are verified-only', () => {
    expect(canUploadMedia(verified)).toBe(true)
    expect(canUploadMedia(unverified)).toBe(false)
    expect(canUploadMedia(pending)).toBe(false)
    expect(canUploadMedia(null)).toBe(false)
    expect(canSearch(verified)).toBe(true)
    expect(canSearch(unverified)).toBe(false)
    expect(canSearch(null)).toBe(false)
  })

  it('DM: verified can message anyone; others need a follower check', () => {
    expect(canDirectMessage(verified)).toBe(true)
    expect(canDirectMessage(unverified)).toBe(false)
    expect(needsFollowerCheckForDM(verified)).toBe(false)
    expect(needsFollowerCheckForDM(unverified)).toBe(true)
  })

  it('computeCapabilities faithfully describes session vs apikey under valid, expired, and restricted states', () => {
    const now = 1700000000000
    const past = new Date(now - 3600000).toISOString()
    const future = new Date(now + 3600000).toISOString()

    // 1. Session with expired verification: web rules retain max 2000 and canDirectMessageAnyone
    const expiredSessionCaps = computeCapabilities({
      authenticated: true,
      method: 'session',
      user: {
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
        status: 'active',
        role: 'user',
        verificationStatus: 'verified',
        verificationExpiresAt: past,
      },
    }, now)
    expect(expiredSessionCaps.permissions.canWrite).toBe(true)
    expect(expiredSessionCaps.permissions.canWebWrite).toBe(true)
    expect(expiredSessionCaps.permissions.canProgrammaticWrite).toBe(false)
    expect(expiredSessionCaps.permissions.canDirectMessageAnyone).toBe(true)
    expect(expiredSessionCaps.permissions.canUploadMedia).toBe(true)
    expect(expiredSessionCaps.permissions.canSearch).toBe(true)
    expect(expiredSessionCaps.limits.maxPostLength).toBe(2000)
    expect(expiredSessionCaps.verification.isValid).toBe(false)
    expect(expiredSessionCaps.accountQualifications.canProgrammaticWrite).toBe(false)
    expect(expiredSessionCaps.restrictions).not.toContain('Verification is required to upload media.')

    // 2. Apikey with expired verification: programmatic writes disabled, max 300
    const expiredApiKeyCaps = computeCapabilities({
      authenticated: true,
      method: 'apikey',
      user: {
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
        status: 'active',
        role: 'user',
        verificationStatus: 'verified',
        verificationExpiresAt: past,
      },
    }, now)
    expect(expiredApiKeyCaps.permissions.canWrite).toBe(false)
    expect(expiredApiKeyCaps.permissions.canProgrammaticWrite).toBe(false)
    expect(expiredApiKeyCaps.permissions.canDirectMessageAnyone).toBe(false)
    expect(expiredApiKeyCaps.limits.maxPostLength).toBe(300)
    expect(expiredApiKeyCaps.restrictions).toContain('Current verification is required for API and MCP writes.')

    // 3. Apikey with valid active verification: programmatic write enabled, max 2000
    const validApiKeyCaps = computeCapabilities({
      authenticated: true,
      method: 'apikey',
      user: {
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
        status: 'active',
        role: 'user',
        verificationStatus: 'verified',
        verificationExpiresAt: future,
      },
    }, now)
    expect(validApiKeyCaps.permissions.canWrite).toBe(true)
    expect(validApiKeyCaps.permissions.canProgrammaticWrite).toBe(true)
    expect(validApiKeyCaps.permissions.canDirectMessageAnyone).toBe(true)
    expect(validApiKeyCaps.limits.maxPostLength).toBe(2000)
    expect(validApiKeyCaps.verification.isValid).toBe(true)

    // 4. Restricted account: read allowed, all writes denied
    const restrictedCaps = computeCapabilities({
      authenticated: true,
      method: 'session',
      user: {
        id: 'u2',
        username: 'restricted_bob',
        displayName: 'Bob',
        status: 'restricted',
        role: 'user',
        verificationStatus: 'verified',
        verificationExpiresAt: future,
      },
    }, now)
    expect(restrictedCaps.accountQualifications.isRestricted).toBe(true)
    expect(restrictedCaps.permissions.canPublicRead).toBe(true)
    expect(restrictedCaps.permissions.canAccountRead).toBe(true)
    expect(restrictedCaps.permissions.canWrite).toBe(false)
    expect(restrictedCaps.permissions.canWebWrite).toBe(false)
    expect(restrictedCaps.permissions.canProgrammaticWrite).toBe(false)
    expect(restrictedCaps.restrictions).toContain('Account is restricted to read-only access.')
  })
})
