# Feed Architecture

cas.cool runs as one Next.js process with PostgreSQL. The reusable part is the
timeline, identity, interactions, conversations, uploads, notifications and
API contract. CAS-number discovery is the chemical product layer. A post's
chemical associations are stored in `Chemical`; there is no general tag table.

## Boundaries

- `src/app/(shell)` renders pages and fetches server data. Client components
  handle interaction state and use `src/lib/api-client.ts` for mutations.
- `src/app/api` owns HTTP parsing, authentication, rate limiting and response
  envelopes. Domain behavior lives in services below; routes stay HTTP
  shells — pinned over real HTTP by `tests/api.contract.test.ts`, with the
  import closure itself pinned by `tests/module-boundary.test.ts`. When
  moving a write out of a route, move its transaction and count updates
  together; don't split invariants across layers.
- **The post domain is two layers plus composition.** The product-independent
  core: reads (timeline, detail, chains, follow checks) in
  `src/lib/services/post-core.service.ts`, generic write transaction steps
  (post row, replyCount, user postCount) in `post-core-write.service.ts`,
  interactions (like/bookmark/repost) in `interaction.service.ts`, and the
  shared projection (`postInclude` / `serializePost` → `CorePost`) in
  `src/lib/serialize.ts`. The core never mentions CAS or `Chemical` —
  no filter, no include, no field (`FeedQuery.postWhere` is an opaque
  predicate the application layer supplies for chronological selection).
- **CAS discovery is the chemical product layer**, `src/lib/chemistry/`:
  write rules (validation, content auto-extraction, Chemical upserts,
  `postCount` maintenance) in `post-chemicals.ts`; the feed predicate
  (`chemicalPostWhere`) in `post-feed.ts`; per-page batch tag assembly
  (`attachPostChemicals` — one bounded statement covering posts and quoted
  posts) in `post-views.ts`. There is no general tag table and no per-post
  Chemical query anywhere.
- **Application composition** joins the two: `post.service.ts` (reads)
  and `post-write.service.ts` (create/edit/delete) wrap the core with
  chemistry in ONE transaction per operation; `search.service.ts` attaches
  tags the same way. Author delete (`deletePost`) and moderation delete
  (`deleteReportedPost`, used by admin report resolution) run the same
  soft-delete transaction — there is no second counting implementation.
- **Post mutation boundaries:** Edit takes the post row lock before reading
  its live state, ownership, edit window, images and CAS associations. All
  validation and writes share that transaction, so a waiting edit cannot
  refill a tombstone or clean up an obsolete image snapshot. Reply/quote
  recipients are captured during create validation; after commit there are
  no fallible recipient lookups. Trending invalidation is best-effort and
  logged centrally for create/edit/delete, including moderation.
- **Repost dual record & unified lifecycle:** A pure repost creates both a
  `Repost` row and an empty-body `Post` linked by `Repost.repostPostId` (unique, non-nullable).
  Cancelling a repost deletes the `Repost` row and decrements original `repostCount`; the
  generated post is soft-deleted as an HTTP 200 tombstone (`deletedAt = now()`), strictly
  preserving the post relationship tree (quotes, replies, conversation context) from cascade
  deletion. Deleting a generated repost post directly (via author or admin) automatically deletes
  the linked `Repost` row and decrements `repostCount`. Pure reposts cannot be edited.
- **Privacy & access boundaries:**
  - `bookmarkedBy` timeline strictly enforces viewer ownership (anonymous 401, cross-account 403, owner 200) in both the route and `post-core.service.ts`. Bookmark pagination uses a composite `(Bookmark.createdAt, Bookmark.id)` keyset cursor.
  - `tab=following` strictly requires authentication (anonymous 401).
