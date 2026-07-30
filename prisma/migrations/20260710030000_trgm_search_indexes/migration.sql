-- GIN trigram indexes for ILIKE search performance.
-- pg_trgm extension already installed.

-- Post.content: full-text ILIKE search on 780K+ rows
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Post_content_trgm_idx"
  ON "Post" USING gin (content gin_trgm_ops);

-- User.username + displayName: people search on 630K rows
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_username_trgm_idx"
  ON "User" USING gin (username gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_displayName_trgm_idx"
  ON "User" USING gin ("displayName" gin_trgm_ops);

-- Chemical.name: compound name search on 630K rows
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Chemical_name_trgm_idx"
  ON "Chemical" USING gin (name gin_trgm_ops);

-- Tag.name: tag search
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Tag_name_trgm_idx"
  ON "Tag" USING gin (name gin_trgm_ops);

-- Refresh planner statistics after index creation
ANALYZE "Post";
ANALYZE "User";
ANALYZE "Chemical";
ANALYZE "Tag";
