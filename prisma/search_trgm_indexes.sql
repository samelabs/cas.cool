-- Search performance: pg_trgm GIN indexes for ILIKE acceleration
-- Created: 2026-06-21
-- Purpose: Prisma `contains: { mode: 'insensitive' }` generates ILIKE which
--          full-scans on 781K posts. pg_trgm GIN indexes turn ILIKE into
--          O(log n) bitmap scans for queries ≥ 3 chars.
--
-- Run: psql -d cascool -f prisma/search_trgm_indexes.sql
-- Safe to re-run (IF NOT EXISTS / CONCURRENTLY).

-- Extension (instant, no table lock)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Indexes that HELP both English and CJK (≥3 chars):
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_content_trgm
  ON "Post" USING GIN (content gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chem_name_trgm
  ON "Chemical" USING GIN (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tag_name_trgm
  ON "Tag" USING GIN (name gin_trgm_ops);

-- Indexes that help English but produce false positives for 2-char CJK.
-- Kept because: (a) English queries benefit greatly (0ms vs Seq Scan),
-- (b) code-level guards (q.length >= 3 for User, isCasLike for CAS) skip
-- these for pathological cases.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_username_trgm
  ON "User" USING GIN (username gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_display_trgm
  ON "User" USING GIN ("displayName" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chem_cas_trgm
  ON "Chemical" USING GIN ("casNumber" gin_trgm_ops);
