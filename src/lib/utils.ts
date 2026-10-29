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
 * Serialize a JSON-LD object for safe embedding in a <script> tag.
 *
 * JSON.stringify does NOT escape "<" (nor U+2028/U+2029), so content like
 * "</script><script>alert(1)</script>" inside a post would break out of the
 * script tag — a stored XSS against every visitor of the page. Escaping as
 * \u003c keeps the JSON semantically identical for parsers.
 */
export function jsonLdScript(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
