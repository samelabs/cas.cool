/**
 * CJK bigram tokenization for search — MUST mirror the DB-side extraction in
 * cas_content_bigrams() (prisma/migrations/20261109233000_post_content_bigrams):
 * every contiguous run of U+4E00..U+9FFF characters becomes its adjacent
 * 2-char pairs (苯乙烯 → 苯乙, 乙烯). The DB stores these per post in
 * Post.content_bigrams ('simple' tsvector, GIN-indexed); the search query
 * uses the same tokens as a candidate prefilter, with content ILIKE as the
 * exact final arbiter.
 */

export const CJK_RUN_RE = /[一-鿿]+/g

/**
 * Adjacent 2-char pairs over every CJK run in the query. Returns null when
 * no run is >= 2 chars — no prefilter is possible, the caller falls back to
 * the plain ILIKE path.
 */
export function cjkBigramTokens(q: string): string[] | null {
  const tokens: string[] = []
  for (const run of q.matchAll(CJK_RUN_RE)) {
    for (let i = 0; i + 1 < run[0].length; i++) tokens.push(run[0].slice(i, i + 2))
  }
  return tokens.length > 0 ? tokens : null
}
