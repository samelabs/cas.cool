/**
 * Sweep constants, split from upload-sweep.ts so the ops script can import
 * the policy values without pulling Prisma in.
 */

/** Grace window protecting in-flight compose sessions. */
export const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000

// Storage roots for both attachment boundaries live in media-storage.ts
// (server runtime env: UPLOAD_DIR / PRIVATE_UPLOAD_DIR) — the same single
// source every media consumer reads.
