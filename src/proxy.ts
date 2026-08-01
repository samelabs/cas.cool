import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Next.js 16 "proxy" (formerly middleware).
 *
 * Single responsibility: OPTIMISTIC auth check for protected page routes.
 *
 * Based purely on the presence of the `cas_session` cookie. Real session
 * validation happens in server components / route handlers via resolveIdentity().
 * This just keeps unauthenticated visitors off the protected app shell.
 *
 * Publicly viewable without auth: /, /explore, /p/*, /u/*,
 * /login, /register. Protected: /settings, /messages, /notifications,
 * /bookmarks, /compose, /admin.
 *
 * All API rate limiting is handled inside Route Handlers via rate-limit.ts.
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

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

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
    '/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
}
