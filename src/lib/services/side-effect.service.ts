/**
 * Side-effect outbox — durable post-commit compensation.
 *
 * Route transactions enqueue tasks here in the SAME transaction as the
 * state change (e.g. report resolution); `drainSideEffects` executes them
 * after commit, best-effort. A failed execution keeps the row `pending`
 * with `attempts`/`lastError`, so the failure is trackable in the database
 * and retryable — by the next drain or explicitly via
 * POST /api/admin/side-effects/retry. The committed business result is
 * never turned into a retryable 500 by a side-effect failure.
 *
 * Execution is at-least-once with atomic claiming: a drain CLAIMS pending
 * rows (SKIP LOCKED, 60 s lease), then renews ownership before each
 * execution. A queued task reclaimed by another drain is skipped. A task
 * orphaned by a process death becomes claimable once its lease expires;
 * an execution that itself outlives the lease can overlap a retry, so
 * executors must remain idempotent (notifications use NotificationDelivery
 * event records; upload cleanup treats a missing file as success).
 */

import { randomUUID } from 'node:crypto'
import { NotificationType, Prisma, type SideEffectKind } from '@prisma/client'
import { prisma } from '@/lib/db'
import { deliverNotification } from '@/lib/notification'
import { removeUnreferencedUpload } from '@/lib/upload-cleanup'

/** A claim older than this is considered abandoned (process death) and can
 *  be re-claimed. Executions are fast (DB writes + unlink); 60 s is ample. */
export const SIDE_EFFECT_CLAIM_LEASE_MS = 60_000

export interface NotificationPayload {
  userId: string
  fromId: string
  type: NotificationType
  postId?: string | null
  /** Persistent event idempotency key — deduplicates retries and duplicate
   *  tasks into exactly one notification row. */
  eventKey?: string | null
}

export interface UploadCleanupPayload {
  url: string
}

export type SideEffectInput =
  | { kind: 'notification'; payload: NotificationPayload }
  | { kind: 'upload_cleanup'; payload: UploadCleanupPayload }

/** Enqueue tasks inside the caller's transaction; returns the created ids. */
export async function enqueueSideEffects(
  tx: Prisma.TransactionClient,
  tasks: SideEffectInput[],
): Promise<string[]> {
  if (tasks.length === 0) return []
  const created = await Promise.all(
    tasks.map((task) =>
      tx.sideEffectTask.create({
        data: { kind: task.kind, payload: task.payload as unknown as Prisma.InputJsonValue },
        select: { id: true },
      }),
    ),
  )
  return created.map((row) => row.id)
}

export type SideEffectExecutorMap = Record<SideEffectKind, (payload: never) => Promise<void>>

/** Default executors — call the THROWING primitives so failures surface. */
export const sideEffectExecutors: SideEffectExecutorMap = {
  notification: (payload) => {
    const p = payload as NotificationPayload
    return deliverNotification({
      userId: p.userId,
      fromId: p.fromId,
      type: p.type,
      postId: p.postId ?? null,
      eventKey: p.eventKey ?? null,
    })
  },
  upload_cleanup: (payload) => {
    const p = payload as UploadCleanupPayload
    return removeUnreferencedUpload(p.url)
  },
}

export interface DrainResult {
  attempted: number
  succeeded: number
  failed: number
  /** Total pending tasks left in the outbox after this drain. */
  pending: number
  failedTasks: { id: string; kind: string; lastError: string }[]
}

export interface SideEffectClaimSql {
  text: string
  values: unknown[]
}

/**
 * The claim statement: a bounded `SELECT … FOR UPDATE SKIP LOCKED` CTE
 * feeds an `UPDATE … RETURNING`. Candidate selection and claiming are one
 * mutually-exclusive database operation — a second transaction holding no
 * locks skips the first one's locked rows at the candidate scan itself, so
 * an unexpired claim cannot be acquired by two drains (the previous
 * id-subselect form re-checked nothing on the locked row version and
 * could double-claim under contention). LIMIT bounds the claim; the lease
 * predicate appears in BOTH the candidate scan and the outer WHERE so it
 * is re-verified on the locked row version. Fully parameterized ($n) — no
 * interpolated values.
 */
export function buildSideEffectClaimSql(
  claimToken: string,
  opts: { limit: number; leaseSeconds: number; ids?: string[] },
): SideEffectClaimSql {
  const values: unknown[] = []
  const bind = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }
  const lease = `now() - make_interval(secs => ${bind(opts.leaseSeconds)})`
  const leaseOuter = `now() - make_interval(secs => ${bind(opts.leaseSeconds)})`
  // Omitted ids means all pending rows; an explicit [] means none.
  const idFilter = opts.ids !== undefined ? `AND id = ANY(${bind(opts.ids)})` : ''
  const text = `
    WITH candidates AS (
      SELECT id FROM "SideEffectTask"
      WHERE status = 'pending'
        AND ("claimedAt" IS NULL OR "claimedAt" < ${lease})
        ${idFilter}
      ORDER BY "createdAt" ASC
      LIMIT ${bind(opts.limit)}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "SideEffectTask" AS t
    SET "claimToken" = ${bind(claimToken)}, "claimedAt" = now()
    FROM candidates c
    WHERE t.id = c.id
      AND (t."claimedAt" IS NULL OR t."claimedAt" < ${leaseOuter})
    RETURNING t.id`
  return { text, values }
}

