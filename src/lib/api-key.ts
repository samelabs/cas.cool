import { createHash, randomBytes } from 'crypto'

const KEY_PREFIX = 'cas_'
const KEY_RANDOM_LENGTH = 32

/** Generate an API key and the non-secret values persisted by the web BFF. */
export function generateApiKey(): {
  rawKey: string
  keyHash: string
  prefix: string
} {
  const random = randomBytes(24).toString('base64url').slice(0, KEY_RANDOM_LENGTH)
  const rawKey = KEY_PREFIX + random
  return {
    rawKey,
    keyHash: hashApiKey(rawKey),
    prefix: random.slice(0, 8),
  }
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}
