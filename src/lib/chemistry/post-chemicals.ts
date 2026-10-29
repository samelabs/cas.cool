/**
 * Chemical product layer — CAS-number rules for post writes.
 *
 * The generic post lifecycle (row, reply/post counts) lives in the core
 * write steps (`src/lib/services/post-core-write.service.ts`); the
 * application use cases (`post-write.service.ts`) compose both in ONE
 * transaction per operation. Everything specific to chemical tagging
 * lives here: CAS format validation, content auto-extraction, Chemical
 * row upserts and the denormalized `Chemical.postCount` maintenance —
 * there is no second counting implementation anywhere else.
 *
 * All write helpers run inside the caller's transaction.
 */

import { Prisma } from '@prisma/client'
import { extractCASNumber } from '@/lib/utils'

/** CAS Registry Number: 2–7 digits, dash, 2 digits, 1 check digit. */
export const CAS_FORMAT = /^\d{2,7}-\d{2}-\d$/

type PostTx = Prisma.TransactionClient

/** Canonical CAS processing order: deduplicated, lexicographically sorted.
 *  Used for Chemical ROW locking/upsert sequencing (rows are identified by
 *  casNumber, so this IS their resource order) and for deterministic
 *  diffing. It is deliberately NOT used for advisory-lock ordering — see
 *  `lockChemicalAdvisory`, which orders by the actual hashed resource. */
function canonicalCas(casNumbers: string[]): string[] {
  return [...new Set(casNumbers)].sort()
}

/**
 * Serialize writers that may CREATE the same missing Chemical rows.
 *
 * Row locks only order rows that already exist. Two transactions creating
 * the SAME still-missing CAS race on the unique index instead, and Prisma's
 * upsert is not an atomic INSERT … ON CONFLICT here: the loser of that race
 * fails with P2002 (unique violation) once the winner commits. A per-CAS
 * transaction-scoped advisory lock, taken BEFORE any row lock or insert,
 * makes the second creator wait; by the time it proceeds, the row exists
 * and its upsert takes the plain update path.
 *
 * Ordering is established on the ACTUAL lock resources, not on the CAS
 * strings: the resource is `hashtext('cascool:chemical:' || cas)` (32-bit,
 * signed), so distinct CAS can share a resource, and sorting the CAS list
 * does NOT sort the resources — a hash collision let two transactions
 * acquire the same resource pair in opposite orders (40P01, reproduced in
 * the 1.2.0 review). Therefore:
 *   1. compute the resource key for every CAS and deduplicate by key
 *      (colliding CAS are one resource, locked once);
 *   2. sort the keys NUMERICALLY (ascending signed 64-bit) — one global
 *      order over the actual resources;
 *   3. acquire each key in its own statement from application code, so the
 *      execution order is the loop order — never an unordered set output,
 *      planner-dependent evaluation, or the input CAS order.
 * Every Chemical-layer writer takes these locks before any row lock, so
 * this order cannot cycle against itself or the row locks below it.
 * Advisory locks are released automatically at transaction end.
 */
async function lockChemicalAdvisory(tx: PostTx, casNumbers: string[]): Promise<void> {
  const ordered = canonicalCas(casNumbers)
  if (ordered.length === 0) return

  // Compute + dedupe the real resource keys. Result order is unspecified —
  // the numeric sort below is what defines the acquisition order.
  const keyRows = await tx.$queryRaw<{ key: string }[]>`
    SELECT DISTINCT hashtext('cascool:chemical:' || c)::text AS key
    FROM unnest(ARRAY[${Prisma.join(ordered)}]::text[]) AS c`

  const resources = [...keyRows]
    .map((r) => BigInt(r.key))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  for (const key of resources) {
    // One lock per statement: application control flow IS the acquisition
    // order. String parameter with an explicit int8 cast keeps the value
    // exact on the driver round-trip.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key.toString()}::int8)`
  }
}

/**
 * Lock every Chemical row that ALREADY EXISTS from `casNumbers`, in
 * canonical order, before any insert/relation/counter write.
 *
 * Together with `lockChemicalAdvisory`, every transaction holds its full
 * admission set before it inserts anything:
 *  - creation races for the same missing row queue on the advisory lock
 *    (the later transaction then finds the row and updates it — no P2002),
 *  - writers on overlapping EXISTING rows acquire them in one canonical
 *    order, so opposed input orders ([A,B] vs [B,A]) cannot deadlock.
 *
 * Lock strength: FOR NO KEY UPDATE — what the postCount UPDATEs take. It
 * serializes concurrent counter writes without blocking the FOR KEY SHARE
 * locks that `_ChemicalToPost` inserts take on these rows via their FK.
 * `UPDATE ... WHERE casNumber IN (...)` lock order is NOT guaranteed to
 * follow the input list — that is why the order is established here,
 * explicitly, once.
 */
async function lockExistingChemicalRows(tx: PostTx, casNumbers: string[]): Promise<void> {
  const ordered = canonicalCas(casNumbers)
  if (ordered.length === 0) return
  await tx.$queryRaw`
    SELECT "casNumber" FROM "Chemical"
    WHERE "casNumber" IN (${Prisma.join(ordered)})
    ORDER BY "casNumber"
    FOR NO KEY UPDATE`
}

