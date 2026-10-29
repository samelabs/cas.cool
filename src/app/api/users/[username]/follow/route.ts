/**
 * POST   /api/users/[username]/follow  — follow user
 * DELETE /api/users/[username]/follow  — unfollow user
 *
 * Auth: API Key or Session (write).
 */

import { NextRequest } from 'next/server'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { setUserFollow } from '@/lib/services/follow.service'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!
  const { username } = await params

  const result = await setUserFollow(user, username, true)
  if (!result.ok) {
    return jsonError(result.error.status, result.error.code, result.error.message)
  }

  return Response.json(result.data)
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const auth = await requireWrite()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!
  const { username } = await params

  const result = await setUserFollow(user, username, false)
  if (!result.ok) {
    return jsonError(result.error.status, result.error.code, result.error.message)
  }

  return Response.json(result.data)
}
