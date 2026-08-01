/**
 * POST /api/auth/login
 * POST /api/auth/register
 * POST /api/auth/logout
 *
 * Auth routes — session-cookie based for browsers.
 * No API Key (these endpoints CREATE the session).
 */

import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { createSession, setSessionCookie, clearSession } from '@/lib/auth'
import { sanitizeUsername } from '@/lib/utils'
import { userSelect, serializeUser } from '@/lib/serialize'
import { checkRateLimit } from '@/lib/rate-limit'
import { resolveIdentity } from '@/lib/api-auth'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const RESERVED = new Set([
  'admin', 'api', 'auth', 'cas', 'compose', 'explore', 'login', 'logout',
  'register', 'settings', 'notifications', 'messages', 'bookmarks',
  'post', 'posts', 'search', 'about', 'u', 'uploads', '_next',
])

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

// ── POST /api/auth/login ──────────────────────────────────────

export async function POST(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (pathname.endsWith('/login')) {
    return login(request)
  }
  if (pathname.endsWith('/register')) {
    return register(request)
  }
  if (pathname.endsWith('/logout')) {
    return logout()
  }
  return jsonError(404, 'not_found', 'Resource not found.')
}

// ── Login ─────────────────────────────────────────────────────

async function login(request: NextRequest) {
  const identity = await resolveIdentity()
  const limited = checkRateLimit(identity.method === 'anonymous' ? { method: 'anonymous', user: null } : identity, 'write')
  if (limited) return limited

  const body = await request.json().catch(() => null)
  if (!body) return jsonError(400, 'bad_request', 'Invalid JSON.')

  const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!identifier || !password) return jsonError(400, 'bad_request', 'Please fill in all fields.')

  const where = EMAIL_RE.test(identifier.toLowerCase())
    ? { email: identifier.toLowerCase() }
    : { username: identifier.toLowerCase() }

  const user = await prisma.user.findUnique({
    where,
    select: { ...userSelect, passwordHash: true },
  })

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return jsonError(401, 'unauthorized', 'Invalid email/username or password.')
  }
  if (user.status === 'suspended') {
    return jsonError(403, 'forbidden', 'This account has been suspended.')
  }

  const token = await createSession(user.id)
  await setSessionCookie(token)

  const { passwordHash: _ph, ...safe } = user
  return Response.json({ user: serializeUser(safe) })
}

// ── Register ──────────────────────────────────────────────────

async function register(request: NextRequest) {
  const identity = await resolveIdentity()
  const limited = checkRateLimit(identity.method === 'anonymous' ? { method: 'anonymous', user: null } : identity, 'write')
  if (limited) return limited

  const body = await request.json().catch(() => null)
  if (!body) return jsonError(400, 'bad_request', 'Invalid JSON.')

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const username = typeof body.username === 'string' ? sanitizeUsername(body.username.trim()) : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''

  if (!EMAIL_RE.test(email)) return jsonError(400, 'bad_request', 'Invalid email address.')
  if (!username || username.length < 3) return jsonError(400, 'bad_request', 'Username must be at least 3 characters.')
  if (!password || password.length < 8) return jsonError(400, 'bad_request', 'Password must be at least 8 characters.')
  if (password.length > 128) return jsonError(400, 'bad_request', 'Password is too long.')
  if (RESERVED.has(username.toLowerCase())) return jsonError(400, 'bad_request', 'This username is reserved.')

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
    select: { email: true, username: true },
  })
  if (existing) {
    if (existing.email === email) return jsonError(409, 'conflict', 'This email is already registered.')
    return jsonError(409, 'conflict', 'This username is already taken.')
  }

  const passwordHash = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({
    data: { email, username, displayName: displayName || null, passwordHash },
    select: userSelect,
  })

  const token = await createSession(user.id)
  await setSessionCookie(token)

  return Response.json({ user: serializeUser(user) }, { status: 201 })
}

// ── Logout ────────────────────────────────────────────────────

async function logout() {
  await clearSession()
  return Response.json({ success: true })
}
