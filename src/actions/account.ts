'use server'

import { prisma } from '@/lib/db'

import { processAndStoreImage, MAX_RAW_BYTES } from '@/lib/image'
import { generateApiKey } from '@/lib/api-key'
import { revalidatePath } from 'next/cache'
import { ActionResult, ActionError, assertCanWrite } from './_shared'
import { withResult, requireUser } from './_guards'

const MAX_ACTIVE_KEYS = 5

// ─── Verification ─────────────────────────────────────────────

export async function getVerificationStatus(): Promise<ActionResult<{
  verificationStatus: string
  verifiedAt: Date | null
  submission: {
    id: string; status: string; idName: string
    submittedAt: Date; reviewedAt: Date | null
    expiresAt: Date | null; reviewNote: string | null
  } | null
}>> {
  return withResult(async () => {
    const user = await requireUser()

    const submission = await prisma.verificationSubmission.findUnique({ where: { userId: user.id } })

    return {
      verificationStatus: user.verificationStatus,
      verifiedAt: user.verifiedAt,
      submission: submission ? {
        id: submission.id, status: submission.status, idName: submission.idName,
        submittedAt: submission.submittedAt, reviewedAt: submission.reviewedAt,
        expiresAt: submission.expiresAt, reviewNote: submission.reviewNote,
      } : null,
    }
  })
}

export async function submitVerification(input: {
  idName: string
  idNumber: string
  idFrontImage: string
  idBackImage: string
}): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()

    if (user.verificationStatus === 'pending') throw new ActionError('BAD_REQUEST', 'Already under review.')

    if (user.verificationStatus === 'verified') {
      const existing = await prisma.verificationSubmission.findUnique({
        where: { userId: user.id }, select: { status: true },
      })
      if (existing?.status === 'approved') throw new ActionError('BAD_REQUEST', 'Already verified.')
    }

    const idName = input.idName?.trim()
    const idNumber = input.idNumber?.trim()
    const idFrontImage = input.idFrontImage?.trim()
    const idBackImage = input.idBackImage?.trim()

    if (!idName || !idNumber || !idFrontImage || !idBackImage) {
      throw new ActionError('BAD_REQUEST', 'All fields are required.')
    }
    if (!idFrontImage.startsWith('/uploads/') || !idBackImage.startsWith('/uploads/')) {
      throw new ActionError('BAD_REQUEST', 'Invalid image file.')
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

    revalidatePath('/verify')
    return { ok: true }
  })
}

export async function uploadVerificationImage(file: File): Promise<ActionResult<{ url: string; filename: string; bytes: number }>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)

    if (file.size === 0) throw new ActionError('BAD_REQUEST', 'File is empty.')
    if (file.size > MAX_RAW_BYTES) throw new ActionError('BAD_REQUEST', 'File is too large.')

    const buffer = Buffer.from(await file.arrayBuffer())
    const processed = await processAndStoreImage(buffer, file.type, { purpose: 'verification' })
    if (!processed) throw new ActionError('BAD_REQUEST', 'Invalid image file.')

    return { url: processed.url, filename: processed.filename, bytes: processed.bytes }
  })
}

// ─── API Keys ─────────────────────────────────────────────────

export async function listApiKeys(): Promise<ActionResult<{
  keys: Array<{ id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null }>
}>> {
  return withResult(async () => {
    const user = await requireUser()

    const keys = await prisma.apiKey.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    })

    return { keys }
  })
}

export async function createApiKey(name: string, expiresAt?: string): Promise<ActionResult<{
  id: string; name: string; prefix: string; createdAt: Date; rawKey: string
}>> {
  return withResult(async () => {
    const user = await requireUser()
    assertCanWrite(user)
    if (user.verificationStatus !== 'verified') throw new ActionError('FORBIDDEN', 'Verification required.')

    const cleanName = name.trim().slice(0, 100)
    if (!cleanName) throw new ActionError('BAD_REQUEST', 'Name is required.')

    const parsedExpiry = expiresAt ? new Date(expiresAt) : null
    if (expiresAt && (!parsedExpiry || isNaN(parsedExpiry.getTime()))) {
      throw new ActionError('BAD_REQUEST', 'Invalid expiry date.')
    }

    const activeCount = await prisma.apiKey.count({ where: { userId: user.id, revokedAt: null } })
    if (activeCount >= MAX_ACTIVE_KEYS) throw new ActionError('BAD_REQUEST', 'Maximum active keys reached.')

    const { rawKey, keyHash, prefix } = generateApiKey()
    const apiKey = await prisma.apiKey.create({
      data: { userId: user.id, name: cleanName, keyHash, prefix, expiresAt: parsedExpiry },
      select: { id: true, name: true, prefix: true, createdAt: true },
    })

    return { ...apiKey, rawKey }
  })
}

export async function revokeApiKey(keyId: string): Promise<ActionResult<{ ok: boolean }>> {
  return withResult(async () => {
    const user = await requireUser()

    await prisma.apiKey.updateMany({
      where: { id: keyId, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })

    revalidatePath('/settings/api')
    return { ok: true }
  })
}
