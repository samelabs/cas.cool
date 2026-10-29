/**
 * Unified API authentication — single entry point for all route handlers.
 *
 * One identity resolution pass per request:
 *   Authorization: Bearer <key>    → API Key path (agent / external caller)
 *   Cookie: feed_session           → Session path (browser / internal)
 *
 * The resolved identity is the same shape regardless of path. Route handlers
 * never branch on auth method — they just check `.authenticated` and `.user`.
 */

import { createHash } from 'node:crypto'
import { cookies } from 'next/headers'
import { jwtVerify } from 'jose'
import { prisma } from './db'
import { SESSION_COOKIE } from './session-constants'
import { hasCurrentVerification } from './permissions'


// ── Types ─────────────────────────────────────────────────────

export interface AuthIdentity {
  authenticated: boolean
  user: AuthUser | null
  /** 'apikey' | 'session' | 'anonymous' */
  method: 'apikey' | 'session' | 'anonymous'
  /** API Key row id (only when method === 'apikey') */
  apiKeyId?: string
  /** Client IP for anonymous rate-limit bucketing (see rate-limit.ts). */
  ip?: string | null
}

export interface AuthUser {
  id: string
  username: string
  displayName: string | null
  verificationStatus: string
  verificationExpiresAt: Date | null
  status: string
  role: string
}

// ── Lazy JWT secret ───────────────────────────────────────────

let _secret: Uint8Array | null = null
function getSecret(): Uint8Array {
  if (_secret) return _secret
  const key = process.env.JWT_SECRET
  if (!key) throw new Error('JWT_SECRET environment variable is not set.')
  _secret = new TextEncoder().encode(key)
  return _secret
}

// ── Public entry point ────────────────────────────────────────

/**
 * Resolve the caller identity from a Route Handler request.
 *
 * An explicit Authorization header is authoritative. Invalid credentials
 * never fall back to a cookie session.
 * Never throws — returns { authenticated: false } on any failure.
 */
export async function resolveIdentity(options: { allowSession?: boolean } = {}): Promise<AuthIdentity> {
  // 1. Try API Key. The hash lookup is prefix-agnostic; SiteConfig controls
  // the prefix used when generating new keys.
  const h = await headers()
  const header = h.get('authorization')
  if (header !== null) {
    if (header.startsWith('Bearer ')) {
      const rawKey = header.slice(7)
      if (rawKey.length >= 20 && rawKey.length <= 128) {
        const identity = await tryApiKey(rawKey)
        if (identity) return identity
      }
    }
    return { authenticated: false, user: null, method: 'anonymous', ip: clientIp(h) }
  }

  // Remote MCP is a bearer-only surface. Browser cookies must never confer
  // agent write access or silently select a different account.
  if (options.allowSession === false) {
    return { authenticated: false, user: null, method: 'anonymous', ip: clientIp(h) }
  }

  // 2. Try Session (cookie)
  const identity = await trySession()
  if (identity) return identity

  // 3. Anonymous
  return { authenticated: false, user: null, method: 'anonymous', ip: clientIp(h) }
}

/**
 * Client IP for anonymous rate-limit keys. Trust only the LAST entry of
 * X-Forwarded-For (appended by our nginx via proxy_add_x_forwarded_for) —
 * earlier entries are client-spoofable. Falls back to X-Real-IP (set by
 * nginx from $remote_addr, not spoofable).
 */
function clientIp(h: Headers): string | null {
  const fwd = (h.get('x-forwarded-for') || '').split(',').map((x) => x.trim())
  const last = fwd[fwd.length - 1]
  if (last) return last
  return h.get('x-real-ip')
}

// ── API Key path ──────────────────────────────────────────────

async function tryApiKey(rawKey: string): Promise<AuthIdentity | null> {
  const keyHash = createHash('sha256').update(rawKey).digest('hex')
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  })
  if (!apiKey || apiKey.revokedAt) return null
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null

  const user = await prisma.user.findUnique({
    where: { id: apiKey.userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      verificationStatus: true,
      verificationExpiresAt: true,
      status: true,
      role: true,
    },
  })
  // Status policy aligned with the session path: only 'suspended' is
  // denied here. 'restricted' accounts keep read access; write operations
  // are gated by requireWrite() for BOTH auth methods.
  if (!user || user.status === 'suspended') return null

  // Fire-and-forget lastUsedAt update
  void prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  return { authenticated: true, user, method: 'apikey', apiKeyId: apiKey.id }
}

