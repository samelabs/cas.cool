# API Contract — as implemented on 2026-10-28

Factual record of the HTTP endpoints under `/api`. Update this file with
each behavior change; the schema, route code, and contract tests define the
runtime behavior.

## Identity & auth model

All route handlers resolve the caller through `src/lib/api-auth.ts`
(`resolveIdentity()`), in this order:

1. **API Key** — `Authorization: Bearer <key>`. New-key prefix comes from
   `SiteConfig.keyPrefix`; the full raw key is SHA-256
   hashed and looked up in `ApiKey.keyHash`. Rejected if missing, revoked
   (`revokedAt` set), or expired. The owning user must exist and not be
   `suspended`. The credential only proves identity; capabilities are
   dynamically derived server-side based on the account's active standing and
   current verification.
2. **Session** — `feed_session` cookie. JWT HS256 (jose) whose signature and
   expiry are verified, **plus** a matching `Session` DB row (revocation
   check). Owning user must not be `suspended`. Existing browser membership
   rules are preserved (unverified web members can post, like, and follow).
3. **Anonymous** — no Authorization header or session; `ip` is captured for
   rate-limit bucketing. An invalid Authorization header never falls back to
   a valid cookie session.

Handlers consume the shared `AuthIdentity` shape. Guards:

| Guard | Failure | Semantics |
|---|---|---|
| `requireAuth()` | 401 `unauthorized` | Any authenticated user in good standing (not suspended) |
| `requireWrite()` | 401 / 403 `forbidden` | Authenticated and active. Web session: active status; Programmatic (API Key / MCP): active status AND current valid verification (`verificationExpiresAt > now`) |
| `requireAdmin('read' \| 'write')` | 401 / 403 `forbidden` | Admin role in good standing. Programmatic admin mutations also require active status and current verification |

`POST /api/me/password` requires a browser session and the current password.
It re-issues a session cookie after invalidating other sessions.

## Rate limiting

`src/lib/rate-limit.ts` — in-process token bucket, applied **inside route
handlers** via `checkRateLimit(identity, tier)`. `src/proxy.ts` does no rate
limiting (it only redirects unauthenticated page traffic to `/login`).

| Tier | Capacity / refill | Applied to |
|---|---|---|
| `read` | 120/min | authenticated reads |
| `write` | 60/min | mutations (`requireWrite` routes) |
| `anon` | 60/min | anonymous-reachable endpoints that must limit before DB work (`/api/auth/check-username`) |

Bucket keys: `key:<apiKeyId>` / `u:<userId>` / `ip:<last X-Forwarded-For hop
or X-Real-IP>` (only the hop appended by our own nginx is trusted). 429
responses carry `Retry-After` and `X-RateLimit-Limit`.

Buckets live in process memory: they reset on restart and are per-process
(single Next.js process in production, so consistent).

## Conventions

- **Errors**: `{ "error": { "code": "...", "message": "..." } }`. Codes in
  use: `unauthorized`, `forbidden`, `bad_request`, `not_found`,
  `rate_limited`, `payload_too_large`, `invalid_file`, `server_error`.
- **Lists**: cursor pagination is the norm — `{ <items>, nextCursor }`;
  `?cursor=` from the previous `nextCursor`. Actual shapes per endpoint:
  - `/api/posts`, `/api/search`: `take` clamped 1–50, default 20; fractional sizes round down before querying and cursor computation. Parameterized keyset cursor `(createdAt, id)` ensures cross-page deduplication and SQL injection immunity without interpolating values (search LIMIT is bound too). Timestamp cursors must be valid calendar dates in canonical UTC millisecond format. `/api/posts` rejects an unparseable `since` with 400, and validates `cursor` even when `since` is present (that branch ignores the cursor, but it must still be well-formed). Invalid search cursors return an empty page. Latest feed cursor matches the actual candidate consumption boundary in strict chronological order. `tab=following` returns 401 anonymously. `bookmarkedBy` returns 401 anonymously, 403 cross-account, and uses composite `(Bookmark.createdAt, Bookmark.id)` keyset cursor.
  - `/api/notifications`: cursor + `unreadCount`
  - `/api/admin/verifications`: cursor, `take` max 100, default 20
  - `/api/admin/users`: **page-based** (`?page=`, 50/page) — not cursor
  - `/api/admin/reports`: **no pagination** — latest 50 fixed + `pendingCount`
  - `GET /api/messages/:id`: **incremental poll semantics** — composite cursor
    `?afterTs=<canonicalISO>&afterId=<messageId>`; returns messages strictly
    after the `(createdAt, id)` boundary in `(createdAt, id)` order (max 50)
    plus `hasMore` — callers advance with the last message's pair and drain
    until `hasMore=false`. Missing/malformed `afterTs` → 400. Only the
    received messages actually returned are confirmed read, and only for
    callers with write permission. **History paging**: the same route with
    `?beforeTs=<canonicalISO>&beforeId=<messageId>` returns the 50 messages
    strictly BEFORE the composite boundary (chronological order, own
    `hasMore`) — the thread UI's scroll-to-top continuation beyond the
    most-recent first screen
