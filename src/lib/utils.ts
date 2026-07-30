// CAS Registry Number extraction: e.g. "50-00-0", "64-17-5"
const CAS_REGEX = /\b(\d{2,7})-(\d{2})-(\d)\b/

export function extractCASNumber(text: string): string | null {
  const matches = text.match(CAS_REGEX)
  return matches && matches.length > 0 ? matches[0] : null
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

export function timeAgo(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const seconds = Math.floor((now.getTime() - d.getTime()) / 1000)

  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`

  // Same year: "Jun 5"  ·  Different year: "Jun 5, 2024"
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max - 1) + '…'
}

export function getInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

export function sanitizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20)
}

/**
 * Mention extraction — finds @username patterns in text.
 *
 * Rules:
 *  - @ must be at start of text OR preceded by whitespace/punctuation (not
 *    part of an email address or URL).
 *  - Username: [a-zA-Z0-9_], 1-20 chars (matches our username constraint).
 *  - Excludes emails: "user@domain.com" is NOT a mention because the @ is
 *    preceded by non-whitespace.
 *  - Excludes URLs: "https://x.com/@user" IS a mention (after the /), but
 *    "user@example.com" is NOT.
 *  - Capped at MAX_MENTIONS to prevent spam abuse.
 */
export const MAX_MENTIONS = 5

const MENTION_REGEX = /(?:^|[\s/(\[{:;,])(@)([a-zA-Z0-9_]{1,20})/g

export function extractMentions(text: string): string[] {
  const usernames = new Set<string>()
  let match: RegExpExecArray | null
  let count = 0
  MENTION_REGEX.lastIndex = 0
  while ((match = MENTION_REGEX.exec(text)) !== null && count < MAX_MENTIONS) {
    usernames.add(match[2].toLowerCase())
    count++
  }
  return [...usernames]
}

/**
 * Display regex for rendering @mentions as links in post content.
 * Same boundary rules as extractMentions, but captures the full @username
 * string (including the @ symbol) for link text.
 */
export const MENTION_DISPLAY_RE = /(?:^|[\s/(\[{:;,])(@[a-zA-Z0-9_]{1,20})/g
