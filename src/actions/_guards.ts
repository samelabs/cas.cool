'use server'

import { getCurrentUser } from '@/lib/auth'
import { getAdminUser } from '@/lib/admin'
import { ActionError, type ActionResult } from './_shared'

/** Require an authenticated, active user. Throws on failure. */
export async function requireUser() {
  const user = await getCurrentUser()
  if (!user) throw new ActionError('UNAUTHORIZED', 'Login required.')
  if (user.status !== 'active') throw new ActionError('FORBIDDEN', 'Account restricted.')
  return user
}

/** Require an admin user. Throws on failure. */
export async function requireAdmin() {
  const admin = await getAdminUser()
  if (!admin) throw new ActionError('FORBIDDEN', 'Admin access required.')
  return admin
}

export async function withResult<T>(
  fn: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    if (e instanceof ActionError) {
      return { ok: false, error: e.message }
    }
    console.error('Action failed:', e)
    return { ok: false, error: 'An unexpected error occurred.' }
  }
}
