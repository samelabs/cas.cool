import { prisma } from '@/lib/db'
import { postUrl } from '@/lib/shortCode'

/**
 * Fetch a random recent post and return its /p/{code} path.
 * Used by not-found.tsx for the 404 → random post redirect.
 *
 * Picks from the latest 100 root posts — ORDER BY RANDOM() on 100 rows
 * is instant, no full-table scan.
 *
 * Server-only — imports prisma.
 */
export async function randomPostPath(): Promise<string> {
  const rows = await prisma.$queryRaw<{ shortCode: string }[]>`
    SELECT "shortCode" FROM (
      SELECT "shortCode" FROM "Post"
      WHERE "parentId" IS NULL AND "deletedAt" IS NULL AND "shortCode" IS NOT NULL
      ORDER BY "createdAt" DESC
      LIMIT 100
    ) recent
    ORDER BY RANDOM()
    LIMIT 1
  `
  return rows[0]?.shortCode
    ? postUrl({ shortCode: rows[0].shortCode, id: '' })
    : '/'
}
