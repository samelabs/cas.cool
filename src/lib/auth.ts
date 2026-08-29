import { SignJWT, jwtVerify } from 'jose'
import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { cache } from 'react'
import { prisma } from './db'
import { userSelect } from './serialize'

const SESSION_COOKIE = 'cas_session'
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000 // 30 days

// Lazy-load secret (must be text, not Buffer, for jose)
let _secret: Uint8Array | null = null
function getSecret(): Uint8Array {
  if (!_secret) {
    const key = process.env.JWT_SECRET
    if (!key) {
      throw new Error('JWT_SECRET environment variable is not set. Refusing to start with insecure default.')
    }
    _secret = new TextEncoder().encode(key)
  }
  return _secret
}

export interface JWTPayload {
  userId: string
}

export async function createSession(userId: string): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_DURATION)
  const token = await new SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .setIssuedAt()
    // Unique per issuance — without this, two sessions signed for the same
    // user within the same second produce identical tokens and the DB insert
    // below dies on the Session.token unique constraint (P2002 → login 500).
    .setJti(randomUUID())
    .sign(getSecret())

  // Store session in DB
  await prisma.session.create({
    data: { userId, token, expiresAt }
  })

  return token
}

export async function getSession(): Promise<JWTPayload | null> {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(SESSION_COOKIE)?.value
    if (!token) return null

    // 1. Verify JWT signature + expiry
    const { payload } = await jwtVerify(token, getSecret())
    const userId = payload.userId as string
    if (!userId) return null

    // 2. Verify the session still exists in the DB and hasn't been revoked.
    //    Password change deletes all sessions; explicit logout deletes the
    //    current one. Without this check a stolen JWT stays valid for 30 days.
    const session = await prisma.session.findUnique({
      where: { token },
      select: { userId: true, expiresAt: true },
    })
    if (!session) return null
    if (session.expiresAt < new Date()) return null

    return { userId: session.userId }
  } catch {
    return null
  }
}

export const getCurrentUser = cache(async () => {
  const session = await getSession()
  if (!session) return null

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      ...userSelect,
      email: true,
    }
  })
  return user
})

export async function getActiveUser() {
  const user = await getCurrentUser()
  if (!user) return null
  // Suspended users are treated as logged out (sessions already revoked)
  if (user.status === 'suspended') return null
  return user
}

/** Check if user can perform write operations (post, comment, message). */
export function canWrite(user: { status: string } | null): boolean {
  return !!user && user.status === 'active'
}

export async function setSessionCookie(token: string) {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DURATION / 1000,
  })
}

export async function clearSession() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (token) {
    // Only delete the current session, not all sessions for this user
    await prisma.session.deleteMany({ where: { token } }).catch(() => {})
  }
  cookieStore.delete(SESSION_COOKIE)
}

export { SESSION_COOKIE }
