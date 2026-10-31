/**
 * Media storage configuration — the single source of the physical storage
 * roots and URL prefixes for both attachment boundaries.
 *
 * Roots come from SERVER RUNTIME environment variables:
 *   UPLOAD_DIR           public post media, served at /uploads/
 *   PRIVATE_UPLOAD_DIR   private verification attachments, readable only
 *                        through GET /api/media/verification/[filename]
 *
 * Why runtime env, and no cwd-anchored default: Next.js build-time output
 * file tracing statically follows literal `path.join(process.cwd(), ...)`
 * expressions and drags the resulting directory into the build dependency
 * analysis. When the media roots are symlinks into shared storage outside
 * the project root, that analysis walks (and fails on) the real media tree.
 * A `process.env` read resolves only at request time, so no media path is
 * visible to the build. This is also why these values must never be inlined
 * via the next.config `env` field or a NEXT_PUBLIC_* name: they are server
 * runtime configuration, not build constants.
 *
 * Consequence: misconfiguration must FAIL LOUDLY here. There is deliberately
 * no fallback — a missing or invalid root is an operator error, and letting
 * any module pick its own directory would fork writes from cleanup.
 *
 * Validation is pure string logic: it never scans, stats or packs media
 * files (that would reintroduce the build-time coupling described above).
 */

import path from 'node:path'

/** URL prefix under which public media is served (Nginx aliases /uploads/
 *  to the same physical storage UPLOAD_DIR points at). */
export const PUBLIC_UPLOAD_URL_PREFIX = '/uploads'

/** URL prefix returned for private verification media; served only through
 *  the identity-gated media route, never from a static directory. */
export const VERIFICATION_MEDIA_PREFIX = '/api/media/verification'

/** The two storage roots, keyed the way every consumer addresses them. */
export interface UploadDirs {
  public: string
  private: string
}

/** Read and validate one root. Errors name the variable so the operator
 *  knows exactly what to fix. */
function requiredRoot(name: 'UPLOAD_DIR' | 'PRIVATE_UPLOAD_DIR'): string {
  const raw = process.env[name]?.trim()
  if (!raw) {
    throw new Error(
      `[media-storage] ${name} is not configured. Set it (server runtime env) to an absolute path — public media and private verification attachments each need an explicit root; there is no default.`,
    )
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `[media-storage] ${name} must be an absolute path (got "${raw}"). Relative roots would silently depend on the process working directory.`,
    )
  }
  return path.resolve(raw)
}

/** True when candidate equals root or lies inside it (path-prefix check on
 *  normalized absolute strings — no filesystem access). */
function isInsideOrEqual(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/**
 * Resolve the storage roots from the current server runtime environment.
 * Cheap and side-effect free; call sites may call it per operation.
 *
 * Throws (single, explicit error per misconfiguration) when either root is
 * missing/relative, or when the public and private roots overlap — a nested
 * pair would let the static /uploads/ mapping reach identity documents (or
 * the private root swallow public files).
 */
export function resolveUploadDirs(): UploadDirs {
  const publicDir = requiredRoot('UPLOAD_DIR')
  const privateDir = requiredRoot('PRIVATE_UPLOAD_DIR')
  if (isInsideOrEqual(publicDir, privateDir) || isInsideOrEqual(privateDir, publicDir)) {
    throw new Error(
      `[media-storage] UPLOAD_DIR ("${publicDir}") and PRIVATE_UPLOAD_DIR ("${privateDir}") must be disjoint directory trees — nesting them would let one storage boundary serve the other's files.`,
    )
  }
  return { public: publicDir, private: privateDir }
}