export function isValidCas(value: string): boolean {
  return CAS_FORMAT.test(value.trim())
}

/** Keep well-formed CAS strings from an unknown-typed body value. */
export function filterValidCas(values: unknown[]): string[] {
  return values
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter((c) => CAS_FORMAT.test(c))
}

/** Edit keeps the existing no-trim rule for supplied CAS values. */
export function filterEditCas(values: unknown[]): string[] {
  return values.filter((c): c is string => typeof c === 'string' && CAS_FORMAT.test(c))
}

/**
 * Merge manually supplied CAS numbers (array or comma-separated string)
 * with the ones auto-extracted from post content. Deduplicated, insertion
 * order preserved — the connect order matches the previous inline logic.
 */
export function resolvePostChemicals(input: {
  content: string
  /** Raw body value: string[], "a,b,c", or absent. */
  casNumbers: string[] | string | null
}): string[] {
  const provided =
    Array.isArray(input.casNumbers)
      ? input.casNumbers
      : typeof input.casNumbers === 'string'
        ? input.casNumbers.split(',')
        : []

  const all = new Set<string>()
  for (const cas of filterValidCas(provided)) all.add(cas)
  const extracted = extractCASNumber(input.content)
  if (extracted) all.add(extracted)
  return [...all]
}

/** Upsert Chemical rows and return the Prisma connect shape for Post.
 *  Rows are gated and locked in canonical order (see
 *  `lockChemicalAdvisory` / `lockExistingChemicalRows`) so opposed input
 *  orders cannot deadlock and same-row creation races cannot P2002. */
export async function upsertChemicals(
  tx: PostTx,
  casNumbers: string[],
): Promise<{ casNumber: string }[]> {
  const ordered = canonicalCas(casNumbers)
  await lockChemicalAdvisory(tx, ordered)
  await lockExistingChemicalRows(tx, ordered)
  for (const casNumber of ordered) {
    await tx.chemical.upsert({ where: { casNumber }, create: { casNumber }, update: {} })
  }
  return ordered.map((casNumber) => ({ casNumber }))
}

/** Read a post's current CAS association without exposing it to the post core. */
export async function postCasNumbers(tx: PostTx, postId: string): Promise<string[]> {
  const post = await tx.post.findUnique({
    where: { id: postId },
    select: { chemicals: { select: { casNumber: true } } },
  })
  return post?.chemicals.map((chemical) => chemical.casNumber) ?? []
}

/** Tag a freshly created post (inside the caller's transaction) and move
 *  its Chemical.postCounts — the create half of the product write rules. */
export async function attachInitialPostChemicals(
  tx: PostTx,
  postId: string,
  casNumbers: string[],
): Promise<void> {
  const connect = await upsertChemicals(tx, casNumbers)
  if (connect.length > 0) {
    await tx.post.update({ where: { id: postId }, data: { chemicals: { connect } } })
  }
  await adjustChemicalPostCounts(tx, casNumbers, 1)
}

/** Bump the denormalized Chemical.postCount by ±1 for every CAS number.
 *  Callers must have already established canonical row locks for this set
 *  (`lockExistingChemicalRows` / `upsertChemicals`); this statement only
 *  re-acquires locks the transaction already holds. */
export async function adjustChemicalPostCounts(
  tx: PostTx,
  casNumbers: string[],
  delta: 1 | -1,
): Promise<void> {
  if (casNumbers.length === 0) return
  await tx.chemical.updateMany({
    where: { casNumber: { in: canonicalCas(casNumbers) } },
    data: { postCount: { increment: delta } },
  })
}

/**
 * Replace a post's chemical set (edit path). `next` must already be
 * format-filtered; `current` is the post's existing CAS list. The OLD and
 * NEW sets overlap arbitrarily across concurrent edits of different posts,
 * so the full union is locked in canonical order before any upsert,
 * relation swap or counter move — sorting only the additions (or only one
 * route's input) would leave opposed orders cycle-capable.
 */
export async function replacePostChemicals(
  tx: PostTx,
  params: { postId: string; current: string[]; next: string[] },
): Promise<void> {
  const { postId, current, next } = params
  const newSet = new Set(next)
  const oldSet = new Set(current)
  const toAdd = canonicalCas(next.filter((c) => !oldSet.has(c)))
  const toRemove = canonicalCas(current.filter((c) => !newSet.has(c)))

  await lockChemicalAdvisory(tx, [...toAdd, ...toRemove])
  await lockExistingChemicalRows(tx, [...toAdd, ...toRemove])
  for (const casNumber of toAdd) {
    await tx.chemical.upsert({ where: { casNumber }, create: { casNumber }, update: {} })
  }
  await tx.post.update({
    where: { id: postId },
    data: { chemicals: { set: next.map((c) => ({ casNumber: c })) } },
  })
  await adjustChemicalPostCounts(tx, toAdd, 1)
  await adjustChemicalPostCounts(tx, toRemove, -1)
}
