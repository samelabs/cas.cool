/**
 * Client-side image compression — runs entirely in the browser before upload.
 *
 * Mirrors the server-side sharp pipeline (resize longest edge to 2048px,
 * re-encode at quality 80) so the two layers agree on the output format
 * and there is no double-compression quality loss.
 *
 * Uses canvas.toBlob which is supported by every browser since 2015.
 * GIFs are passed through untouched — canvas flattens animation.
 *
 * Why this exists: Server Actions transport file bodies as base64, which
 * inflates 33% and hits the framework body-size limit before our code runs.
 * Compressing on the client keeps every image well under that limit and
 * gives us a natural place to show a friendly size warning.
 */

const MAX_DIMENSION = 2048
const QUALITY = 0.8
/** Hard cap on raw file size before compression is attempted. */
const MAX_RAW_BYTES = 10 * 1024 * 1024 // 10MB

export interface CompressResult {
  blob: Blob
  /** Compressed size in bytes. */
  bytes: number
  /** Was the image compressed, or passed through (GIF / already small)? */
  compressed: boolean
}

/**
 * Compress an image file in the browser.
 * Returns null for undecodable / unsupported files.
 * Throws if the raw file exceeds MAX_RAW_BYTES.
 */
export async function compressImage(file: File): Promise<CompressResult | null> {
  if (file.size > MAX_RAW_BYTES) {
    throw new Error(`File too large (max ${Math.round(MAX_RAW_BYTES / 1024 / 1024)}MB)`)
  }

  // GIF: preserve animation, don't touch.
  if (file.type === 'image/gif') {
    return { blob: file, bytes: file.size, compressed: false }
  }

  // Decode the image into a bitmap.
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }

  // Skip compression if the image is already small enough.
  const longestEdge = Math.max(bitmap.width, bitmap.height)
  if (longestEdge <= MAX_DIMENSION && file.size < 1024 * 1024) {
    return { blob: file, bytes: file.size, compressed: false }
  }

  // Draw onto a canvas at the target size.
  const canvas = document.createElement('canvas')
  let { width, height } = bitmap
  if (longestEdge > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / longestEdge
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  // Encode to WebP.
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null)
          return
        }
        resolve({ blob, bytes: blob.size, compressed: true })
      },
      'image/webp',
      QUALITY,
    )
  })
}
