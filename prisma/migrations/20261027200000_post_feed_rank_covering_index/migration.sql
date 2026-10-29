-- For-You (recommended) feed: covering index for the 30-day ranking window.
--
-- Measured on a seed database at production scale (792k live posts, 100k in
-- the 30-day window — docs/FEED-PERF.md): the ranking query scanned the
-- window through Post_createdAt_idx plus ~10,000 heap blocks per request
-- (30,459 buffer reads cold), ~300ms p50 over HTTP. With this partial
-- covering index the same plan becomes an index-only scan (677 buffers,
-- 50ms cold SQL, 70ms p50 HTTP).
--
-- Partial predicate = the ranking filter (root + not soft-deleted); INCLUDE
-- carries exactly the ranking inputs (counts, authorId) so the heap is never
-- touched. Write cost: one extra index entry per post create; like/repost/
-- reply/bookmark counters update the entry in place (39 MB at 792k posts).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Post_feedRank_cover_idx"
  ON "Post" ("createdAt" DESC)
  INCLUDE ("likeCount", "repostCount", "replyCount", "bookmarkCount", "authorId", "id")
  WHERE "parentId" IS NULL AND "deletedAt" IS NULL;