- **Post addressing**: URL paths address posts by **shortCode** (8-char
  base62, e.g. `/api/posts/Ab3xY9zK`). Creating replies/quotes addresses
  posts by **internal `id`** (`parentId` / `quotePostId` in the POST body).
  Serialized posts expose both `id` and `shortCode`.
- **Cursors**: latest/following, chronological pages, and bookmarks use
  `<createdAtISO>|<id>`; the ranked For You first page emits a bare ISO
  timestamp. Malformed cursors return `400 bad_request` (previously surfaced as a 500).
- **Soft delete**: posts get `deletedAt` set, content/images/chemicals
  cleared; queries filter `deletedAt: null`.

## Endpoint inventory

Auth column: **public** = anonymous allowed (rate-limited by IP);
**user** = `requireAuth`; **write** = `requireWrite`; **admin** =
`requireAdmin`. Session cookie and Bearer key are accepted interchangeably
unless noted.

| Method & path | Auth | Tier | Notes |
|---|---|---|---|
| `GET /api/posts` | public | read | Timeline. `tab` (latest/following/foryou), filters: `cas`, `author`, `scope` (replies/media), `likedBy`, `bookmarkedBy`, `repliesOf`, `conversationOf`, `ancestorsOf`, `since`. `cas` requires Latest and cannot combine with `since`, `likedBy` or `bookmarkedBy`; unsupported combinations return 400 instead of silently dropping CAS. `ancestorsOf` returns bounded ancestor chain with `cursor` continuation. |
| `POST /api/posts` | write | write | `{ content, parentId?, quotePostId?, casNumbers?, images? }` (ids, not shortCodes). Quote requires text; ≤4 images, each a `/uploads/` URL; 201 + serialized post |
| `GET /api/posts/:code` | public | read | Single post + context by shortCode |
| `PATCH /api/posts/:code` | write | write | Author only, **60-minute edit window**; `content` trimmed; `images` omitted preserves current images, `images: []` clears all images, `images: [urls]` replaces images (≤4); `casNumbers` replaces previous set |
| `DELETE /api/posts/:code` | write | write | Author or admin. Soft delete; counters decremented in a transaction; file cleanup best-effort |
| `POST /api/posts/:code/like` | write | write | Idempotent |
| `POST /api/posts/:code/bookmark` | write | write | Idempotent |
| `POST /api/posts/:code/repost` | write | write | Dual record: `Repost` row **and** empty `Post` with `quotePostId` linked by non-nullable `Repost.repostPostId`; creates REPOST notification |
| `DELETE /api/posts/:code/like` \| `bookmark` \| `repost` | write | write | Idempotent undo. Repost cancel deletes `Repost` row, soft-deletes generated `Post` as 200 tombstone (preserving quote and reply trees), and decrements original `repostCount` |
| `POST /api/posts/:code/view` | public | read | View counting in single transaction: excludes post author from views, dedupes repeat viewers via conditional insert into `PostView`, only increments `Post.views` on fresh view; transaction rollback on failure avoids false 200s. Explicit Bearer token callers require programmatic write access (invalid Bearer 401, unverified Bearer 403, neither records view); anonymous and browser session telemetry preserved. |
| `GET /api/search?q=&cursor=&take=` | public* | read | *Verified-only feature (`canSearch`); anonymous/unverified callers get `{ posts: [], nextCursor: null }`, not an error |
| `POST /api/upload` | write | write | multipart `file` + `purpose` (post/avatar/banner/verification). Verified-only except `purpose=verification`. ≤10 MB raw (GIF ≤5 MB). 201 `{ url, filename, bytes }` |
| `POST /api/users/:username/follow` | write | write | Delegated to shared `setUserFollow` service (idempotent follow/unfollow and notification) |
| `DELETE /api/users/:username/follow` | write | write | Delegated to shared `setUserFollow` service |
| `POST /api/auth/login` | public | write (IP bucket when anonymous) | `{ identifier (email or username), password }`; sets `feed_session`; suspended → 403 |
| `POST /api/auth/register` | public | write (IP bucket) | Username sanitized/reserved-checked; sets session |
| `POST /api/auth/logout` | public | write | Clears current session only |
| `GET /api/auth/check-username?username=` | public | anon | Availability check; limits **before** DB work |
| `PATCH /api/me/profile` | write | write | Profile fields (bio, avatar, banner, …) |
| `POST /api/me/password` | session | write | `{ currentPassword, newPassword }`. Deletes all sessions, then re-issues one cookie for the calling device |
| `GET /api/account/capabilities` | public | read | Safe dynamic capability metadata (`authenticated`, `method`, `user`, `verification`, `permissions`, `restrictions`). `Cache-Control: no-store` |
| `GET /api/account/api-keys` | user | — | Lists active keys (no raw keys). Web session callers and Bearer callers can query keys |
| `POST /api/account/api-keys` | user (session only) | write | Active members can create unified credentials (no `access` parameter). Max 5 active; concurrency protected by row lock on User; 201 includes `rawKey` (shown once) |
| `DELETE /api/account/api-keys/:id` | user (session only) | write | Revoke own key. Programmatic API keys cannot manage API keys |
| `POST /api/account/verification` | write | write | `{ idName, idNumber, idFrontImage, idBackImage }`; images from `purpose=verification` uploads; upsert (one active submission) |
| `GET /api/media/verification/:filename` | user | read | Private attachment: upload-time owner, or admin reviewing a referencing submission. Other members receive 404. `private, no-store` |
| `GET /api/notifications` | user | read | `{ notifications, nextCursor, unreadCount }`. `cursor` is the compound `<canonicalTimestamp>\|<id>` keyset emitted as `nextCursor`; malformed cursors return 400 `bad_request` (validated in the shared service before any query). Paging through the backlog NEVER confirms anything read |
| `POST /api/notifications/read` | write | write | Explicit mark-ALL read (the only bulk read confirmation; page loads mark only their returned rows, guarded by the row revision they observed) |
| `POST /api/notifications/ack` | write | write | Per-object versioned confirmation: `{ items: [{ id, revision }] }` (max 100). Revisions are integers from 0 through 2147483647; an invalid item rejects the entire batch with 400 before writes. Each item updates only its own row, only if still unread at the observed revision and owned by the caller. Returns `{ confirmed, unreadRemaining }` |
| `POST /api/messages` | write | write | `{ recipientId, content }`; DM gating (below) |
| `GET /api/messages/:id` | user | read | Incremental poll after the composite `(createdAt, id)` boundary; `hasMore` continuation. Programmatic caller without write permission can read without updating `readAt` |
| `DELETE /api/messages/:id` | write | write | Per-side soft delete; when both sides deleted → permanent removal |
| `POST /api/messages/:id/send` | write | write | `{ content }` |
| `POST /mcp` | bearer | read/write | Model Context Protocol Streamable HTTP endpoint. Stateless JSON-RPC 2.0. Origin validated against `SiteConfig.origin`, 64KB max body, shared rate limiting, dynamic tool registration based on verification standing |
| `POST /api/reports` | write | write | `{ targetType: POST\|USER, targetId, reason, detail? }` |
| `GET /api/admin/users` | admin | read | `q`, `status`, `page` (page-based, 50/page) |
| `GET /api/admin/site` | admin | read | Read SiteConfig row 1 |
| `PATCH /api/admin/site` | admin | write | Update public profile fields; invalidate site caches. Origin and key prefix remain deployment-owned |
| `POST /api/admin/uploads/sweep` | admin | write | Reclaim unreferenced uploads beyond 24 h; ownership expiry uses the same asset locks as verification submissions |
| `PATCH /api/admin/users/:id` | admin | write | Status/role management |
| `POST /api/admin/users/:id/verify` | admin | write | |
| `POST /api/admin/users/:id/revoke-verification` | admin | write | Also rejects any pending submission |
| `GET /api/admin/reports` | admin | read | |
| `POST /api/admin/reports/:id/resolve` | admin | write | Atomic business transaction: soft-delete (`deleteReportedPost`), user suspension, and report status transition executed in one tx; replays safely abort (400) without re-executing penalties or re-decrementing counters; post-commit side effects run through the `SideEffectTask` outbox |
| `POST /api/admin/side-effects/retry` | admin | write | Claims at most 500 pending `SideEffectTask` rows (idempotent executors). Response: `{ attempted, succeeded, failed, pending, failedTasks: [{ id, kind, lastError }] }`; `pending` is global, failures are from this run. Superseded executions count only as attempted, so succeeded + failed may be smaller than attempted |
| `POST /api/admin/reports/:id/dismiss` | admin | write | |
| `GET /api/admin/verifications` | admin | read | |
| `POST /api/admin/verifications/:id/approve` | admin | write | |
| `POST /api/admin/verifications/:id/reject` | admin | write | |