/**
 * Atomically claim AT MOST `limit` pending, lease-expired rows for this
 * drain and execute them (see `buildSideEffectClaimSql` for the mutual
 * exclusion and limit contract). Completion and failure write-backs are
 * guarded by the claimToken — an executor whose lease expired and was
 * re-claimed elsewhere can no longer overwrite the new claimant's state.
 * Failure releases the claim immediately (retryable now); success marks
 * `succeeded`. Never throws for a task-level failure. `executors` exists
 * for fault injection.
 */
export async function drainSideEffects(opts: {
  ids?: string[]
  limit?: number
  executors?: SideEffectExecutorMap
} = {}): Promise<DrainResult> {
  const claimToken = randomUUID()
  const limit = opts.limit ?? 100
  const leaseSeconds = SIDE_EFFECT_CLAIM_LEASE_MS / 1000

  const claim = buildSideEffectClaimSql(claimToken, { limit, leaseSeconds, ids: opts.ids })
  const claimed = await prisma.$queryRawUnsafe<{ id: string }[]>(claim.text, ...claim.values)

  const tasks =
    claimed.length > 0
      ? await prisma.sideEffectTask.findMany({
          where: { claimToken },
          orderBy: { createdAt: 'asc' },
          select: { id: true, kind: true, payload: true },
        })
      : []

  let attempted = 0
  let succeeded = 0
  const failedTasks: DrainResult['failedTasks'] = []
  for (const task of tasks) {
    // Token-guarded write-back: if the lease expired and another drain
    // re-claimed this row, these updateMany calls match 0 rows and the
    // current owner takes over — a stale executor never overwrites it.
    const owner = { id: task.id, claimToken }
    const release = { claimToken: null, claimedAt: null }
    // A batch can wait longer than the lease behind earlier executions.
    // Renew just before running; a superseded owner must not execute a
    // task from its stale in-memory list, even if execution is idempotent.
    // Use the database clock, matching the claim/expiry SQL even if the
    // application host's clock differs from PostgreSQL's.
    const renewed = await prisma.$executeRaw`
      UPDATE "SideEffectTask" SET "claimedAt" = now()
      WHERE id = ${task.id} AND "claimToken" = ${claimToken} AND status = 'pending'`
    if (renewed === 0) continue
    attempted++
    try {
      const executor = (opts.executors ?? sideEffectExecutors)[task.kind]
      if (!executor) throw new Error(`No executor registered for kind '${task.kind}'`)
      await executor(task.payload as never)
      const completed = await prisma.sideEffectTask.updateMany({
        where: owner,
        data: { status: 'succeeded', ...release },
      })
      succeeded += completed.count
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      const failed = await prisma.sideEffectTask.updateMany({
        where: owner,
        data: { attempts: { increment: 1 }, lastError: message.slice(0, 500), ...release },
      })
      if (failed.count === 0) continue // superseded; the current owner reports its outcome
      failedTasks.push({ id: task.id, kind: task.kind, lastError: message.slice(0, 500) })
      console.error('[SideEffectOutbox] task failed (stays pending for retry):', {
        taskId: task.id,
        kind: task.kind,
        error: message,
      })
    }
  }

  const pending = await prisma.sideEffectTask.count({ where: { status: 'pending' } })
  return { attempted, succeeded, failed: failedTasks.length, pending, failedTasks }
}

/** Per-process throttle for the no-event opportunistic progress below. */
const OPPORTUNISTIC_INTERVAL_MS = 30_000
let lastOpportunisticAt = 0

/**
 * Post-commit drain for the tasks a request just enqueued (normal path:
 * delivered within the same request). If ANY pending backlog remains
 * anywhere in the outbox afterwards — e.g. a task whose targeted drain
 * failed earlier, or one left by a process that died right after its
 * commit — one bounded extra batch is drained here, so the queue keeps
 * moving under ordinary traffic without waiting for an admin.
 *
 * Event-free progress: even when THIS request enqueued nothing (taskIds
 * empty), a throttled (per process, 30 s) bounded check+drain runs, so a
 * committed backlog recovers under ordinary read/no-notification traffic
 * without requiring a new notification event. Never throws: the caller's
 * committed business result must not become a retryable 500 because of a
 * side-effect failure. Failures stay `pending` with attempts/lastError and
 * are re-driven by later drains or the admin retry endpoint.
 */
export async function drainEnqueuedSideEffects(
  taskIds: string[],
  limit = 20,
): Promise<DrainResult | null> {
  if (taskIds.length === 0) {
    // No new event of our own; make bounded, throttled progress on any
    // committed backlog anyway.
    const now = Date.now()
    if (now - lastOpportunisticAt < OPPORTUNISTIC_INTERVAL_MS) return null
    lastOpportunisticAt = now
    try {
      const pending = await prisma.sideEffectTask.count({ where: { status: 'pending' } })
      if (pending === 0) return null
      return await drainSideEffects({ limit })
    } catch (e: unknown) {
      console.error('[SideEffectOutbox] opportunistic drain crashed (tasks stay pending):', { error: e })
      return null
    }
  }
  try {
    const result = await drainSideEffects({ ids: taskIds })
    if (result.pending > 0) {
      await drainSideEffects({ limit })
    }
    if (result.failed > 0) {
      console.error('[SideEffectOutbox] post-commit drain left failures (pending retry):', {
        taskIds,
        failedTasks: result.failedTasks,
      })
    }
    return result
  } catch (e: unknown) {
    console.error('[SideEffectOutbox] post-commit drain crashed (tasks stay pending):', {
      taskIds,
      error: e,
    })
    return null
  }
}
