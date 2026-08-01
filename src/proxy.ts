import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { t } from '@/lib/i18n'

/**
 * Next.js 16 "proxy" (formerly middleware).
 *
 * Two responsibilities:
 *
 * 1. OPTIMISTIC auth check (page routes) — based purely on the presence of the
 *    `cas_session` cookie. Real session validation still happens in server
 *    components / route handlers via resolveIdentity(). This just keeps
 *    unauthenticated visitors off the protected app shell.
 *    Publicly viewable without auth: /, /explore, /p/*, /u/*,
 *    /login, /register. Protected: /settings, /messages, /notifications,
 *    /bookmarks, /compose.
 *
 * 2. IN-MEMORY rate limiting (edge-level, before Route Handlers).
 *    Route Handlers have their own checkRateLimit() via rate-limit.ts —
 *    this proxy layer adds a fast pre-auth IP bucket for anonymous flooding.
 *    Authenticated user-level limiting happens inside each handler.
 *
 *    Server Action writes (POST to page routes with Next-Action header) are
 *    still rate-limited here until all frontend components migrate to fetch().
 */

const SESSION_COOKIE = 'cas_session'

const PROTECTED_PREFIXES = [
  '/settings',
  '/verify',
  '/messages',
  '/notifications',
  '/bookmarks',
  '/compose',
  '/admin',
]

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/* ── Rate limiting (token bucket) ─────────────────────────── */

interface Bucket {
  tokens: number
  last: number
}

const buckets = new Map<string, Bucket>()
const GC_INTERVAL_MS = 5 * 60 * 1000
let lastGc = Date.now()

function refill(bucket: Bucket, capacity: number, refillPerMs: number) {
  const now = Date.now()
  const elapsed = now - bucket.last
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs)
  bucket.last = now
}

function allow(key: string, capacity: number, perMinute: number): boolean {
  const now = Date.now()
  if (now - lastGc > GC_INTERVAL_MS) {
    lastGc = now
    for (const [k, b] of buckets) {
      if (now - b.last > GC_INTERVAL_MS) buckets.delete(k)
    }
  }

  const refillPerMs = perMinute / 60_000
  const bucket = buckets.get(key)
  if (!bucket) {
    buckets.set(key, { tokens: capacity - 1, last: now })
    return true
  }
  refill(bucket, capacity, refillPerMs)
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return true
  }
  return false
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

/** Resolve identity for Server Action rate limiting: JWT userId or IP. */
async function resolveIdentity(req: NextRequest): Promise<string> {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token) {
    try {
      const secret = process.env.JWT_SECRET
      if (secret) {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret))
        if (typeof payload.userId === 'string') return `u:${payload.userId}`
      }
    } catch {
      // Invalid/expired token → fall back to IP bucketing.
    }
  }
  return `ip:${clientIp(req)}`
}

interface Limit {
  capacity: number
  perMinute: number
}

function serverActionLimit(): Limit {
  return { capacity: 30, perMinute: 30 }
}

/* ── Main proxy entry ─────────────────────────────────────── */

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ── Server Action rate limiting (POST to page routes) ──
  // Still needed while frontend components use Server Actions for writes.
  // Will be removed once all components migrate to fetch() Route Handlers.
  if (request.method.toUpperCase() === 'POST' && request.headers.get('next-action')) {
    const limit = serverActionLimit()
    const identityKey = await resolveIdentity(request)
    if (!allow(identityKey, limit.capacity, limit.perMinute)) {
      const retryAfter = Math.ceil(60 / limit.perMinute)
      return new NextResponse('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      })
    }
  }

  // ── Optimistic auth check (page routes) ──
  const session = request.cookies.get(SESSION_COOKIE)?.value

  if (!session && isProtected(pathname)) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\\\..*).*)',
  ],
}