## Permission matrix (feature gates)

`src/lib/permissions.ts` — verification tiers: `verified` full access;
`unverified` and `pending` limited.

| Feature | Gate |
|---|---|
| Post length | 2000 chars verified / 300 otherwise |
| Media upload (post/avatar/banner) | verified only |
| Search | verified only |
| API key creation | verified only |
| DM | verified → anyone; unverified → only users who follow them |

Account status: `suspended` = rejected at auth (treated as logged out);
`restricted` = read-only (writes fail `requireWrite` with 403).

## Implementation notes

- Route handlers under `/api/posts*` are HTTP shells (parse, auth, rate
  limit, respond). Post behavior is layered: the product-independent core
  (reads in `src/lib/services/post-core.service.ts`, write transaction
  steps in `post-core-write.service.ts`, interactions in
  `interaction.service.ts`) is composed with the chemical product layer
  (`src/lib/chemistry/`: write rules, feed predicate, per-page tag
  attachment) by the application services `post.service.ts` and
  `post-write.service.ts`. Every post mutation runs ONE database transaction;
  post lists serialize `CorePost` and attach compound tags in one bounded
  per-page statement. Create/edit assemble their response inside that
  transaction, so a failed tag read cannot leave a committed write behind a
  failed HTTP response. The same functions are reusable by server
  components. Admin report resolution with `action: 'delete'` calls the
  shared `deleteReportedPost` — identical counters and idempotency as the
  author delete. Pinned by `tests/api.contract.test.ts` (CAS
  create/edit/delete counter exactness, CAS keyset pagination without
  duplicates or skips, moderation-delete idempotency) and
  `tests/module-boundary.test.ts` (the core stays chemistry-free).
