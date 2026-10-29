-- Repair delta for databases that executed the OLD version of migration
-- 20261028170000_governance_rc_schema_fixes (committed at 463f197, checksum
-- 4bdac90754949710906733d0de630d12ba02dc5e99b27c9bbfbc58f4cf178853).
--
-- Old-version schema state: nullable "Repost"."repostPostId", FK
-- ON DELETE SET NULL, backfill filtered by deletedAt (leaving unmatched
-- reposts NULL) with non-deterministic multi-match picks, no synthesis.
--
-- Known affected database: local dev `cascool` (repaired 2026-10-28, then
-- checksum re-baselined to the rewritten file). Production never reached
-- this migration (origin/main is at v1.1.7); verify at deploy time with:
--   SELECT migration_name, checksum FROM _prisma_migrations
--   WHERE migration_name = '20261028170000_governance_rc_schema_fixes';
--
-- A database that recorded the old version as applied CANNOT contain
-- MENTION notifications (the old version fails and rolls back on such
-- data — proven by rehearsal F1), so no MENTION handling is needed here.
--
-- Usage (idempotent-safe, single transaction), then re-baseline checksum:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f deploy/repair-20261028170000-old-version.sql
--   NEW_SHA=$(shasum -a 256 prisma/migrations/20261028170000_governance_rc_schema_fixes/migration.sql | cut -d' ' -f1)
--   psql "$DATABASE_URL" -c "UPDATE _prisma_migrations SET checksum='$NEW_SHA' WHERE migration_name='20261028170000_governance_rc_schema_fixes'"
--   npx prisma migrate deploy && npx prisma migrate status  # must end "up to date"
--
-- Rehearsed on dirty-data copies (unmatched / multi-match / tombstoned-only
-- reposts, orphan generated posts): end state byte-identical to a fresh
-- apply of the rewritten migration. See docs/RC-2026-10-28-CLOSEOUT.md.

BEGIN;

-- Deterministic re-link (identical to the rewritten migration's step 1a):
-- every Repost links the EARLIEST matching pure-repost post by
-- (createdAt, id). Overwrites the old version's arbitrary multi-match pick
-- and links reposts whose only match is a tombstoned post (preserving the
-- tombstone tree instead of leaving them NULL).
WITH ranked_posts AS (
  SELECT p.id AS post_id, r.id AS repost_id,
         ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY p."createdAt" ASC, p.id ASC) AS rn
  FROM "Repost" r
  JOIN "Post" p ON p."authorId" = r."userId"
               AND p."quotePostId" = r."postId"
               AND p."content" = ''
)
UPDATE "Repost" r
SET "repostPostId" = rp.post_id
FROM ranked_posts rp
WHERE r.id = rp.repost_id AND rp.rn = 1;

-- Synthesize a generated post for every still-unmatched Repost
-- (identical to step 1b of the rewritten migration).
INSERT INTO "Post" ("id", "shortCode", "authorId", "content", "quotePostId", "images", "views", "likeCount", "replyCount", "repostCount", "bookmarkCount", "createdAt", "updatedAt")
SELECT
  'repost_' || r."id",
  substr(md5(random()::text || clock_timestamp()::text || r."id"), 1, 8),
  r."userId",
  '',
  r."postId",
  '{}'::text[],
  0, 0, 0, 0, 0,
  r."createdAt",
  r."createdAt"
FROM "Repost" r
WHERE r."repostPostId" IS NULL;

UPDATE "Repost" r
SET "repostPostId" = 'repost_' || r."id"
WHERE r."repostPostId" IS NULL;

-- Upgrade the constraint to the rewritten version's contract:
-- NOT NULL + ON DELETE CASCADE (replaces nullable + ON DELETE SET NULL).
ALTER TABLE "Repost" DROP CONSTRAINT "Repost_repostPostId_fkey";
ALTER TABLE "Repost" ALTER COLUMN "repostPostId" SET NOT NULL;
ALTER TABLE "Repost" ADD CONSTRAINT "Repost_repostPostId_fkey"
  FOREIGN KEY ("repostPostId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
