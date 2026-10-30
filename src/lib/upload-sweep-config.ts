/**
 * Sweep constants, split from upload-sweep.ts so the ops script can import
 * the policy values without pulling Prisma in.
 */

import path from 'node:path'

/** Grace window protecting in-flight compose sessions. */
export const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000

/** Storage roots for both attachment boundaries (absolute, cwd-anchored —
 *  same convention as image.ts / upload-cleanup.ts). */
export const UPLOAD_DIRS = {
  public: path.join(process.cwd(), 'public', 'uploads'),
  private: path.join(process.cwd(), 'private-uploads'),
} as const
