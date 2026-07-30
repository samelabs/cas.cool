/**
 * Server Action shared types, error class, and result helpers.
 *
 * This file is NOT marked 'use server' — it contains types and a class
 * that Turbopack cannot serialize as Server Action exports. The actual
 * server-side guards (requireUser, requireAdmin) live in the action
 * modules that DO have 'use server'.
 */

// ─── Result Types ─────────────────────────────────────────────

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data }
}

export function err(error: string): ActionResult<never> {
  return { ok: false, error }
}

// ─── Error Class ──────────────────────────────────────────────

export type ActionErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'CONFLICT'
  | 'INTERNAL'

export class ActionError extends Error {
  code: ActionErrorCode
  constructor(code: ActionErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ActionError'
  }
}

/** Check write permission (post, comment, message). Throws on failure. */
export function assertCanWrite(user: { status: string } | null): asserts user is { status: string; id: string } {
  if (!user || user.status !== 'active') {
    throw new ActionError('FORBIDDEN', 'Account restricted.')
  }
}
