/**
 * GET /api/account/capabilities — query current identity and dynamic capabilities.
 *
 * Auth: optional. Works for anonymous, session, and API key callers.
 * Returns safe capability metadata without leaking credentials or private data.
 * Always served with Cache-Control: no-store.
 */

import { resolveIdentity } from '@/lib/api-auth'
import { computeCapabilities } from '@/lib/permissions'

export async function GET() {
  const identity = await resolveIdentity()
  const capabilities = computeCapabilities(identity)

  return Response.json(capabilities, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    },
  })
}