- Edit validation (live state, ownership, 60-minute window and pure-repost
  restriction) runs after taking the post row lock, in the write transaction.
  An edit losing to a delete returns 404 without changing the tombstone or
  CAS counts; image cleanup uses the snapshot actually replaced. Cache
  invalidation failures are logged without failing committed post mutations,
  and reply/quote notification recipients require no post-commit lookups.
  Real-database regressions live in `tests/post-write.audit.test.ts`.
- Unified API-key dynamic authorization model is pinned end-to-end by
  `tests/api.permissions.test.ts` and `tests/mcp.integration.test.ts`:
  a single API key serves as identity credential. Programmatic write operations
  (REST mutations and MCP write tools) strictly require active standing and
  current verification. Unverified keys receive 403 on write endpoints and
  cannot see or execute write tools. When verification status changes, the
  *same* key dynamically gains or loses write capabilities without reissuing.
  Admin mutations require active standing and verification. Password changes
  strictly require a browser session.
- The only writes reachable from a GET are the fire-and-forget
  `UPDATE ApiKey.lastUsedAt` on API-key requests (caller-owned metadata for
  the settings page) and conversation read receipts (`UPDATE Conversation.readAt`)
  when polled by callers with write permission (`writeAccessError(auth.identity) === null`).
  Read-only callers read conversation history without updating `readAt`. View counting is POST-only.
- Key creation does not require access parameters (`access` and `ApiKeyAccess`
  dropped in migration `20261029140000_retire_api_key_access`). Concurrent
  creation race is eliminated via row locking on the `User` record inside
  the creation transaction.
- A public endpoint may still return 200 when a Bearer key is invalid because
  the endpoint is anonymous. Check key validity on
  `GET /api/account/api-keys` without a cookie.
