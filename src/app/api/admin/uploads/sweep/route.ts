/**
 * POST /api/admin/uploads/sweep — sweep unreferenced, out-of-grace upload
 * files from both storage trees (public post media + private verification
 * attachments).
 *
 * Auth: Admin (write). Intended for the deployment's scheduler (e.g. a
 * daily curl with an admin session) and for on-demand runs. Safe against
 * concurrent traffic: the reference check runs immediately before each
 * unlink, and files younger than the grace window are never touched.
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { sweepUploads } from '@/lib/upload-sweep'

export async function POST(_request: NextRequest) {
  const auth = await requireAdmin('write')
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const outcome = await sweepUploads()
  return Response.json({
    scanned: outcome.scanned,
    deleted: outcome.deleted,
    keptReferenced: outcome.outcomes.filter((o) => o.action === 'kept-referenced').length,
    keptInGrace: outcome.outcomes.filter((o) => o.action === 'kept-in-grace').length,
    errors: outcome.errors,
  })
}
