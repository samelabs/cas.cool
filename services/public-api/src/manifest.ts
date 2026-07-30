/**
 * API capability manifest — the single source of truth for the public API
 * surface. Consumed by `GET /api/v1/` (discovery index) and available for
 * OpenAPI/schema generation.
 *
 * Every entry must answer four questions an agent would ask:
 *   1. What does this endpoint do?  (summary)
 *   2. Do I need to authenticate?   (auth)
 *   3. What parameters do I send?   (params)
 *   4. What constraints apply?      (description)
 */

export interface ManifestParam {
  name: string
  location: 'path' | 'query' | 'body'
  required: boolean
  type: string
  description: string
}

export interface ManifestEndpoint {
  method: string
  path: string
  summary: string
  description: string
  auth: boolean
  params: ManifestParam[]
}

export interface Manifest {
  service: string
  version: string
  description: string
  baseUrl: string
  auth: {
    type: string
    header: string
    keyPrefix: string
    obtainUrl: string
    requirements: string[]
  }
  rateLimits: {
    read: string
    write: string
    unauthenticated: string
  }
  pagination: {
    cursorParam: string
    takeParam: string
    description: string
  }
  endpoints: ManifestEndpoint[]
}

export const manifest: Manifest = {
  service: 'cas.cool',
  version: 'v1',
  description:
    'A chemistry-focused social platform (Twitter/X-style) where chemists, researchers, and industry professionals post, discuss, and share chemical knowledge. Posts can reference CAS Registry Numbers for structured discovery.',
  baseUrl: 'https://cas.cool/api/v1',
  auth: {
    type: 'Bearer token',
    header: 'Authorization: Bearer cas_...',
    keyPrefix: 'cas_',
    obtainUrl: 'https://cas.cool/settings/api',
    requirements: [
      'Active account with verificationStatus "verified"',
      'Login at https://cas.cool/login, then open Settings → API',
    ],
  },
  rateLimits: {
    read: '120 requests/minute per API key',
    write: '60 requests/minute per API key',
    unauthenticated: '120 requests/minute per IP (discovery endpoints only)',
  },
  pagination: {
    cursorParam: 'cursor',
    takeParam: 'take',
    description:
      'Cursor-based pagination. Pass the `nextCursor` value from the previous response as `?cursor=...`. Control page size with `?take=N` (default 20, max 50).',
  },
  endpoints: [
    // ── Discovery (no auth) ────────────────────────────
    {
      method: 'GET',
      path: '/',
      summary: 'API discovery index — this document.',
      description:
        'Returns the full API manifest: endpoints, auth method, rate limits, and pagination scheme. No authentication required. This is the first endpoint an agent should call.',
      auth: false,
      params: [],
    },
    {
      method: 'GET',
      path: '/me',
      summary: 'Identify the current API key holder.',
      description:
        'Returns the user identity bound to the provided API key, including username, verification status, role, and key metadata. Use this to verify a key is valid and to learn who you are acting as.',
      auth: true,
      params: [],
    },

    // ── Reading content ────────────────────────────────
    {
      method: 'GET',
      path: '/timeline',
      summary: 'Get the global chronological feed of top-level posts.',
      description:
        'Returns recent posts (excluding replies) in reverse-chronological order. Each post includes author, chemical tags, engagement counts, and the current user\'s interaction state (liked/reposted/bookmarked).',
      auth: true,
      params: [
        { name: 'cursor', location: 'query', required: false, type: 'string', description: 'Pagination cursor from a previous response\'s `nextCursor`.' },
        { name: 'take', location: 'query', required: false, type: 'integer', description: 'Page size (default 20, max 50).' },
      ],
    },
    {
      method: 'GET',
      path: '/search',
      summary: 'Search posts by text content or CAS number.',
      description:
        'Full-text search across all top-level posts. Queries containing digit-dash patterns (e.g. "64-17-5") also match posts tagged with that CAS number. Minimum 2 characters, maximum 200.',
      auth: true,
      params: [
        { name: 'q', location: 'query', required: true, type: 'string', description: 'Search query (2–200 characters).' },
        { name: 'cursor', location: 'query', required: false, type: 'string', description: 'Pagination cursor.' },
        { name: 'take', location: 'query', required: false, type: 'integer', description: 'Page size (default 20, max 50).' },
      ],
    },
    {
      method: 'GET',
      path: '/posts/:code',
      summary: 'Get a single post by its short code.',
      description:
        'Returns the full post object (author, content, chemicals, engagement counts). The `:code` is the 8-character shortCode visible in the post URL (e.g. cas.cool/p/Ab3xY9zK).',
      auth: true,
      params: [
        { name: 'code', location: 'path', required: true, type: 'string', description: '8-character post shortCode.' },
      ],
    },

    // ── Writing content ────────────────────────────────
    {
      method: 'POST',
      path: '/posts',
      summary: 'Create a post (top-level, reply, or quote).',
      description:
        'Create a new post. Content is required (max 2000 characters). To reply, pass `parentId` with the target post ID. To quote, pass `quotePostId`. CAS numbers in the content matching the pattern \\d{2,7}-\\d{2}-\\d are automatically detected and tagged; additional CAS numbers can be passed via `casNumbers`.',
      auth: true,
      params: [
        { name: 'content', location: 'body', required: true, type: 'string', description: 'Post text (1–2000 characters).' },
        { name: 'parentId', location: 'body', required: false, type: 'string', description: 'Post ID to reply to. Makes this post a reply.' },
        { name: 'quotePostId', location: 'body', required: false, type: 'string', description: 'Post ID to quote. Makes this post a quote post.' },
        { name: 'casNumbers', location: 'body', required: false, type: 'string[]', description: 'Additional CAS numbers to tag (e.g. ["64-17-5", "7732-18-5"]). Auto-detected CAS numbers in content are also tagged.' },
      ],
    },

    // ── Interactions ───────────────────────────────────
    {
      method: 'POST',
      path: '/posts/:code/like',
      summary: 'Like a post.',
      description: 'Idempotent: liking an already-liked post returns 200 with no duplicate. Returns `{ liked: true }`.',
      auth: true,
      params: [
        { name: 'code', location: 'path', required: true, type: 'string', description: 'Post shortCode.' },
      ],
    },
    {
      method: 'DELETE',
      path: '/posts/:code/like',
      summary: 'Remove a like from a post.',
      description: 'Idempotent: unliking a post that wasn\'t liked returns 200 with no error. Returns `{ liked: false }`.',
      auth: true,
      params: [
        { name: 'code', location: 'path', required: true, type: 'string', description: 'Post shortCode.' },
      ],
    },
    {
      method: 'POST',
      path: '/posts/:code/bookmark',
      summary: 'Bookmark a post.',
      description: 'Save a post for later reference. Idempotent. Returns `{ bookmarked: true }`.',
      auth: true,
      params: [
        { name: 'code', location: 'path', required: true, type: 'string', description: 'Post shortCode.' },
      ],
    },
    {
      method: 'DELETE',
      path: '/posts/:code/bookmark',
      summary: 'Remove a bookmark.',
      description: 'Idempotent. Returns `{ bookmarked: false }`.',
      auth: true,
      params: [
        { name: 'code', location: 'path', required: true, type: 'string', description: 'Post shortCode.' },
      ],
    },

    // ── Users ──────────────────────────────────────────
    {
      method: 'GET',
      path: '/users/:username',
      summary: 'Get a user\'s profile.',
      description:
        'Returns the user\'s profile: displayName, bio, avatar, location, website, role, verification status, and denormalized counts (posts, followers, following).',
      auth: true,
      params: [
        { name: 'username', location: 'path', required: true, type: 'string', description: 'Username (case-insensitive).' },
      ],
    },
    {
      method: 'GET',
      path: '/users/:username/posts',
      summary: 'Get a user\'s posts.',
      description:
        'Returns posts by the specified user. Use `scope` to filter: omit for top-level posts only, `scope=replies` for replies only, `scope=media` for posts with images.',
      auth: true,
      params: [
        { name: 'username', location: 'path', required: true, type: 'string', description: 'Username (case-insensitive).' },
        { name: 'scope', location: 'query', required: false, type: 'string', description: 'Filter: omit (default, top-level posts), "replies", or "media".' },
        { name: 'cursor', location: 'query', required: false, type: 'string', description: 'Pagination cursor.' },
        { name: 'take', location: 'query', required: false, type: 'integer', description: 'Page size (default 20, max 50).' },
      ],
    },
    {
      method: 'POST',
      path: '/users/:username/follow',
      summary: 'Follow a user.',
      description: 'Idempotent: following an already-followed user returns 200 with no duplicate. Cannot follow yourself. Returns `{ following: true }`.',
      auth: true,
      params: [
        { name: 'username', location: 'path', required: true, type: 'string', description: 'Username to follow (case-insensitive).' },
      ],
    },
    {
      method: 'DELETE',
      path: '/users/:username/follow',
      summary: 'Unfollow a user.',
      description: 'Idempotent: unfollowing a user you don\'t follow returns 200 with no error. Returns `{ following: false }`.',
      auth: true,
      params: [
        { name: 'username', location: 'path', required: true, type: 'string', description: 'Username to unfollow (case-insensitive).' },
      ],
    },
  ],
}
