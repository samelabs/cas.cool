import { createHmac, timingSafeEqual } from 'node:crypto'
import { FEED_PAGE_SIZE } from '@/lib/feed-constants'

/** One page-size rule for timeline and search queries, including SSR:
 *  finite integers in [1, 50]; fractional sizes round down. */
export function normalizePageSize(value?: number): number {
  const size = value !== undefined && Number.isFinite(value) ? Math.trunc(value) : FEED_PAGE_SIZE
  return Math.min(Math.max(size, 1), 50)
}

/** Match the UTC millisecond timestamps emitted by our keyset cursors.
 *  Round-tripping rejects invalid calendar dates that Date normalizes. */
export function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

/** Validate timeline cursor format for both REST and MCP.
 *  - Compound cursor: <canonicalTimestamp>|<id>
 *  - For You first-page cursor: bare canonical timestamp (when not scoped to special filters)
 */
export function validateTimelineCursor(
  cursor: string,
  tab?: string,
  isSpecialFilter?: boolean,
): boolean {
  if (!cursor || typeof cursor !== 'string') return false
  const parts = cursor.split('|')
  if (parts.length === 2) {
    return isCanonicalTimestamp(parts[0]) && parts[1].length > 0
  }
  if (parts.length === 1 && tab === 'foryou' && !isSpecialFilter) {
    return isCanonicalTimestamp(parts[0])
  }
  return false
}

// ── Ancestor Continuation Cursor (Target-Bound & Cryptographically Signed) ──

const ANCESTOR_CURSOR_PURPOSE = 'cascool:ancestor_cursor:v1'

function getSecretKey(): string {
  const secret = process.env.JWT_SECRET || process.env.AUTH_SECRET
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is not set.')
    }
    return 'cascool-dev-secret-do-not-use-in-prod'
  }
  return secret
}

/**
 * Sign an opaque ancestor continuation cursor that cryptographically binds:
 * 1. The original discussion target post ID (`targetPostId`)
 * 2. The boundary ancestor post ID (`boundaryAncestorId`)
 * 3. A dedicated purpose string preventing signature reuse across features
 */
export function encodeAncestorCursor(targetPostId: string, boundaryAncestorId: string): string {
  const secret = getSecretKey()
  const payload = `${targetPostId}:${boundaryAncestorId}`
  const signature = createHmac('sha256', secret)
    .update(`${ANCESTOR_CURSOR_PURPOSE}:${payload}`)
    .digest('base64url')

  return Buffer.from(`${payload}:${signature}`).toString('base64url')
}

export type DecodeAncestorCursorResult =
  | { ok: true; boundaryAncestorId: string }
  | { ok: false; error: string }

/**
 * Decode and verify an ancestor continuation cursor:
 * - Checks format and base64url encoding
 * - Enforces exact target post binding (rejects cross-discussion cursor reuse)
 * - Verifies HMAC-SHA256 signature using timingSafeEqual (rejects tampering)
 */
export function decodeAndValidateAncestorCursor(
  cursor: string,
  expectedTargetPostId: string,
): DecodeAncestorCursorResult {
  if (typeof cursor !== 'string' || !cursor.trim()) {
    return { ok: false, error: 'Ancestor cursor must be a non-empty string.' }
  }

  let decodedText: string
  try {
    decodedText = Buffer.from(cursor.trim(), 'base64url').toString('utf8')
  } catch {
    return { ok: false, error: 'Malformed ancestor cursor encoding.' }
  }

  const parts = decodedText.split(':')
  if (parts.length !== 3) {
    return { ok: false, error: 'Malformed ancestor cursor format.' }
  }

  const [cursorTargetId, boundaryAncestorId, signature] = parts
  if (!cursorTargetId || !boundaryAncestorId || !signature) {
    return { ok: false, error: 'Incomplete ancestor cursor payload.' }
  }

  // 1. Enforce target post binding to prevent cross-discussion cursor reuse
  if (cursorTargetId !== expectedTargetPostId) {
    return { ok: false, error: 'Ancestor cursor does not belong to the requested target post.' }
  }

  // 2. Validate cryptographic signature
  try {
    const secret = getSecretKey()
    const payload = `${cursorTargetId}:${boundaryAncestorId}`
    const expectedSignature = createHmac('sha256', secret)
      .update(`${ANCESTOR_CURSOR_PURPOSE}:${payload}`)
      .digest('base64url')

    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expectedSignature)
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return { ok: false, error: 'Invalid or tampered ancestor cursor signature.' }
    }
  } catch {
    return { ok: false, error: 'Failed to verify ancestor cursor signature.' }
  }

  return { ok: true, boundaryAncestorId }
}
