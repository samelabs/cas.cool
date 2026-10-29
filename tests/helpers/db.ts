import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'
import { ADMIN_DATABASE_URL, TEST_DATABASE_URL, TEST_DB_NAME } from './env'

const IDENT = `"${TEST_DB_NAME.replace(/"/g, '')}"` // constant name; quote for safety

let pool: Pool | null = null
function testPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 })
  return pool
}

async function adminQuery(text: string): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 })
  try {
    await admin.query(text)
  } finally {
    await admin.end()
  }
}

/** Drop + recreate + migrate the throwaway test database. */
export async function provisionTestDatabase(): Promise<void> {
  // Let PostgreSQL manage connection/background-worker shutdown. A manual
  // pg_stat_activity sweep can try to terminate a privileged worker and
  // fail even though this role owns the throwaway database.
  await adminQuery(`DROP DATABASE IF EXISTS ${IDENT} WITH (FORCE)`)
  await adminQuery(`CREATE DATABASE ${IDENT}`)
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: 'pipe',
    })
  } catch (err: unknown) {
    // Surface the schema engine's own output — a bare "Command failed" hides
    // whether this is a broken migration, a dirty database, or an engine
    // startup problem (diagnosability requirement from the 1.2.0 audit).
    const e = err as { message?: string; stdout?: Buffer; stderr?: Buffer }
    const detail = [e.stdout?.toString?.(), e.stderr?.toString?.()]
      .filter(Boolean)
      .join('\n')
    throw new Error(
      `prisma migrate deploy failed against ${TEST_DB_NAME}: ${e.message ?? String(err)}\n${detail}`,
    )
  }
}

export async function dropTestDatabaseWithExecutor(
  queryFn: (text: string) => Promise<void> = adminQuery,
  backoffMs = 200,
): Promise<void> {
  await closeTestPool()
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await queryFn(`DROP DATABASE IF EXISTS ${IDENT} WITH (FORCE)`)
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const isTransient =
        msg.includes('permission denied to terminate process') ||
        msg.includes('is being accessed by other users')

      if (isTransient) {
        if (attempt < 3) {
          if (backoffMs > 0) {
            await new Promise((r) => setTimeout(r, backoffMs))
          }
          continue
        }
        throw new Error(`Failed to drop test database after 3 attempts: ${msg}`)
      }
      throw err
    }
  }
}

export async function dropTestDatabase(): Promise<void> {
  return dropTestDatabaseWithExecutor(adminQuery, 200)
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/** Run a statement against the test database (seeding / assertion helper). */
export async function sql<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const res = await testPool().query(text, values)
  return res.rows as T[]
}

/** Flip verification / role flags — the API-equivalent of admin approval, without the UI. */
export async function promoteUser(
  username: string,
  patch: { verified?: boolean; admin?: boolean },
): Promise<void> {
  const sets: string[] = []
  const values: unknown[] = [username]
  if (patch.verified !== undefined) {
    values.push(patch.verified ? 'verified' : 'unverified')
    sets.push(`"verificationStatus" = $${values.length}`)
    if (patch.verified) sets.push(`"verifiedAt" = now()`)
  }
  if (patch.admin !== undefined) {
    values.push(patch.admin ? 'admin' : 'user')
    sets.push(`"role" = $${values.length}`)
  }
  await sql(`UPDATE "User" SET ${sets.join(', ')} WHERE "username" = $1`, values)
}

/** Push a post beyond the 60-minute edit window (UTC-explicit: naive
 *  TIMESTAMP columns must not inherit the psql session timezone). */
export async function agePostPastEditWindow(shortCode: string): Promise<void> {
  await sql(`UPDATE "Post" SET "createdAt" = timezone('utc', now()) - interval '2 hours' WHERE "shortCode" = $1`, [
    shortCode,
  ])
}
