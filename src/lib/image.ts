import sharp from 'sharp'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

/**
 * Image upload pipeline — single source of truth for every image that enters
 * the system (post images, avatars, covers, ...).
 *
 * All static raster uploads are normalised to WebP:
 *   - EXIF orientation is honoured (.rotate() with no angle)
 *   - the longest edge is capped (withoutEnlargement so tiny images aren't
 *     blown up)
 *   - re-encoded at a fixed quality
 * This typically cuts a phone photo from ~4-8MB to a few hundred KB with no
 * visible quality loss, and gives every stored image a uniform format.
 *
 * Animated GIFs are an exception: sharp flattens them to a single frame, so we
 * pass them through unchanged to preserve animation.
 *
 * Design note: this module owns validation, compression and storage. Callers
 * only handle HTTP-level policy (size limit response codes, how many files,
 * etc.) and receive a { url } back. Both /api/upload and the multipart branch
 * of /api/posts route through here so there is exactly one image code path.
 */

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads')

/** Hard cap on the raw uploaded bytes, before any processing. */
export const MAX_RAW_BYTES = 10 * 1024 * 1024 // 10MB

/**
 * Tighter cap for GIFs. GIFs bypass sharp re-encoding (to preserve
 * animation) and land on disk byte-for-byte, so a 10MB GIF is a 10MB
 * permanent disk cost. 5MB keeps the disk-fill vector bounded while
 * staying above any reasonable animated sticker/loop.
 */
export const MAX_GIF_BYTES = 5 * 1024 * 1024 // 5MB

/**
 * Upload purpose presets — callers tag what the image is for so the pipeline
 * can pick the right max dimension / quality. This keeps a single code path
 * (one processAndStoreImage, one /api/upload) while ensuring avatars don't
 * waste bandwidth at 2048px.
 */
export type UploadPurpose = 'post' | 'avatar' | 'banner' | 'verification'

const PURPOSE_PRESETS: Record<UploadPurpose, { maxDimension: number; quality: number }> = {
  post: { maxDimension: 2048, quality: 80 },
  avatar: { maxDimension: 400, quality: 75 },
  banner: { maxDimension: 1500, quality: 80 },
  verification: { maxDimension: 2048, quality: 80 },
}

const MIME_TO_EXT: Record<string, ImageKind> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const MAGIC_BYTES: Record<ImageKind, number[]> = {
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  webp: [0x52, 0x49, 0x46, 0x46], // "RIFF"
  gif: [0x47, 0x49, 0x46, 0x38], // "GIF8"
}

export type ImageKind = 'jpg' | 'png' | 'webp' | 'gif'
export type StoredKind = 'webp' | 'gif'

export interface ProcessOptions {
  /** Tag the image so the pipeline applies the right size/quality preset. */
  purpose?: UploadPurpose
}

export interface ProcessedImage {
  /** Public URL path, e.g. /uploads/<uuid>.webp */
  url: string
  /** Filename only, e.g. <uuid>.webp */
  filename: string
  /** Bytes written to disk (post-compression). */
  bytes: number
  /** Final stored format. */
  kind: StoredKind
}

/**
 * Sniff the real format from the first bytes of the buffer. More trustworthy
 * than the client-supplied Content-Type, which we still cross-check.
 */
export function detectImageKind(buf: Buffer): ImageKind | null {
  for (const [kind, magic] of Object.entries(MAGIC_BYTES)) {
    if (magic.every((b, i) => buf[i] === b)) return kind as ImageKind
  }
  return null
}

/**
 * Validate, compress and store one uploaded image.
 *
 * @param buffer     Raw upload bytes.
 * @param mimeType   The Content-Type the client declared (cross-checked
 *                   against magic bytes; mismatch => rejected).
 * @param opts       Optional overrides for max dimension / quality.
 * @returns The stored image, or `null` if the buffer is not a decodable image
 *          of an allowed type (corrupt data, spoofed extension, etc.).
 */
export async function processAndStoreImage(
  buffer: Buffer,
  mimeType: string,
  opts: ProcessOptions = {},
): Promise<ProcessedImage | null> {
  const declaredKind = MIME_TO_EXT[mimeType]
  const magicKind = detectImageKind(buffer)
  if (!declaredKind || !magicKind || magicKind !== declaredKind) return null

  await mkdir(UPLOAD_DIR, { recursive: true })

  // Animated GIF: pass through untouched so animation survives — but
  // bounded by the tighter GIF-specific cap (see MAX_GIF_BYTES).
  if (magicKind === 'gif') {
    if (buffer.length > MAX_GIF_BYTES) return null
    const filename = `${randomUUID()}.gif`
    await writeFile(path.join(UPLOAD_DIR, filename), buffer)
    return { url: `/uploads/${filename}`, filename, bytes: buffer.length, kind: 'gif' }
  }

  const preset = PURPOSE_PRESETS[opts.purpose ?? 'post']
  const maxDimension = preset.maxDimension
  const quality = preset.quality

  let out: Buffer
  try {
    out = await sharp(buffer)
      .rotate() // honour EXIF orientation (phone photos)
      .resize(maxDimension, maxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality })
      .toBuffer()
  } catch {
    return null // corrupt / undecodable raster
  }

  const filename = `${randomUUID()}.webp`
  await writeFile(path.join(UPLOAD_DIR, filename), out)
  return { url: `/uploads/${filename}`, filename, bytes: out.length, kind: 'webp' }
}
