/**
 * One-time backfill: set conversationId for all existing replies.
 *
 * Rules:
 *   Root post (parentId IS NULL)     → conversationId = null (unchanged)
 *   Reply whose parent is a root     → conversationId = parentId
 *   Reply whose parent is a reply    → conversationId = parent.conversationId
 *
 * Uses a recursive CTE to resolve all chains in a single query, then
 * batch-updates. Safe to re-run (idempotent — only touches NULL rows).
 */
import { prisma } from '../src/lib/db'

async function main() {
  // Recursive CTE: walk parentId chains from root, assigning depth + conversationId
  const rows = await prisma.$queryRawUnsafe<{ id: string; conv: string }[]>(`
    WITH RECURSIVE chain AS (
      -- Base: root posts are their own conversation root
      SELECT id, "parentId", id AS conv
      FROM "Post"
      WHERE "parentId" IS NULL

      UNION ALL

      -- Recursive: replies inherit parent's conv
      SELECT p.id, p."parentId", c.conv
      FROM "Post" p
      JOIN chain c ON p."parentId" = c.id
    )
    SELECT id, conv FROM chain WHERE "parentId" IS NOT NULL
  `)

  console.log(`Found ${rows.length} replies to backfill`)

  if (rows.length === 0) {
    console.log('Nothing to do.')
    return
  }

  let updated = 0
  // Batch update in chunks of 100
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    await Promise.all(
      chunk.map((row) =>
        prisma.post.updateMany({
          where: { id: row.id, conversationId: null },
          data: { conversationId: row.conv },
        }),
      ),
    )
    updated += chunk.length
    console.log(`  Updated ${updated}/${rows.length}`)
  }

  // Verify
  const remaining = await prisma.post.count({
    where: { parentId: { not: null }, conversationId: null },
  })
  console.log(`\nDone. Replies with null conversationId remaining: ${remaining}`)

  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
