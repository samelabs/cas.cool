/**
 * Unified API authentication — single entry point for all route handlers.
 *
 * One identity resolution pass per request:
 *   Authorization: Bearer cas_...  → API Key path (agent / external caller)
 *   Cookie: cas_session            → Session path (browser / internal)
 *
 * The resolved identity is the same shape regardless of path. Route handlers
 * never branch on auth method — they just check `.authenticated` and `.user`.
 */

import { createHash } from 'node:crypto'
import { cookies } from 'next/headers'
import { jwtVerify } from 'jose'
import { prisma } from './db'
import { userSelect } from './serialize'

const SESSION_COOKIE = 'cas_session'

// ── Types ─────────────────────────────────────────────────────

export interface AuthIdentity {
  authenticated: boolean
  user: AuthUser | null
  /** 'apikey' | 'session' | 'anonymous' */
  method: 'apikey' | 'session' | 'anonymous'
  /** API Key row id (only when method === 'apikey') */
  apiKeyId?: string
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
 * Tries API Key first (Authorization header), then Session (cookie).
 * Never throws — returns { authenticated: false } on any failure.
 */
export async function resolveIdentity(): Promise<AuthIdentity> {
  // 1. Try API Key (Authorization: Bearer cas_...)
  const header = (await headers()).get('authorization')
  if (header?.startsWith('Bearer ')) {
    const rawKey = header.slice(7)
    if (rawKey.startsWith('cas_') && rawKey.length >= 20 && rawKey.length <= 128) {
      const identity = await tryApiKey(rawKey)
      if (identity) return identity
    }
  }

  // 2. Try Session (cookie)
  const identity = await trySession()
  if (identity) return identity

  // 3. Anonymous
  return { authenticated: false, user: null, method: 'anonymous' }
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
  if (!user || user.status !== 'active') return null

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

/** Require a user with write permission (active status). */
export async function requireWrite(): Promise<
  { ok: true; identity: AuthIdentity } | { ok: false; response: Response }
> {
  const result = await requireAuth()
  if (!result.ok) return result
  if (result.identity.user!.status !== 'active') {
    return {
      ok: false,
      response: Response.json(
        { error: { code: 'forbidden', message: 'Account is not active.' } },
        { status: 403 },
      ),
    }
  }
  return result
}

/** Require an admin user. */
export async function requireAdmin(): Promise<
  { ok: true; identity: AuthIdentity } | { ok: false; response: Response }
> {
  const result = await requireAuth()
  if (!result.ok) return result
  if (result.identity.user!.role !== 'admin') {
    return {
      ok: false,
      response: Response.json(
        { error: { code: 'forbidden', message: 'Admin access required.' } },
        { status: 403 },
      ),
    }
  }
  return result
}

// ── Inline headers() to avoid next/headers import duplication ─

import { headers as nextHeaders } from 'next/headers'
async function headers(): Promise<Headers> {
  return await nextHeaders()
}
