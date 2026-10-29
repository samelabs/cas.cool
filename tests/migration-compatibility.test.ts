import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropTestDatabase, promoteUser, provisionTestDatabase, sql } from './helpers/db'
import { api, json, registerAndLogin, type Session } from './helpers/http'
import { startTestServer, stopTestServer } from './helpers/server'
import { hashApiKey } from '../src/lib/api-key'

describe('database migration compatibility: retiring ApiKey.access', () => {
  let verifiedSession: Session
  let unverifiedSession: Session
  let verifiedUser: { id: string; username: string }
  let unverifiedUser: { id: string; username: string }

  const rawKeyReadVerified = 'ck_live_read_verified_test_key_1234567890abcdef'
  const rawKeyRwUnverified = 'ck_live_rw_unverified_test_key_1234567890abcdef'
  const rawKeyRwVerified = 'ck_live_rw_verified_test_key_1234567890abcdef'
  const rawKeyRevoked = 'ck_live_revoked_test_key_1234567890abcdef'
  const rawKeyExpired = 'ck_live_expired_test_key_1234567890abcdef'

  beforeAll(async () => {
    await provisionTestDatabase()
    await startTestServer()

    verifiedSession = await registerAndLogin('mig_ver')
    unverifiedSession = await registerAndLogin('mig_unver')
    await promoteUser(verifiedSession.username, { verified: true })

    const users = await sql<{ id: string; username: string }>(
      `SELECT id, username FROM "User" WHERE username IN ($1, $2)`,
      [verifiedSession.username, unverifiedSession.username],
    )
    verifiedUser = users.find((u) => u.username === verifiedSession.username)!
    unverifiedUser = users.find((u) => u.username === unverifiedSession.username)!
  })

  afterAll(async () => {
    await stopTestServer()
    await dropTestDatabase()
  })

  it('rehearses legacy schema with old read/read_write keys, applies migration, and enforces unified semantics', async () => {
    // 1. Temporarily restore legacy ApiKeyAccess enum and access column
    await sql(`CREATE TYPE "ApiKeyAccess" AS ENUM ('read', 'read_write')`)
    await sql(`ALTER TABLE "ApiKey" ADD COLUMN "access" "ApiKeyAccess" NOT NULL DEFAULT 'read'`)

    // Verify column exists
    const beforeCols = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ApiKey' AND column_name = 'access'`,
    )
    expect(beforeCols.length).toBe(1)

    // 2. Insert legacy keys with explicit old access levels

    await sql(
      `INSERT INTO "ApiKey" ("id", "name", "keyHash", "prefix", "userId", "access", "createdAt", "lastUsedAt")
       VALUES ($1, $2, $3, $4, $5, 'read'::"ApiKeyAccess", now(), now())`,
      ['key_read_ver', 'Old Read Key on Verified User', hashApiKey(rawKeyReadVerified), 'readver1', verifiedUser.id],
    )

    await sql(
      `INSERT INTO "ApiKey" ("id", "name", "keyHash", "prefix", "userId", "access", "createdAt", "lastUsedAt")
       VALUES ($1, $2, $3, $4, $5, 'read_write'::"ApiKeyAccess", now(), now())`,
      ['key_rw_unver', 'Old ReadWrite Key on Unverified User', hashApiKey(rawKeyRwUnverified), 'rwunver2', unverifiedUser.id],
    )

    await sql(
      `INSERT INTO "ApiKey" ("id", "name", "keyHash", "prefix", "userId", "access", "createdAt", "lastUsedAt")
       VALUES ($1, $2, $3, $4, $5, 'read_write'::"ApiKeyAccess", now(), now())`,
      ['key_rw_ver', 'Old ReadWrite Key on Verified User', hashApiKey(rawKeyRwVerified), 'rwver333', verifiedUser.id],
    )

    await sql(
      `INSERT INTO "ApiKey" ("id", "name", "keyHash", "prefix", "userId", "access", "revokedAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, 'read_write'::"ApiKeyAccess", now(), now())`,
      ['key_revoked', 'Revoked Key', hashApiKey(rawKeyRevoked), 'revoked4', verifiedUser.id],
    )

    await sql(
      `INSERT INTO "ApiKey" ("id", "name", "keyHash", "prefix", "userId", "access", "expiresAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, 'read_write'::"ApiKeyAccess", timezone('utc', now()) - interval '1 day', now())`,
      ['key_expired', 'Expired Key', hashApiKey(rawKeyExpired), 'expired5', verifiedUser.id],
    )

    // 3. Apply the migration 20261029140000_retire_api_key_access
    const migrationPath = join(
      process.cwd(),
      'prisma/migrations/20261029140000_retire_api_key_access/migration.sql',
    )
    const migrationSql = readFileSync(migrationPath, 'utf8')
    await sql(migrationSql)

    // 4. Assert column and enum are dropped
    const afterCols = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ApiKey' AND column_name = 'access'`,
    )
    expect(afterCols.length).toBe(0)

    const afterEnums = await sql<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typname = 'ApiKeyAccess'`,
    )
    expect(afterEnums.length).toBe(0)

    // 5. Assert all ApiKey metadata (id, userId, keyHash, prefix, revokedAt, expiresAt) are intact
    const preservedKeys = await sql<{
      id: string
      keyHash: string
      prefix: string
      userId: string
      revokedAt: Date | null
      expiresAt: Date | null
    }>(`SELECT "id", "keyHash", "prefix", "userId", "revokedAt", "expiresAt" FROM "ApiKey" ORDER BY "id"`)

    expect(preservedKeys.length).toBe(5)
    const readVerKey = preservedKeys.find((k) => k.id === 'key_read_ver')!
    expect(readVerKey.prefix).toBe('readver1')
    expect(readVerKey.keyHash).toBe(hashApiKey(rawKeyReadVerified))
    expect(readVerKey.userId).toBe(verifiedUser.id)

    const rwUnverKey = preservedKeys.find((k) => k.id === 'key_rw_unver')!
    expect(rwUnverKey.prefix).toBe('rwunver2')
    expect(rwUnverKey.userId).toBe(unverifiedUser.id)

    const revokedKey = preservedKeys.find((k) => k.id === 'key_revoked')!
    expect(revokedKey.revokedAt).not.toBeNull()

    const expiredKey = preservedKeys.find((k) => k.id === 'key_expired')!
    expect(expiredKey.expiresAt).not.toBeNull()

    // 6. Test runtime authorization with migrated keys:
    // A. Key 1 (formerly 'read' on verified user) -> Now dynamically has write access!
    const capRes1 = await api('/api/account/capabilities', {
      headers: { Authorization: `Bearer ${rawKeyReadVerified}` },
    })
    expect(capRes1.status).toBe(200)
    const cap1 = await json<{
      verification: { isValid: boolean }
      permissions: { canWrite: boolean; canProgrammaticWrite: boolean }
    }>(capRes1)
    expect(cap1.verification.isValid).toBe(true)
    expect(cap1.permissions.canWrite).toBe(true)
    expect(cap1.permissions.canProgrammaticWrite).toBe(true)

    const writeRes1 = await api('/api/posts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rawKeyReadVerified}` },
      body: JSON.stringify({ content: 'Post created with legacy read key now verified' }),
    })
    expect(writeRes1.status).toBe(201)

    // B. Key 2 (formerly 'read_write' on unverified user) -> Now dynamically read-only!
    const capRes2 = await api('/api/account/capabilities', {
      headers: { Authorization: `Bearer ${rawKeyRwUnverified}` },
    })
    expect(capRes2.status).toBe(200)
    const cap2 = await json<{
      verification: { isValid: boolean }
      permissions: { canWrite: boolean; canProgrammaticWrite: boolean }
    }>(capRes2)
    expect(cap2.verification.isValid).toBe(false)
    expect(cap2.permissions.canWrite).toBe(false)
    expect(cap2.permissions.canProgrammaticWrite).toBe(false)

    const writeRes2 = await api('/api/posts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rawKeyRwUnverified}` },
      body: JSON.stringify({ content: 'Unverified attempt with old rw key' }),
    })
    expect(writeRes2.status).toBe(403)

    // C. Key 4 (revoked) -> 401 on write or authenticated endpoint
    const revokedRes = await api('/api/posts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rawKeyRevoked}` },
      body: JSON.stringify({ content: 'Post with revoked key' }),
    })
    expect(revokedRes.status).toBe(401)

    // D. Key 5 (expired) -> 401 on write or authenticated endpoint
    const expiredRes = await api('/api/posts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rawKeyExpired}` },
      body: JSON.stringify({ content: 'Post with expired key' }),
    })
    expect(expiredRes.status).toBe(401)
  })
})
