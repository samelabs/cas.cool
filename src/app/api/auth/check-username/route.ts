/**
 * GET /api/auth/check-username?username=xxx
 *
 * Checks whether a username is available for registration.
 * Logic mirrors auth.ts checkUsernameAvailable:
 *   - sanitize (lowercase, strip non-[a-z0-9_], max 20 chars)
 *   - reject if < 3 chars
 *   - reject reserved words
 *   - check DB for existing user
 *
 * Auth: none required (used by the registration form before login).
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { sanitizeUsername } from '@/lib/utils'
import { resolveIdentity } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

const RESERVED = new Set([
  'admin', 'api', 'auth', 'cas', 'compose', 'explore', 'login', 'logout',
  'register', 'settings', 'notifications', 'messages', 'bookmarks',
  'post', 'posts', 'search', 'about', 'u', 'uploads', '_next',
])

export async function GET(request: NextRequest) {
  // Rate limit BEFORE touching the DB — this is an anonymous-reachable
  // endpoint whose only job is username enumeration checks.
  const identity = await resolveIdentity()
  const limited = checkRateLimit(identity, 'anon')
  if (limited) return limited

  const raw = request.nextUrl.searchParams.get('username') ?? ''
  const clean = sanitizeUsername(raw)

  if (!clean || clean.length < 3) {
    return Response.json({ available: false })
  }
  if (RESERVED.has(clean.toLowerCase())) {
    return Response.json({ available: false })
  }

  const existing = await prisma.user.findUnique({
    where: { username: clean },
    select: { id: true },
  })

  return Response.json({ available: !existing })
}
