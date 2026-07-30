import { getCurrentUser } from '@/lib/auth'

/**
 * Returns the current user if they have admin role, otherwise null.
 * Used as a guard in all admin API routes and server components.
 */
export async function getAdminUser() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return null
  return user
}