- **Atomic interactions & moderation:**
  - Post view recording (`/api/posts/[code]/view`) uses conflict-ignoring insertion and views counter increment in a single transaction; failure rolls back deduplication without emitting false 200s. Real database trigger fault-injection verifies clean rollback and subsequent retry recovery.
  - Admin report resolution preemptively claims `Report.status = RESOLVED` before applying penalties; middle failures roll back completely. Post-commit notifications and image cleanup use the transactional `SideEffectTask` outbox. Bounded claims use `FOR UPDATE SKIP LOCKED`, `claimToken` and a 60 s lease; ownership is renewed with the database clock immediately before each execution, and superseded queued tasks are skipped. Missing ID selection means all claimable tasks; an explicit empty selection means none. Execution remains at-least-once: an executor that itself runs past its lease may overlap a retry. Notification idempotency is enforced by an immutable per-event `NotificationDelivery` record in the same transaction as the visible change; different events may re-surface one compound-unique notification. Failed tasks remain pending with `attempts`/`lastError` and can be retried via `POST /api/admin/side-effects/retry`. Only owned completion/failure writes count toward the drain's results. Committed resolutions return 200 even if side effects fail; resolution replays return 400. Real unlink failures and deterministic lease-reclaim tests cover these boundaries.
  - Repost cancel and direct post delete share one canonical transaction lock order — `Repost` row → generated post row → user row → original post row — with the repost row claimed by an id-guarded `deleteMany`. Concurrent cancel/cancel and cancel/delete pairs are race-proof (no deadlock, no P2025, counters move exactly once).
- **Notification lifecycle (1.2.0 closure):**
  - Every core notification (follow, like, repost/quote, reply, direct message) is a `SideEffectTask` enqueued INSIDE the business transaction — a P2002 loser (duplicate follow/like) rolls its task back with the relation, so only transactions that actually changed state can produce an event. Post-commit delivery is targeted; if any backlog remains, one bounded extra batch drains (traffic-driven recovery, no admin dependency). Committed business results never 500 for a side-effect failure.
  - Visible-notification invariant: at most one row per `(userId, fromId, type, postId)`; null-postId types (FOLLOW/MESSAGE) are arbitrated by a PARTIAL unique index `(userId, fromId, type) WHERE "postId" IS NULL` — the plain compound unique cannot dedup NULLs (PostgreSQL treats them as distinct). Every write is an atomic `INSERT … ON CONFLICT DO UPDATE`; there is no application-level findFirst+create.
  - Recipient-side anti-harassment (declared product rule): toggle-type events (LIKE/REPOST/FOLLOW) re-surface an existing visible notification only after a 60-minute cooldown (`src/lib/notification-policy.ts`, enforced in the same UPSERT statement, database-backed); content events (COMMENT/MESSAGE/REPORT_RESOLVED) always re-surface. Cooldown-suppressed events are still recorded as delivered (NotificationDelivery) so retries stay no-ops.
  - Read confirmation scope: page loads mark ONLY the rows they returned, guarded by the row `revision` each row carried at SELECT time — a genuine new event bumps the revision, so a stale confirmation can never clear a re-activated notification; concurrent arrivals are never touched. The badge converges to the server-confirmed remaining count. Explicit mark-all is a separate write-gated endpoint.
  - Attachment ownership: the upload-time `PrivateMedia` row is the single trust anchor. A verification submission locks its complete asset set before checking ownership and file availability. Ownership expiry takes the same lock and rechecks submission references inside its transaction; a concurrent committed submission preserves the anchor. A submission adds admin review access, while ownership remains upload-owned. Legacy ownership records are established during the deployment window.
  - Upload lifecycle coordination (acceptance round 2): reference writes (create/edit post images, avatar/banner, verification submit) acquire the two-key `pg_advisory_xact_lock(UPLOAD_ASSET_LOCK_CLASS, hashtext(url))` and assert the file exists BEFORE writing the reference (missing → 409 `asset_gone`); deletions (edit/delete cleanup, outbox cleanup, sweep) hold the same lock across their final reference check AND unlink inside one transaction — valid references and deletions are mutually exclusive by construction. Only ENOENT counts as "already gone"; permission/IO failures propagate as retryable errors.
  - create_post idempotency (acceptance round 2): request-key arbitration lives in the shared write service INSIDE the creation transaction (key insert with TTL enforcement → post → counters → CAS → outbox → key binding). Concurrent losers roll back completely; replays return the committed original. See API-BASELINE for the tool-error contracts.
  - Notification read confirmation: notifications serialize `revision` and (COMMENT) `replyShortCode`, resolved from the current `replyPostId`; the original event stamp and delivery dedup records remain unchanged by later events. Pages displayed in the web UI are confirmed via `POST /api/notifications/ack` with per-object `(id, revision)` guards; list reads leave read receipts unchanged; explicit mark-all is separate. DM threads page older history through `beforeTs`/`beforeId`, with read scope limited to returned received messages.
  - Feed and notification GET routes and authenticated MCP requests schedule bounded outbox recovery through Next.js `after()`. It runs after the response, sharing the existing per-process 30 s throttle and 20-task backlog limit; it never confirms a reader's notifications as read.
  - Attachment lifecycle: verification uploads land in `private-uploads/` (outside public/) and are readable only through `GET /api/media/verification/[filename]` — owner via the upload-time `PrivateMedia` anchor, or admin reviewing a referenced submission; everyone else gets 404 with no existence leak; `Cache-Control: private, no-store`. Public references (`post.images`, avatar/banner) accept only `/uploads/` paths, so private media cannot leak into public posts. Orphaned uploads (never attached, or released by edit/delete) are swept by `POST /api/admin/uploads/sweep` after a 24-hour grace window with a reference re-check immediately before each unlink; stale `PrivateMedia` ownership rows expire on the same sweep. Legacy public verification attachments are handled once during the deployment window, with writes paused and backups retained.
