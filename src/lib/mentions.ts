/**
 * @-mention parsing — the single shared source for both sides of the pipeline:
 *
 *  - WRITE path (`post-core-write.service.ts`): extracts candidate usernames
 *    from post content and keeps only those that exist in the User table
 *    (stored on Post.mentionUsernames, lowercase).
 *  - RENDER path (`PostCard.renderContent`): only @tokens whose username is
 *    present in Post.mentionUsernames become /u/<name> links; every other
 *    @token renders as plain text.
 *
 * Spec (DEVELOPMENT.md § Mentions): the render layer NEVER decides mention
 * validity on its own — a regex match alone is not a user. Unconfirmed @
 * tokens must not link, because /u/<unknown> is a guaranteed 404.
 *
 * Usernames in the DB are all-lowercase [a-z0-9_] (3–20 chars, enforced by
 * sanitizeUsername at registration), so the canonical comparison form is
 * lowercase. The regex stays case-tolerant to capture what the author typed
 * (e.g. "@Alice"); resolution lowercases before the IN lookup.
 */

// Mention: @username (1-20 chars). Must be at start of text or preceded by
// whitespace/punctuation — excludes email addresses (user@domain.com).
// Capture group 1 = username without the leading "@".
export const MENTION_RE = /(?:^|(?<=[\s/(\[{:;,]))@([A-Za-z0-9_]{1,20})/g

/**
 * Extract unique, lowercase candidate usernames from post content.
 * Pure function; order follows first appearance. Callers do the existence
 * check against the User table (never trust the candidate list itself).
 */
export function extractMentionCandidates(text: string): string[] {
  const seen = new Set<string>()
  MENTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_RE.exec(text)) !== null) {
    seen.add(m[1].toLowerCase())
  }
  return [...seen]
}
