-- Step 1: Add repostPostId to Repost with unique constraint and foreign key
ALTER TABLE "Repost" ADD COLUMN "repostPostId" TEXT;

-- 1a: Multi-match handling: If multiple pure repost posts match the same Repost (userId, postId),
-- pick the earliest created one deterministically.
WITH ranked_posts AS (
  SELECT p.id AS post_id, r.id AS repost_id,
         ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY p."createdAt" ASC, p.id ASC) as rn
  FROM "Repost" r
  JOIN "Post" p ON p."authorId" = r."userId"
               AND p."quotePostId" = r."postId"
               AND p."content" = ''
)
UPDATE "Repost" r
SET "repostPostId" = rp.post_id
FROM ranked_posts rp
WHERE r.id = rp.repost_id AND rp.rn = 1;

-- 1b: Unmatched handling: For any valid Repost that has NO matching pure repost post,
-- synthesize one so every valid Repost is guaranteed to have exactly one generated Post.
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

-- 1c: Add UNIQUE index, enforce NOT NULL constraint, and set FOREIGN KEY constraint
CREATE UNIQUE INDEX "Repost_repostPostId_key" ON "Repost"("repostPostId");
ALTER TABLE "Repost" ALTER COLUMN "repostPostId" SET NOT NULL;
ALTER TABLE "Repost" ADD CONSTRAINT "Repost_repostPostId_fkey" FOREIGN KEY ("repostPostId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 2: Add analyticsId and githubUrl to SiteConfig, with backfill for row 1
ALTER TABLE "SiteConfig" ADD COLUMN "analyticsId" TEXT;
ALTER TABLE "SiteConfig" ADD COLUMN "githubUrl" TEXT;

UPDATE "SiteConfig"
SET "analyticsId" = '1vMIE9ufxjzLp8iD',
    "githubUrl" = 'https://github.com/samelabs/cas.cool'
WHERE "id" = 1;

-- Step 3: Remove unused MENTION from NotificationType safely
-- First, delete or migrate any legacy Notification rows with type = 'MENTION' to prevent casting failure
DELETE FROM "Notification" WHERE "type"::text = 'MENTION';

ALTER TABLE "Notification" ALTER COLUMN "type" TYPE text;
DROP TYPE "NotificationType";
CREATE TYPE "NotificationType" AS ENUM ('LIKE', 'COMMENT', 'FOLLOW', 'REPOST', 'MESSAGE', 'REPORT_RESOLVED');
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType" USING "type"::"NotificationType";