- **Discovery, SEO & Sitemaps:**
  - Public active posts are indexed through stateless shard routes (`/p/sitemap/[index]/route.ts`, `/p/sitemap/<n>.xml`): any numeric index answers at request time, so crossing the 50,000-post boundary needs no rebuild, and an index beyond the current count serves a valid empty `<urlset>` — a stale `robots.txt` entry can never resolve to 404 in either direction.
  - Shard result reuse (1.2.1): measured on the Next 16.4.3 production build, the shard segment renders dynamic (ƒ) and each request re-executed the handler (a bare `revalidate` export never engaged the ISR cache for it), so the origin reuses results itself (`src/lib/services/sitemap.service.ts`) across two bounded tiers. Tier 1 (memory): per-(origin, index) XML with the advertised 1 h TTL in a byte- and entry-bounded LRU (48 MiB / 64 entries — roughly six full shards; beyond that the least recently used are dropped). Tier 2 (disk): the same XML atomically published (tmp + rename) under a regenerable root (`.next/cache/sitemap-shards/<origin-hash>/`, relocatable via `SITEMAP_CACHE_DIR`), versioned filenames carrying the generation stamp, pruned by TTL / superseded versions / orphaned tmp files / a 64-file cap. Within the caps the full shard working set is reused across sequential sweeps — a shard evicted from memory is re-served from disk without re-querying; beyond the caps the oldest files are dropped and regenerate on next request. Concurrent cold requests coalesce onto one read-or-generate task whose in-flight record lasts until the disk publish (or its failure handling) completes — an L1 eviction before the first publish finishes joins the running task instead of duplicating the generation. At most 2 generation tasks run in parallel, each holding its slot across rows → memory store → atomic disk publish → bounded cleanup (released only after the publish ends; a failed publish keeps the stored memory result servable); generation streams 10k cursor-forward batches of the same `(createdAt desc, id desc)` skip/take window. The live-post count (same `deletedAt: null` rule) is shared with `robots.txt` behind a 5 s window that never blocks a cache hit: a fresh count range-gates the hit, a stale one triggers a backoff-limited background refresh while the valid XML is served, and count failures never discard cached results. Responses carry `Age` (seconds since generation — on cold responses computed after the awaited publish, so the write wait counts as consumed time) so downstream caches derive the REMAINING hour, not a fresh one; `x-sitemap-cache` reports `hit` (memory) / `disk` / `miss` / `empty`. Cache keys embed the `SiteConfig` origin, so an origin change never keeps serving the old domain.
  - Shard consistency semantics: each shard is an independently refreshed (1 h TTL) snapshot of the deterministic `(createdAt desc, id desc)` ordering. While posts are being created or deleted, shards generated at different moments may transiently overlap or miss rows near the boundary; they converge to an exact partition at rest. No zero-overlap/zero-omission claim is made during churn.
  - `/u/sitemap.xml` (newest 50,000 users by registration date) and `/cas/sitemap.xml` (top 50,000 registered chemicals by post count) are bounded, NOT exhaustive: entries beyond the cap appear in no sitemap until ranking shifts. Only the post sitemap covers all live posts (sharded).
  - Home and Explore feeds serve page 0 directly; deep cursors belong strictly to client-driven infinite pagination and are never SSR-injected into page 0 cache keys or rewritten. Feed diversity suppression by author is an anti-spam feed ranking mechanism distinct from SEO indexing.
