/**
 * Feed UI English dictionary entry point.
 *
 * Currently exports the English baseline as `t`.
 * Future locale support: add a locale resolver here that picks
 * the right dictionary based on user/session settings.
 *
 * Usage in client components:
 *   import { t } from '@/lib/i18n'
 *   <button>{t.common.save}</button>
 *
 * Usage in server components / API routes:
 *   import { t } from '@/lib/i18n'
 *   NextResponse.json({ error: t.errors.unauthorized }, { status: 401 })
 *
 * Dynamic strings use function calls:
 *   t.profile.tabs.posts         → "Posts"
 *   t.common.postsCount(5)       → "5 posts"
 *   t.common.postsCount(1)       → "1 post"
 *   t.seo.casTitle('64-17-5', 'Ethanol') → "CAS 64-17-5 — Ethanol"
 */

import { en } from './en'

export const t = en
export type { Dictionary } from './en'
