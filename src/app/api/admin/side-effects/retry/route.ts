/**
 * POST /api/admin/side-effects/retry — drain the side-effect outbox.
 *
 * Auth: Admin (write).
 *
 * Executes at most 500 claimable pending tasks (idempotent executors).
 * The response reports this run's outcomes and failures; `pending` is the
 * global remaining count. Only owned write-backs count as success/failure,
 * so an execution superseded after lease expiry counts only as attempted.
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { drainSideEffects } from '@/lib/services/side-effect.service'

export async function POST(_request: NextRequest) {
  const auth = await requireAdmin('write')
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const result = await drainSideEffects({ limit: 500 })
  return Response.json({
    attempted: result.attempted,
    succeeded: result.succeeded,
    failed: result.failed,
    pending: result.pending,
    failedTasks: result.failedTasks,
  })
}
