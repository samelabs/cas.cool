-- CJK bigram search support for Post.content.
--
-- Why: pg_trgm cannot serve ILIKE '%q%' for interior substrings shorter than
-- 3 characters — a 2-char Chinese query (乙醇/催化/苯酚) extracts zero
-- trigrams and degenerates to a full scan over the 780K-row legacy corpus.
-- Chinese chemistry vocabulary is dominated by 2-char words, so this is the
-- core case, not an edge case.
--
-- Mechanism (verified on production data 2026-11-09): an IMMUTABLE function
-- splits every contiguous CJK run into adjacent character pairs (苯乙烯 →
-- "苯乙 乙烯"), stored as a 'simple' tsvector in Post.content_bigrams and
-- indexed with GIN. CJK-containing search queries are tokenized the same way
-- and use `content_bigrams @@ to_tsquery(...)` as a candidate PREFILTER; the
-- existing content ILIKE remains the final arbiter in the same statement, so
-- result semantics are byte-identical to today (bigram false positives are
-- rechecked away; measured: 苯乙烯 1240 candidates → ILIKE keeps exactly the
-- 1206 true matches).
--
-- Out-of-band objects (like the trgm indexes in 20260710030000): schema.prisma
-- cannot express tsvector columns / GIN / triggers, so prisma migrate diff
-- proposes dropping them — they are deliberate.

-- 1) Bigram extraction: every contiguous run of U+4E00..U+9FFF chars becomes
--    its adjacent 2-char pairs, space-joined. Non-CJK content yields ''.
--    IMMUTABLE + PARALLEL SAFE + STRICT (NULL content → NULL, callers coerce).
CREATE FUNCTION cas_content_bigrams(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT COALESCE(string_agg(substring(rm[1] from g for 2), ' '), '')
  FROM regexp_matches(t, '[一-鿿]+', 'g') AS rm,
       generate_series(1, char_length(rm[1]) - 1) AS g
$$;

-- 2) Derived column, backfilled out-of-band (batched online), then indexed.
ALTER TABLE "Post" ADD COLUMN content_bigrams tsvector;

-- 3) Write-path maintenance: BEFORE trigger computes the column on every
--    INSERT and on every content UPDATE — never stale.
CREATE FUNCTION cas_post_bigrams_maintain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_bigrams := to_tsvector('simple', cas_content_bigrams(NEW.content));
  RETURN NEW;
END $$;

CREATE TRIGGER post_content_bigrams_tg
BEFORE INSERT OR UPDATE OF content ON "Post"
FOR EACH ROW EXECUTE FUNCTION cas_post_bigrams_maintain();

-- 4) GIN index (CONCURRENTLY — cannot run inside the migration transaction;
--    applied out-of-band together with the batched backfill, then recorded
--    via prisma migrate resolve).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Post_content_bigrams_idx"
  ON "Post" USING gin (content_bigrams);
