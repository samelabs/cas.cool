import 'dotenv/config'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Integration-test environment derivation.
 *
 * The test server uses a database whose name ends in `_test`. Validate the
 * selected URL before the destructive provision/teardown steps run.
 */

export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'cascool_test'

if (TEST_DB_NAME.length > 63 || !/^[a-zA-Z_][a-zA-Z0-9_]*_test$/.test(TEST_DB_NAME)) {
  throw new Error('TEST_DB_NAME must be a PostgreSQL identifier of at most 63 characters ending in _test.')
}

function swapDb(url: string, db: string): string {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}

const rawTestUrl =
  process.env.TEST_DATABASE_URL ??
  (process.env.DATABASE_URL ? swapDb(process.env.DATABASE_URL, TEST_DB_NAME) : '')

if (!rawTestUrl) {
  throw new Error(
    'Integration tests need DATABASE_URL (from .env) or TEST_DATABASE_URL — see DEVELOPMENT.md',
  )
}

export const TEST_DATABASE_URL = rawTestUrl
const selectedDb = decodeURIComponent(new URL(TEST_DATABASE_URL).pathname.slice(1))
if (selectedDb !== TEST_DB_NAME) {
  throw new Error('TEST_DATABASE_URL must point to TEST_DB_NAME; refusing destructive test setup.')
}
if (process.env.DATABASE_URL) {
  const appDb = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1))
  if (appDb === TEST_DB_NAME) {
    throw new Error('DATABASE_URL points to the test database; refusing destructive test setup.')
  }
}
/** Connection used only to CREATE/DROP the test database (defaults to the `postgres` maintenance DB). */
const adminDb = process.env.TEST_ADMIN_DB ?? 'postgres'
if (adminDb === TEST_DB_NAME) {
  throw new Error('TEST_ADMIN_DB must differ from TEST_DB_NAME.')
}
export const ADMIN_DATABASE_URL = swapDb(rawTestUrl, adminDb)
export const SERVER_PORT = Number(process.env.TEST_PORT ?? 3199)
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`
export const TEST_JWT_SECRET = process.env.JWT_SECRET ?? 'integration-test-jwt-secret'

/**
 * Isolated media storage roots for this test process. The application reads
 * UPLOAD_DIR / PRIVATE_UPLOAD_DIR from the server runtime env
 * (src/lib/media-storage.ts) — tests provide that config explicitly, once,
 * right here, instead of each test file inventing its own directory rule.
 *
 * Forced assignment (not ??=): a developer's .env must never leak real
 * media roots into the hermetic suite. The spawned `next dev` server
 * inherits both through process.env, so the test process and the server
 * operate on one physical storage pair.
 */
const mediaRoot = mkdtempSync(path.join(tmpdir(), 'cascool-media-'))
export const TEST_UPLOAD_DIR = path.join(mediaRoot, 'public-uploads')
export const TEST_PRIVATE_UPLOAD_DIR = path.join(mediaRoot, 'private-uploads')
mkdirSync(TEST_UPLOAD_DIR, { recursive: true })
mkdirSync(TEST_PRIVATE_UPLOAD_DIR, { recursive: true })
process.env.UPLOAD_DIR = TEST_UPLOAD_DIR
process.env.PRIVATE_UPLOAD_DIR = TEST_PRIVATE_UPLOAD_DIR
process.on('exit', () => {
  try {
    rmSync(mediaRoot, { recursive: true, force: true })
  } catch {
    /* best effort — the OS reaps its tmpdir anyway */
  }
})
