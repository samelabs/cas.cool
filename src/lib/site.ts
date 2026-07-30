/**
 * Central site configuration — single source of truth for the domain URL.
 * All modules import SITE_URL from here instead of duplicating
 * process.env.NEXT_PUBLIC_SITE_URL || 'fallback' everywhere.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || 'https://cas.cool'
