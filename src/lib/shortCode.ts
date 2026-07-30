/**
 * Build the canonical short URL path for a post.
 * shortCode is always present (enforced at DB level + backfilled).
 * No UUID fallback — that would create a divergent URL scheme.
 */
export function postUrl(post: { shortCode?: string | null; id: string }): string {
  return `/p/${post.shortCode ?? ''}`
}

/**
 * Short code generator for post URLs.
 *
 * Uses a 54-character alphabet (base62 minus ambiguous chars 0/O/1/I/l)
 * to produce 8-character codes. With 54^8 ≈ 72 trillion combinations,
 * collisions are negligible for our scale (~150K posts).
 *
 * URL format: /p/Ab3xY9zK (8 chars)
 *
 * Uses globalThis.crypto (Web Crypto API, available in Node 19+ and all
 * modern browsers without importing the Node `crypto` module). This avoids
 * pulling crypto-browserify (428 KB) into the client bundle.
 *
 * All functions in this file are browser-safe — no server-only imports.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ'
const BASE = ALPHABET.length
const CODE_LENGTH = 8

export function generateShortCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % BASE]
  }
  return code
}
