-- Closure closeout migration (post-1.2.0):
-- 1. Notification.revision — version for read-confirmation races. Bumped on
--    every re-surface; page read-confirmation is guarded by the revision it
--    observed, so a stale confirmation cannot clear a re-activated row.
ALTER TABLE "Notification" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
-- Current reply context is separate from the immutable original event stamp.
ALTER TABLE "Notification" ADD COLUMN "replyPostId" TEXT;

-- 2. Merge existing duplicate null-postId notifications before building the
--    partial unique index. PostgreSQL treats NULL as distinct in the plain
--    compound unique, so FOLLOW/MESSAGE rows could accumulate duplicates
--    under concurrency. Merge rule (declared in the closure report):
--      survivor = newest row per (userId, fromId, type) by (createdAt, id)
--      — it carries the most recent surfacing state (its own read flag and
--      timestamp). Delivery records of the discarded rows are repointed to
--      the survivor first (the delivery record is the event authority and
--      must survive), then duplicates are deleted.
WITH ranked AS (
  SELECT id, "userId", "fromId", type,
         ROW_NUMBER() OVER (
           PARTITION BY "userId", "fromId", type
           ORDER BY "createdAt" DESC, id DESC
         ) AS rn
  FROM "Notification"
  WHERE "postId" IS NULL
)
UPDATE "NotificationDelivery" d
SET "notificationId" = w.id
FROM ranked l
JOIN ranked w
  ON w."userId" = l."userId" AND w."fromId" = l."fromId" AND w.type = l.type AND w.rn = 1
WHERE l.rn > 1 AND d."notificationId" = l.id;

DELETE FROM "Notification"
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY "userId", "fromId", type
             ORDER BY "createdAt" DESC, id DESC
           ) AS rn
    FROM "Notification"
    WHERE "postId" IS NULL
  ) t
  WHERE t.rn > 1
);

-- 3. Atomic dedup arbiter for null-postId notifications. deliverNotification
--    upserts through this partial index for postId IS NULL rows.
CREATE UNIQUE INDEX "Notification_null_post_dedup_key"
  ON "Notification"("userId", "fromId", "type")
  WHERE "postId" IS NULL;

-- 4. create_post idempotency keys (Agent recovery) — one logical create per
--    (caller, clientRequestId) pair, 24 h retention.
CREATE TABLE "PostRequestKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostRequestKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PostRequestKey_userId_requestId_key" ON "PostRequestKey"("userId", "requestId");
CREATE INDEX "PostRequestKey_createdAt_idx" ON "PostRequestKey"("createdAt");

ALTER TABLE "PostRequestKey" ADD CONSTRAINT "PostRequestKey_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Ownership of not-yet-submitted private verification attachments —
--    lets the applicant preview their own upload before submitting, while
--    everyone else (including other members) still gets 404. Deliberately
--    not a cleanup reference: never-submitted attachments are orphans and
--    the upload sweep removes file + stale row after the grace window.
CREATE TABLE "PrivateMedia" (
    "filename" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivateMedia_pkey" PRIMARY KEY ("filename")
);

CREATE INDEX "PrivateMedia_createdAt_idx" ON "PrivateMedia"("createdAt");

ALTER TABLE "PrivateMedia" ADD CONSTRAINT "PrivateMedia_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