- `prisma/schema.prisma` and committed migrations define data. The HTTP
  contract is recorded in `docs/API-BASELINE.md` and tested over real HTTP.
- `SiteConfig` row 1 owns public origin, name, short name, description,
  tagline, prefix for newly issued API keys, and optional `analyticsId` and `githubUrl`.
  `src/lib/site.ts` reads it with a one-hour cache. Site metadata,
  robots, sitemap, web manifest, sharing, visible wordmarks, analytics script, and agent discovery
  read that same identity. Changing the domain means changing this row and the deployment's
  DNS/TLS/proxy settings; application code has no domain fallback.
- **Unified Credential & Server-Side Dynamic Authorization:** API keys serve
  purely as identity credentials. A single key is used across both REST and
  MCP. Capabilities are derived dynamically on each request based on the
  account's active standing and current verification:
  - `active` + current `verified` (`verificationExpiresAt > now`): full read and programmatic write access.
  - `unverified`, `pending`, expired/revoked verification, or `restricted`: read-only access (403 on write endpoints and write tools).
  - `suspended`, revoked key, expired key, or non-existent user: identity denied (401).
  - Admin write operations additionally require the `admin` role and current verification.
  - Browser web sessions retain existing membership tiers (unverified members can post, like, and follow).
  - Explicit invalid Bearer credentials do not fall back to cookie sessions. Authentication hashes the full key without prefix-specific branching. Browser password changes strictly require a browser session.
- **Model Context Protocol (MCP):** cas.cool provides a formal `/mcp` route
  implemented with the official `@modelcontextprotocol/sdk`:
  - Transport: Stateless Streamable HTTP (`WebStandardStreamableHTTPServerTransport`) over `POST /mcp`. Fresh `McpServer` and transport instances are created per request.
  - Security & boundaries: Origin is validated against `SiteConfig.origin` (DNS-rebinding protection); requests are capped at 64KB body size; JSON-RPC batch arrays are rejected; Bearer auth is required (no cookie fallback).
  - Shared rate limiting: MCP requests consume from the exact same in-memory token bucket (`read` and `write` tiers) as REST endpoints using the same API key identifier (`key:<apiKeyId>`).
  - Dynamic tool exposure: Tool listings (`tools/list`) and execution (`tools/call`) dynamically reflect the caller's server-side capabilities (7 read tools + 5 write tools, total 12 tools). Write tools are completely hidden from unverified callers, and every tool execution re-validates server-side write authorization.
  - Official MCP annotations & schema integrity: Tools use official SDK `ToolAnnotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`), Zod schemas converted directly via `zodToInputSchema` with zero manual JSON Schema drift, and safe error masking (`Error ID: <uuid>`) protecting internal database and server details.
  - Discussion and attachment integrity: `get_post_discussion` provides bounded conversation trees; `edit_post` resolves image retention atomically within the post row lock (`images === undefined` preserves, `images === []` clears, array replaces).
- **Shared User Relationships & Follow Service:** Follow and unfollow operations
  are centralized in `src/lib/services/follow.service.ts` (`setUserFollow`).
  Both the REST endpoint (`/api/users/:username/follow`) and MCP tool (`set_follow`)
  delegate to this shared service, maintaining single-source idempotency,
  denormalized follower/following counters, self-follow prevention, and notification generation.
- An `@username` in post text is a passive link. Publishing does not query
  mentioned users or send mention notifications (the legacy unused `MENTION` enum has been removed).
  Only CAS numbers become structured chemical tags.
- **Browse state is owned by identity.** `BrowseStateProvider`
  (`src/components/posts/`) is mounted once at the app root inside
  `AuthProvider`: it owns the SWR cache backing every infinite list and a
  per-list scroll memory, alive across route changes so detail→back
  restores the loaded pages, cursors and visible position. The identity
  key (`currentUser?.id ?? 'anon'`) remounts the provider — logout, login
  or account switch drops the previous identity's data; no module-level
  cache exists. `SWRInfiniteSeed` seeds SSR pages into this cache
  only-if-absent, and only when the SSR page belongs to the selected tab.
  The active list and five most recent inactive lists are retained; older
  lists lose their SWR pages, cursor metadata and scroll position together
  and restart from SSR on revisit. A `useSWRInfinite` instance must never
  re-key: the home feed is keyed by tab and generic post lists by base path.
  SWR's stale-key revalidation pairing with a new fetcher
  otherwise writes one list's pages into another's cache entry.

