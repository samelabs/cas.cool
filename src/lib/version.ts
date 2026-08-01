/**
 * Version configuration — single source of truth.
 *
 * Naming convention:
 *   {major}.{minor}.{patch}
 *
 * - major.minor: mirrors the open-source release tag (e.g. 1.0 = GitHub v1.0.0)
 * - patch:      deployment counter, starts at 1 for the first change after
 *               a minor bump. Every deploy that changes user-visible
 *               behaviour increments this number.
 *
 * Example: 1.1.32 = "32nd deploy after the 1.1 line" (i.e. 1.0 → 1.1 was the
 * first update, then 32 hotfix/iteration deploys landed on top).
 *
 * Keep a separate CHANGELOG.md file in the repo root for detailed history.
 */

export const VERSION = '1.1.4'

/** GitHub repository (canonical open-source release). */
export const GITHUB_URL = 'https://github.com/samelabs/cas.cool'

/** Short label shown in the UI. */
export const APP_NAME = 'CAS.cool'
