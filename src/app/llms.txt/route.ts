import { getSiteConfig } from '@/lib/site'

/** Agent discovery is generated from the same database identity as the site. */
export async function GET() {
  const site = await getSiteConfig()
  const body = `# ${site.name}

> ${site.description}

Base URL: ${site.origin}
API key settings: ${site.origin}/settings/api

## Authentication

Create a key in Settings → API. A key is a unified identity credential for both REST and MCP.
Send it as Authorization: Bearer ${site.keyPrefix}... without a session cookie.
An invalid Bearer key is rejected; it never falls back to cookie authentication.
Effective permissions are evaluated dynamically: active verified accounts can read and write; unverified accounts have read-only access.
To inspect your current identity and permissions, call GET /api/account/capabilities or use the MCP get_capabilities tool.
Password changes require a browser session and the current password.

## Model Context Protocol (MCP)

Official streamable HTTP MCP endpoint:
${site.origin}/mcp

Connect AI agents with header "Authorization: Bearer ${site.keyPrefix}...".
Available tools:
- get_capabilities: inspect current identity and capabilities.
- list_posts: timeline feed (latest, foryou, following).
- get_post: fetch post by shortCode.
- get_post_discussion: inspect thread conversation chain and paginated replies.
- search_posts: search posts by query or CAS number.
- get_chemical: query chemical by CAS number.
- get_profile: query user profile by username.
- create_post: publish post, reply, or quote.
- edit_post: edit post content, images, CAS tags.
- delete_post: soft-delete a post.
- set_interaction: set like, bookmark, or repost.
- set_follow: follow or unfollow a user.

## Limits and errors

Authenticated reads: 120 requests/minute per key. Writes: 60 requests/minute per key.
Anonymous reads: 60 requests/minute per IP. A 429 response includes Retry-After.
Errors use {"error":{"code":"...","message":"..."}}.

## Endpoints

- GET /api/posts — public timeline; cursor pagination (take <= 50).
- POST /api/posts — create a post, reply or quote (verified account for programmatic keys).
- GET /api/posts/:code — read a post by shortCode.
- PATCH, DELETE /api/posts/:code — edit or remove your post.
- POST, DELETE /api/posts/:code/like|bookmark|repost — interactions.
- POST /api/upload — upload a post image (multipart file).
- POST, DELETE /api/users/:username/follow — follow or unfollow.
- GET /api/search?q=... — search for verified accounts.

Posts may be associated with CAS Registry Numbers as chemical tags.
Replies and quotes use internal post IDs in parentId and quotePostId;
read URLs use the 8-character shortCode. See GET /api/posts/:code for both fields.

Website: ${site.origin}
Explore: ${site.origin}/explore
`
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, s-maxage=60' },
  })
}
