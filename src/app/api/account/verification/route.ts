/**
 * POST /api/account/verification — submit verification request
 *
 * Body: { idName, idNumber, idFrontImage, idBackImage }
 * Image URLs come from prior /api/upload calls (purpose=verification).
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.ok) return auth.response
  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const user = auth.identity.user!

  if (user.verificationStatus === 'pending') {
    return jsonError(400, 'bad_request', 'Already under review.')
  }
  if (user.verificationStatus === 'verified') {
    const existing = await prisma.verificationSubmission.findUnique({
      where: { userId: user.id },
      select: { status: true },
    })
    if (existing?.status === 'approved') {
      return jsonError(400, 'bad_request', 'Already verified.')
    }
  }

  const body = await request.json().catch(() => null)
  if (!body) return jsonError(400, 'bad_request', 'Invalid JSON.')

  const idName = typeof body.idName === 'string' ? body.idName.trim() : ''
  const idNumber = typeof body.idNumber === 'string' ? body.idNumber.trim() : ''
  const idFrontImage = typeof body.idFrontImage === 'string' ? body.idFrontImage.trim() : ''
  const idBackImage = typeof body.idBackImage === 'string' ? body.idBackImage.trim() : ''

  if (!idName || !idNumber || !idFrontImage || !idBackImage) {
    return jsonError(400, 'bad_request', 'All fields are required.')
  }
  if (!idFrontImage.startsWith('/uploads/') || !idBackImage.startsWith('/uploads/')) {
    return jsonError(400, 'bad_request', 'Invalid image file.')
  }

  const wasVerified = user.verificationStatus === 'verified'

  await prisma.$transaction([
    prisma.verificationSubmission.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id, idName, idNumber, idFrontImage, idBackImage,
        status: 'pending',
      },
      update: {
        idName, idNumber, idFrontImage, idBackImage,
        status: 'pending', reviewedAt: null, reviewNote: null, reviewedBy: null,
      },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: wasVerified ? {} : { verificationStatus: 'pending' },
    }),
  ])

  return Response.json({ ok: true })
}
