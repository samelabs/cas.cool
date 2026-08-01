/**
 * POST   /api/users/[username]/follow  — follow user
 * DELETE /api/users/[username]/follow  — unfollow user
 *
 * Auth: API Key or Session (write).
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { upsertNotification } from '@/lib/notification'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

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

  const target = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: { id: true, username: true },
  })
  if (!target) return jsonError(404, 'not_found', 'User not found.')
  if (target.id === user.id) return jsonError(400, 'bad_request', 'Cannot follow yourself.')

  // Idempotent: if already following, just return success.
  try {
    await prisma.$transaction([
      prisma.follow.create({ data: { followerId: user.id, followingId: target.id } }),
      prisma.user.update({ where: { id: user.id }, data: { followingCount: { increment: 1 } } }),
      prisma.user.update({ where: { id: target.id }, data: { followerCount: { increment: 1 } } }),
    ])
  } catch (e: unknown) {
    // P2002 unique-constraint violation → already following, treat as success.
    if (!(e instanceof Error && 'code' in e && e.code === 'P2002')) throw e
  }

  await upsertNotification({ userId: target.id, fromId: user.id, type: 'FOLLOW' })

  return Response.json({ following: true })
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

  const target = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: { id: true, username: true },
  })
  if (!target) return jsonError(404, 'not_found', 'User not found.')
  if (target.id === user.id) return jsonError(400, 'bad_request', 'Cannot unfollow yourself.')

  const existing = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: user.id, followingId: target.id } },
  })

  if (!existing) {
    // Not following — idempotent success.
    return Response.json({ following: false })
  }

  // deleteMany + count guard prevents underflow.
  await prisma.$transaction(async (tx) => {
    const deleted = await tx.follow.deleteMany({
      where: { followerId: user.id, followingId: target.id },
    })
    if (deleted.count > 0) {
      await tx.user.update({ where: { id: user.id }, data: { followingCount: { decrement: 1 } } })
      await tx.user.update({ where: { id: target.id }, data: { followerCount: { decrement: 1 } } })
    }
  })

  return Response.json({ following: false })
}
