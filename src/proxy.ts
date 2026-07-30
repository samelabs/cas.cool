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
 *    components / route handlers via getCurrentUser(). This just keeps
 *    unauthenticated visitors off the protected app shell.
 *    Publicly viewable without auth: /, /explore, /p/*, /[username],
 *    /login, /register. Protected: /settings, /messages, /notifications,
 *    /bookmarks, /compose.
 *
 * 2. IN-MEMORY rate limiting (browser BFF write routes) — token-bucket per
 *    user (from JWT) or per IP. The independent public API owns its own
 *    authentication and rate limits.
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

// Map<key, Bucket>. Cleaned up opportunistically to bound memory.
const buckets = new Map<string, Bucket>()
const GC_INTERVAL_MS = 5 * 60 * 1000
let lastGc = Date.now()

function refill(bucket: Bucket, capacity: number, refillPerMs: number) {
  const now = Date.now()
  const elapsed = now - bucket.last
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs)
  bucket.last = now
}

/** Returns true if the request is allowed, false if rate-limited. */
function allow(key: string, capacity: number, perMinute: number): boolean {
  const now = Date.now()
  // Opportunistic GC: drop stale buckets to bound memory.
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

/** Resolve the browser BFF rate-limit identity: JWT userId or IP fallback. */
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
  byIp: boolean
}

/** Route-specific limits. Returns null when no limit applies. */
function limitFor(method: string, path: string, headers: Headers): Limit | null {
  const isServerAction =
    method === 'POST' && headers.get('next-action') !== null

  // Only rate-limit write methods.
  if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return null

  // Server Actions (POST to page routes with Next-Action header)
  if (isServerAction) {
    // All Server Action writes: 30/min per user
    return { capacity: 30, perMinute: 30, byIp: false }
  }

  // /api/posts/*/view → IP-keyed, 30/min
  if (/^\/api\/posts\/[^/]+\/view\/?$/.test(path)) {
    return { capacity: 30, perMinute: 30, byIp: true }
  }
  // POST /api/posts (create) exactly → 10/min per user
  if (path === '/api/posts' || path === '/api/posts/') {
    return { capacity: 10, perMinute: 10, byIp: false }
  }
  // Any other /api write → 30/min per user
  if (path.startsWith('/api/')) {
    return { capacity: 30, perMinute: 30, byIp: false }
  }
  return null
}

/* ── Main proxy entry ─────────────────────────────────────── */

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // The versioned public API belongs exclusively to the dedicated API
  // process. Nginx routes it before requests reach Next.js; this guard keeps
  // the boundary explicit for loopback/direct requests as well.
  if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Resource not found.' } },
      { status: 404 },
    )
  }

  // ── API rate limiting ──
  if (pathname.startsWith('/api/')) {
    const limit = limitFor(request.method.toUpperCase(), pathname, request.headers)
    if (limit) {
      const identityKey = await resolveIdentity(request)
      const key = limit.byIp ? `ip:${clientIp(request)}` : identityKey
      if (!allow(key, limit.capacity, limit.perMinute)) {
        const retryAfter = Math.ceil(60 / limit.perMinute)
        return NextResponse.json(
          { error: t.errors.tooManyRequests },
          {
            status: 429,
            headers: {
              'Retry-After': String(retryAfter),
              'X-RateLimit-Limit': String(limit.capacity),
            },
          },
        )
      }
    }
    return NextResponse.next()
  }

  // ── Server Action rate limiting (POST to page routes) ──
  if (request.method.toUpperCase() === 'POST' && request.headers.get('next-action')) {
    const limit = limitFor('POST', pathname, request.headers)
    if (limit) {
      const identityKey = await resolveIdentity(request)
      const key = limit.byIp ? `ip:${clientIp(request)}` : identityKey
      if (!allow(key, limit.capacity, limit.perMinute)) {
        const retryAfter = Math.ceil(60 / limit.perMinute)
        return new NextResponse('Too Many Requests', {
          status: 429,
          headers: { 'Retry-After': String(retryAfter) },
        })
      }
    }
  }

  // ── Optimistic auth check (page routes) ──
  const session = request.cookies.get(SESSION_COOKIE)?.value

  // Protected routes: if no session cookie at all, redirect to /login.
  // The check is OPTIMISTIC (cookie presence only) — full session validation
  // happens in server components via getCurrentUser(). This keeps unauthenticated
  // visitors off /settings, /messages, etc. without a DB hit on every request.
  if (!session && isProtected(pathname)) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  // Run on API routes (rate limiting) + page routes (optimistic auth),
  // excluding Next internals and static assets.
  matcher: [
    '/api/:path*',
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
}
