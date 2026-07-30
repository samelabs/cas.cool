import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { prisma } from './db'
import { HttpError } from './http'

export interface ApiUser {
  id: string
  username: string
  displayName: string | null
  verificationStatus: string
  status: string
  role: string
  apiKeyId: string
}

export async function authenticate(req: IncomingMessage): Promise<ApiUser> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) unauthorized()

  const rawKey = header.slice(7)
  if (!rawKey.startsWith('cas_') || rawKey.length < 20 || rawKey.length > 128) unauthorized()

  const keyHash = createHash('sha256').update(rawKey).digest('hex')
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  })
  if (!apiKey || apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt < new Date())) unauthorized()

  const user = await prisma.user.findUnique({
    where: { id: apiKey.userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      verificationStatus: true,
      verificationExpiresAt: true,
      status: true,
      role: true,
    },
  })
  if (
    !user ||
    user.status !== 'active' ||
    user.verificationStatus !== 'verified' ||
    (user.verificationExpiresAt && user.verificationExpiresAt < new Date())
  ) unauthorized()

  void prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {})
  return { ...user, apiKeyId: apiKey.id }
}

function unauthorized(): never {
  throw new HttpError(401, 'unauthorized', 'Valid API key required.')
}
