/**
 * Shared constants for the feed layer.
 *
 * Kept in a separate file (no Prisma / server imports) so it can be
 * imported by client components without bundling server-only modules.
 */

/** Default page size for all post feeds. */
export const FEED_PAGE_SIZE = 20
