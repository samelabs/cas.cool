/**
 * /api/posts/[code]
 *
 * GET    /api/posts/:code                      — get single post by shortCode
 * PATCH  /api/posts/:code                      — edit own post (60min window)
 * DELETE /api/posts/:code                      — soft-delete own post (or admin)
 *
 * Interaction actions (like/bookmark/repost) live in
 * /api/posts/[code]/[action]; view counting lives in /api/posts/[code]/view.
 *
 * HTTP shell only — post.service.ts composes reads and
 * post-write.service.ts composes write transactions.
 */

import { NextRequest } from 'next/server'
import { requireWrite, resolveIdentity } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { deletePost, editPost } from '@/lib/services/post-write.service'
import { getPostByShortCode } from '@/lib/services/post.service'
import type { ServiceError } from '@/lib/services/post.service'

function serviceError(e: ServiceError) {
  return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status })
}

// ── GET /api/posts/:code ──────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params

  // Read-tier rate limit (per-user for sessions, IP-keyed for anonymous).
  const identity = await resolveIdentity()
  const limited = checkRateLimit(identity, 'read')
  if (limited) return limited

  const userId = identity.authenticated && identity.user ? identity.user.id : null

  const post = await getPostByShortCode(code, userId)
  if (!post || post.deletedAt) {
    return Response.json({ error: { code: 'not_found', message: 'Post not found.' } }, { status: 404 })
  }
  return Response.json(post)
}

// ── PATCH /api/posts/:code (edit) ─────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const body = await request.json().catch(() => null)
  if (!body) {
    return Response.json({ error: { code: 'bad_request', message: 'Invalid JSON.' } }, { status: 400 })
  }

  const result = await editPost(
    { id: auth.identity.user!.id, verificationStatus: auth.identity.user!.verificationStatus, role: auth.identity.user!.role },
    code,
    {
      content: typeof body.content === 'string' ? body.content.trim() : '',
      images: Array.isArray(body.images)
        ? body.images.filter((u: unknown) => typeof u === 'string' && u.startsWith('/uploads/'))
        : undefined,
      casNumbers: Array.isArray(body.casNumbers) ? body.casNumbers : null,
    },
  )
  if (!result.ok) return serviceError(result.error)
  return Response.json(result.data)
}

// ── DELETE /api/posts/:code (soft-delete) ─────────────────────

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const result = await deletePost(
    { id: auth.identity.user!.id, verificationStatus: auth.identity.user!.verificationStatus, role: auth.identity.user!.role },
    code,
  )
  if (!result.ok) return serviceError(result.error)
  return Response.json({ success: true })
}
