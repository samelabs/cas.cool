'use server'

import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { createSession, setSessionCookie, clearSession } from '@/lib/auth'
import { sanitizeUsername } from '@/lib/utils'
import { revalidatePath } from 'next/cache'
import { ActionResult, ActionError } from './_shared'
import { withResult } from './_guards'
import { userSelect, serializeUser } from '@/lib/serialize'
import type { SafeUser } from '@/lib/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const RESERVED = new Set([
  'admin', 'api', 'auth', 'cas', 'compose', 'explore', 'login', 'logout',
  'register', 'settings', 'notifications', 'messages', 'bookmarks',
  'post', 'posts', 'search', 'about', 'u', 'uploads', '_next',
])

export async function login(identifier: string, password: string): Promise<ActionResult<{ user: SafeUser }>> {
  return withResult(async () => {
    const cleanId = identifier.trim()
    if (!cleanId || !password) throw new ActionError('BAD_REQUEST', 'Please fill in all fields.')

    const where = EMAIL_RE.test(cleanId.toLowerCase())
      ? { email: cleanId.toLowerCase() }
      : { username: cleanId.toLowerCase() }
    const user = await prisma.user.findUnique({
      where,
      select: { ...userSelect, passwordHash: true },
    })

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new ActionError('UNAUTHORIZED', 'Invalid email/username or password.')
    }
    if (user.status === 'suspended') {
      throw new ActionError('FORBIDDEN', 'This account has been suspended.')
    }

    const token = await createSession(user.id)
    await setSessionCookie(token)

    revalidatePath('/')
    const { passwordHash, ...safe } = user
    return { user: serializeUser(safe) }
  })
}

export async function register(input: {
  email: string; username: string; password: string; displayName?: string
}): Promise<ActionResult<{ user: SafeUser }>> {
  return withResult(async () => {
    const emailLower = input.email.trim().toLowerCase()
    const cleanUsername = sanitizeUsername(input.username.trim())

    if (!EMAIL_RE.test(emailLower)) throw new ActionError('BAD_REQUEST', 'Invalid email address.')
    if (!cleanUsername || cleanUsername.length < 3) throw new ActionError('BAD_REQUEST', 'Username must be at least 3 characters.')
    if (!input.password || input.password.length < 8) throw new ActionError('BAD_REQUEST', 'Password must be at least 8 characters.')
    if (input.password.length > 128) throw new ActionError('BAD_REQUEST', 'Password is too long.')
    if (RESERVED.has(cleanUsername.toLowerCase())) throw new ActionError('BAD_REQUEST', 'This username is reserved.')

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: emailLower }, { username: cleanUsername }] },
      select: { email: true, username: true },
    })
    if (existing) {
      if (existing.email === emailLower) throw new ActionError('CONFLICT', 'This email is already registered.')
      throw new ActionError('CONFLICT', 'This username is already taken.')
    }

    const passwordHash = await bcrypt.hash(input.password, 10)
    const user = await prisma.user.create({
      data: {
        email: emailLower,
        username: cleanUsername,
        displayName: input.displayName?.trim() || null,
        passwordHash,
      },
      select: userSelect,
    })

    const token = await createSession(user.id)
    await setSessionCookie(token)

    revalidatePath('/')
    return { user: serializeUser(user) }
  })
}

export async function logout(): Promise<ActionResult<{ success: boolean }>> {
  return withResult(async () => {
    await clearSession()
    revalidatePath('/')
    return { success: true }
  })
}

export async function checkUsernameAvailable(username: string): Promise<ActionResult<{ available: boolean }>> {
  return withResult(async () => {
    const clean = sanitizeUsername(username)
    if (!clean || clean.length < 3) return { available: false }
    if (RESERVED.has(clean.toLowerCase())) return { available: false }
    const existing = await prisma.user.findUnique({ where: { username: clean }, select: { id: true } })
    return { available: !existing }
  })
}
