import type { Prisma } from '@prisma/client'

/** Product-specific predicate supplied to the generic feed as an opaque
 *  `postWhere`: posts tagged with this CAS number. The feed applies it in
 *  SQL before keyset pagination, so CAS pages keep exact cursor semantics. */
export function chemicalPostWhere(casNumber: string): Prisma.PostWhereInput {
  return { chemicals: { some: { casNumber } } }
}
