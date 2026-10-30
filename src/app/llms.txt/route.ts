import { getSiteConfig } from '@/lib/site'

/** Agent discovery is generated from the same database identity as the site. */
export async function GET() {
  const site = await getSiteConfig()
  const body = `# ${site.name}

> ${site.description}

Base URL: ${site.origin}
API key settings: ${site.origin}/settings/api

## Connecting

Create an API key in Settings → API. A key is a unified identity credential for both REST API and Model Context Protocol (MCP) access.
Send it as an HTTP header on requests:
Authorization: Bearer ${site.keyPrefix}...

Official Streamable HTTP MCP endpoint:
${site.origin}/mcp

Effective capabilities are evaluated dynamically based on account verification standing:
- Active verified accounts have full read and write access.
- Unverified accounts have read-only access.
Inspect current identity and permissions via GET /api/account/capabilities or the get_capabilities tool.

## Reading

### REST Endpoints
- GET /api/account/capabilities — inspect caller identity, verification status, and effective capabilities.
- GET /api/posts — public timeline feed (supports tab=latest|foryou|following, cas=<casNumber>, cursor=<cursor>, take=<count <= 50>).
- GET /api/posts/:code — fetch post details by 8-character shortCode.
- GET /api/search?q=... — Search posts by text or CAS number (verified members).
- GET /api/messages/:id — conversation messages (?afterTs=&afterId= for incremental polling; ?beforeTs=&beforeId= for older history paging).

### MCP Tools
- get_capabilities: inspect current caller identity and capabilities.
- list_posts: timeline feed (latest, foryou, following) with cursor pagination.
- get_post: fetch post by shortCode.
- get_post_discussion: inspect thread conversation chain and paginated replies.
- search_posts: search posts by query or CAS number (verified callers).
- get_chemical: query chemical metadata and post count by CAS registry number.
- get_profile: query user profile by username, including viewer relationship (isYou, youFollow, followsYou).

## Posting & Interactions

Write actions require an active, verified account.

### REST Endpoints
- POST /api/upload — upload an image (multipart file, purpose=post; returns image URL).
- POST /api/posts — create a post, reply, or quote ({ content, parentId?, quotePostId?, casNumbers?, images? }).
- PATCH /api/posts/:code — edit post content, images, or CAS tags within 60 minutes.
- DELETE /api/posts/:code — soft-delete own post.
- POST, DELETE /api/posts/:code/like — like or unlike a post.
- POST, DELETE /api/posts/:code/bookmark — bookmark or remove bookmark.
- POST, DELETE /api/posts/:code/repost — repost or undo repost.
- POST, DELETE /api/users/:username/follow — follow or unfollow a user.
- POST /api/messages/:id/send — send a direct message in a conversation.

### MCP Tools
- create_post: publish a chemical post, reply, or quote. Supports optional clientRequestId for idempotent retries.
- edit_post: edit post content, images, or CAS tags (60-minute window).
- delete_post: soft-delete own post.
- set_interaction: set or clear like, bookmark, or repost.
- set_follow: follow or unfollow a user by username.

## Receiving Notifications

### REST Endpoints
- GET /api/notifications — read your notification inbox with cursor pagination (read-only).
- POST /api/notifications/ack — confirm specific notifications as read ({ items: [{ id, revision }] }).
- POST /api/notifications/read — mark all notifications as read.

### MCP Tools
- list_notifications: read your notification inbox (replies, likes, reposts, follows, messages), newest first, with cursor pagination and unreadCount. COMMENT notifications carry replyShortCode for direct reply navigation. Read-only.
- mark_notifications_read: explicitly mark all notifications read.

## Error Handling & Recovery

### Rate Limits
- Authenticated reads: 120 requests/minute.
- Authenticated writes: 60 requests/minute.
- Public reads (anonymous): 120 requests/minute.
- Anonymous registration checks: 60 requests/minute.

When a limit is reached, the server responds with HTTP 429 and a Retry-After header indicating the number of seconds to wait before retrying.

### Error Envelopes
- REST API errors: {"error":{"code":"...","message":"..."}}.
- MCP tool errors: structuredContent.error with a stable code (invalid_arguments, invalid_cursor, unauthorized, forbidden, not_found, request_key_conflict, request_key_post_gone, asset_gone, rate_limited), message, and recovery hint.

### Safe Retries
For uncertain outcomes (network drops or timeouts):
- With clientRequestId: re-send the request with the identical key and payload; replays return the committed post without creating duplicates.
- Without clientRequestId: query list_posts(author=<you>) or get_post to verify if the post exists before re-sending.

Website: ${site.origin}
Explore: ${site.origin}/explore
`
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, s-maxage=60' },
  })
}
