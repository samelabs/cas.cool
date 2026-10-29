/**
 * /api/posts/[code]/like
 * /api/posts/[code]/bookmark
 * /api/posts/[code]/repost
 *
 * POST   → activate (like / bookmark / repost)
 * DELETE → deactivate
 *
 * HTTP shell only — domain rules and transactions live in
 * src/lib/services/post.service.ts.
 */

import { NextRequest } from 'next/server'
import { requireWrite } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { setPostInteraction, type InteractionAction } from '@/lib/services/interaction.service'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

async function run(
  code: string,
  action: string,
  active: boolean,
  auth: Awaited<ReturnType<typeof requireWrite>>,
) {
  const user = auth.ok ? auth.identity.user! : null

  if (
    !user ||
    (action !== 'like' && action !== 'bookmark' && action !== 'repost')
  ) {
    return jsonError(404, 'not_found', 'Unknown action.')
  }

  const result = await setPostInteraction(
    { id: user.id, verificationStatus: user.verificationStatus, role: user.role },
    code,
    action as InteractionAction,
    active,
  )
  if (!result.ok) {
    return Response.json({ error: { code: result.error.code, message: result.error.message } }, { status: result.error.status })
  }
  return Response.json(result.data)
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string; action: string }> },
) {
  const { code, action } = await params
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  return run(code, action, true, auth)
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string; action: string }> },
) {
  const { code, action } = await params
  const auth = await requireWrite()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  return run(code, action, false, auth)
}
