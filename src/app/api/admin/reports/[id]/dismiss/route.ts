/**
 * POST /api/admin/reports/[id]/dismiss — dismiss report.
 *
 * Auth: Admin (write).
 */

import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const admin = auth.identity.user!
  const { id: reportId } = await params

  const report = await prisma.report.findUnique({ where: { id: reportId }, select: { id: true, status: true } })
  if (!report) return jsonError(404, 'not_found', 'Report not found.')
  if (report.status !== 'PENDING')
    return jsonError(400, 'bad_request', 'Report already handled.')

  await prisma.report.update({
    where: { id: reportId },
    data: {
      status: 'DISMISSED',
      handledBy: admin.id,
      handledAt: new Date(),
    },
  })

  return Response.json({ ok: true })
}