// ── Session path ──────────────────────────────────────────────

async function trySession(): Promise<AuthIdentity | null> {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(SESSION_COOKIE)?.value
    if (!token) return null

    const { payload } = await jwtVerify(token, getSecret())
    const userId = payload.userId as string | undefined
    if (!userId) return null

    // DB-backed session validation (same as getSession in auth.ts)
    const session = await prisma.session.findUnique({
      where: { token },
      select: { userId: true, expiresAt: true },
    })
    if (!session || session.expiresAt < new Date()) return null

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        verificationStatus: true,
        verificationExpiresAt: true,
        status: true,
        role: true,
      },
    })
    if (!user || user.status === 'suspended') return null

    return { authenticated: true, user, method: 'session' }
  } catch {
    return null
  }
}

// ── Helpers for route handlers ────────────────────────────────

/** Require an authenticated user, or return a 401 Response. */
export async function requireAuth(): Promise<
  { ok: true; identity: AuthIdentity } | { ok: false; response: Response }
> {
  const identity = await resolveIdentity()
  if (!identity.authenticated || !identity.user) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: 'unauthorized', message: 'Authentication required.' } },
        { status: 401 },
      ),
    }
  }
  return { ok: true, identity }
}

export interface AccessError {
  status: number
  code: string
  message: string
}

/** Shared REST/MCP write policy. Browser membership tiers remain unchanged;
 *  programmatic writes additionally require current verification. */
export function writeAccessError(identity: AuthIdentity, now = Date.now()): AccessError | null {
  if (!identity.authenticated || !identity.user) {
    return { status: 401, code: 'unauthorized', message: 'Authentication required.' }
  }
  if (identity.user.status === 'suspended') {
    return { status: 401, code: 'unauthorized', message: 'Account is suspended.' }
  }
  if (identity.user.status !== 'active') {
    return { status: 403, code: 'forbidden', message: 'Account is not active.' }
  }
  if (identity.method === 'apikey' && !hasCurrentVerification(identity.user, now)) {
    return { status: 403, code: 'forbidden', message: 'Current verification is required for API and MCP writes.' }
  }
  return null
}

/** Check admin authorization. Admin writes still enforce active status and programmatic verification. */
export function adminAccessError(
  identity: AuthIdentity,
  access: 'read' | 'write' = 'read',
  now = Date.now(),
): AccessError | null {
  if (!identity.authenticated || !identity.user) {
    return { status: 401, code: 'unauthorized', message: 'Authentication required.' }
  }
  if (identity.user.status === 'suspended') {
    return { status: 401, code: 'unauthorized', message: 'Account is suspended.' }
  }
  if (identity.user.role !== 'admin') {
    return { status: 403, code: 'forbidden', message: 'Admin access required.' }
  }
  if (access === 'write') {
    return writeAccessError(identity, now)
  }
  if (identity.user.status !== 'active' && identity.user.status !== 'restricted') {
    return { status: 403, code: 'forbidden', message: 'Account is not active.' }
  }
  return null
}

/** Require write access using the shared browser/programmatic policy. */
export async function requireWrite(): Promise<
  { ok: true; identity: AuthIdentity } | { ok: false; response: Response }
> {
  const result = await requireAuth()
  if (!result.ok) return result
  const error = writeAccessError(result.identity)
  if (error) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      ),
    }
  }
  return result
}

/** Require an admin user. */
export async function requireAdmin(access: 'read' | 'write' = 'read'): Promise<
  { ok: true; identity: AuthIdentity } | { ok: false; response: Response }
> {
  const auth = await requireAuth()
  if (!auth.ok) return auth
  const error = adminAccessError(auth.identity, access)
  if (error) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      ),
    }
  }
  return auth
}

// ── Inline headers() to avoid next/headers import duplication ─

import { headers as nextHeaders } from 'next/headers'
async function headers(): Promise<Headers> {
  return await nextHeaders()
}