## Feed performance

- Feed APIs use keyset cursors and fetch at most 50 posts per request.
  Denormalized interaction counts avoid per-card count queries.
- `src/lib/pagination.ts` normalizes timeline/search sizes to bounded
  integers and validates canonical calendar timestamps. Queries and cursor
  termination use the same normalized size; search binds its LIMIT as well
  as its text and cursor values.
- Following membership stays in PostgreSQL as an indexed relation predicate;
  the app does not load every followed user ID for each timeline request.
- The generic latest feed selects a bounded `(id, authorId, createdAt)`
  candidate window, then hydrates relations only for posts it returns.
- `postInclude` controls hydrated post shape and loads no product
  relations; compound tags are attached afterwards, one bounded statement
  per page (posts + quoted posts). Any new relation must be justified
  against the timeline's first-page cost and checked in both API and SSR
  call paths.
- Both timeline and generic post lists seed `useSWRInfinite` through the
  shared `SWRInfiniteSeed` into the identity-owned browse cache before
  children mount. A plain `SWRConfig.fallback` does not seed its page
  cache. Refresh affordances (pull indicator, new-posts banner) are fixed
  overlays — nothing in the feed may grow or shrink layout height in
  response to gestures or polling.
- Recommended ranking and author deduplication were measured at production
  scale on 2026-10-27 (`docs/FEED-PERF.md`): latest/following/detail hold
  ~13–19 ms p50; the ranked first page was the outlier at ~300 ms p50
  because the 30-day window scan read ~10k heap blocks per request. The
  partial covering index `Post_feedRank_cover_idx`
  (migration `20261027200000`) made the plan index-only — 70 ms p50 /
  100 ms p95. Re-measure with `scripts/perf/` before changing rank
  semantics; the local contract database validates correctness, not
  large-feed performance.

## Public SEO and discovery architecture

- **Canonical URLs:** Public detail routes (`/p/[code]`, `/u/[username]`, `/cas/[casNumber]`, `/explore`, `/about`) define explicit canonical URLs derived from `SiteConfig` row 1 (`alternates: { canonical: ... }`).
- **Tombstones:** Soft-deleted posts return HTTP 200 with cleared content and author info to preserve conversation context, reply chain stability, and client API contracts. Tombstones never emit `noindex`, `404`, or `410`. `SocialMediaPosting` JSON-LD is omitted for deleted posts so structured data never claims nonexistent body content.
- **Sharded and bounded sitemaps:**
  - `/sitemap.xml`: Static discovery pages (`/`, `/explore`, `/about` — redirecting `/search` is omitted).
  - `/p/sitemap/<n>.xml`: Active posts, sharded at 50,000 URLs per shard in `(createdAt desc, id desc)` order; every live post is covered across the shards. Shard routes never 404 for numeric indices (out-of-range = empty urlset); the origin reuses each generated shard for 1 h (in-process cache, see Discovery & Sitemaps above).
  - `/u/sitemap.xml`: Bounded to the 50,000 newest registered users — not exhaustive.
  - `/cas/sitemap.xml`: Bounded to the top 50,000 registered chemicals by post count without arbitrary exclusions — not exhaustive.
  - `/robots.txt`: Points crawlers to all sitemaps with concise crawl rules (`allow: /`, `disallow: /api/`), leaving private/personal route protection to server authentication.
- **Deployment & Proxy Topology:**
  - `ecosystem.config.cjs` uses relative paths (`__dirname`) and environment variables (`PM2_APP_NAME`, `PORT`) without hardcoded machine paths.
  - Reverse proxy (Nginx) forwards `X-Real-IP` and `X-Forwarded-For` to preserve the rate limiting trust boundary.
  - `/llms.txt` is dynamic (`src/app/llms.txt/route.ts`) reflecting the live database `SiteConfig`; it is not statically aliased in Nginx.

## Change rule

Make a direct migration to the intended schema and API contract. Keep no
runtime compatibility path for retired fields or behavior. Update data,
documentation and tests in the same change.