- Replies and quotes reference internal post IDs; read paths use shortCodes.
- Admin user pagination uses pages; message polling uses fixed batches.
- Denormalized counters are updated in the same transaction as writes.
- CAS numbers are the only structured post tags. `@username` text is a
  passive profile link; publishing a post does not create mention alerts.
- Site identity, origin and new-key prefix come from `SiteConfig`;
  `/llms.txt`, robots, sitemap and the web manifest use that row.
  Propagation is measured and documented in `docs/FEED-PERF.md`: robots,
  manifest and sitemap are static with 1 h revalidation; llms.txt
  is dynamic but reads the same cached row. A database-only change becomes
  eligible for propagation after revalidation; an immediate switch uses a
  clean build and restart.

## Model Context Protocol (MCP) Tools

Endpoint: `POST /mcp` (Streamable HTTP, JSON-RPC 2.0). Requires `Authorization: Bearer <api_key>`.
Tools are dynamically registered in `tools/list` according to the caller's server-side capability:

### Read Tools (Available to all authenticated callers)
1. `get_capabilities`: Inspect caller identity, account standing, and dynamic read/write capabilities.
2. `list_posts`: Fetch timeline posts by tab (`latest`, `following`, `foryou`), optional CAS filter, author username, cursor, or take.
3. `get_post`: Retrieve a single post by shortCode, including chemical details, author profile, and interaction counts. Returns not found for soft-deleted posts.
4. `get_post_discussion`: Read thread context (bounded ancestor reply chain and direct replies) for a post by shortCode with independent `ancestorCursor` and `cursor` pagination. Bounded recursive CTE walks parent pointers and traverses soft-deleted boundaries while preserving tombstones. `nextAncestorCursor` is the only token accepted by `ancestorCursor` to continue ancestor pagination: it is opaque, HMAC-signed, and bound to the target post, so tokens issued for another discussion — including legacy bare post IDs — are rejected with an error, for root posts exactly as for replies (a root post without a cursor returns an empty ancestor page). `oldestAncestorId` is boundary information only and is never a valid cursor.
5. `search_posts`: Full-text post search across text and chemical CAS numbers with cursor pagination (verified callers only).
6. `get_chemical`: Retrieve registered compound metadata and post count by CAS registry number.
7. `get_profile`: Lookup public user profile, bio, follower/following counts, verification standing, and (for authenticated callers) `viewerRelationship` (`isYou` / `youFollow` / `followsYou`) so agents never probe the relationship with write operations.
8. `list_notifications`: Read the caller's notification inbox, newest first, with actor + post shortCode context and `unreadCount` + `nextCursor`. Strictly read-only — nothing is marked read. Null-postId types dedupe atomically via a partial unique index; LIKE/REPOST/FOLLOW re-surfacing is subject to the 60-minute recipient cooldown (see ARCHITECTURE.md "Notification lifecycle").

### Write Tools (Gated: Active + Current Verification required)
9. `mark_notifications_read`: Explicitly mark ALL notifications read (mirror of `POST /api/notifications/read`).
10. `create_post`: Publish a chemical post, reply, or quote. Supports CAS tags and up to 4 pre-uploaded images. Optional `clientRequestId` (8–64 chars, `[A-Za-z0-9_-]`): the key is arbitrated INSIDE the creation transaction (post, counters, CAS relations, outbox tasks and the key row commit or roll back together), binding one logical creation to one (caller, key) pair for 24 h — expiry is enforced at arbitration time. Same key + same content (concurrent or retried) yields exactly one post, with the loser/concurrent replay returning the committed original (`replayed: true`); same key + different content → tool error `request_key_conflict`; original deleted → `request_key_post_gone`. Without the key the call is non-idempotent; on an uncertain result verify via `list_posts(author=...)`/`get_post` instead of blindly re-sending. ALL business tool errors return structured `structuredContent.error` with a stable `code` (invalid_arguments, invalid_cursor, unauthorized, forbidden, not_found, request_key_conflict, request_key_post_gone, asset_gone, …) and, where useful, a `recovery` direction — these are MCP tool results, not HTTP status changes.
11. `edit_post`: Modify content, tags, or attachments within the 60-minute window under post row lock. `images: undefined` preserves existing images; `images: []` clears all images; `images: [urls]` replaces images.
12. `delete_post`: Soft-delete own post, preserving conversation trees via tombstones.
13. `set_interaction`: Perform or undo likes, bookmarks, and reposts. Idempotent.
14. `set_follow`: Follow or unfollow a user by username via shared follow service. Idempotent.
