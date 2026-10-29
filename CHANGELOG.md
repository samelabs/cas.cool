# Changelog

All notable changes to CAS.cool are documented here.
The open-source release is v1.0.0. The production site runs an iterative
version (1.1.x) where x increments with each deploy.

## [1.2.0] — 2026-10-29

- MCP server at `/mcp` (Streamable HTTP, JSON-RPC 2.0, official SDK
  transport): 12 agent tools — 7 read (`get_capabilities`, `list_posts`,
  `get_post`, `get_post_discussion`, `search_posts`, `get_chemical`,
  `get_profile`) and 5 write (`create_post`, `edit_post`, `delete_post`,
  `set_interaction`, `set_follow`) — registered per caller in
  `tools/list` according to server-side capability.
- API keys are unified identity credentials across REST and MCP. The
  `ApiKey.access` column is retired: capabilities derive dynamically from
  account standing (active + current verification → write; unverified or
  restricted → read-only; suspended → 401). Invalid Bearer credentials
  never fall back to a session cookie.
- Concurrency hardening in the shared service layer (applies to REST and
  MCP alike): the follow service locks both User rows in one canonical
  order (fixes P2034 deadlocks on mutual follow/unfollow); the chemical
  product write layer canonicalizes CAS ordering and takes per-CAS
  advisory admission locks before row locks (fixes opposed-order deadlocks
  and lost-create P2002 races on fresh CAS numbers across create, edit
  and delete).
- Pagination contracts closed: ancestor continuation is only via the
  HMAC-signed, target-bound opaque `nextAncestorCursor` (bare IDs and
  foreign tokens rejected on both REST and MCP, root posts included);
  `GET /api/notifications` validates its cursor and answers a standard
  400 for malformed input instead of 500.
- Side-effect outbox with SKIP LOCKED claims and persistent notification
  delivery records (dedupe by `eventKey`); executable report-resolution
  SQL.
- Ancestor chain pagination through soft-deleted boundary posts with
  independent ancestor/reply cursors; web post detail loads earlier
  context without losing scroll position.
- Dependency and toolchain: `@hono/node-server` 2.1.5, `brace-expansion`
  1.1.21/5.0.12, `browserslist` 4.29.5, `js-yaml` 4.3.2 (full
  `npm audit` and `npm audit --omit=dev` both report 0); Node engines
  narrowed to `^22.12.0 || ^24.0.0 || >=26.0.0` — the exact intersection
  with the ranges Prisma 7 and Vitest 5 actually support (Node 23 and 25
  are excluded).
- Quality gates: rate-limit tests rewritten as bounded true bursts with
  exact token-bucket math pinned by controlled-clock unit tests; the
  50k-sitemap boundary test carries an explicit per-test budget and
  verified fixture cleanup; migration test startup surfaces the schema
  engine's own diagnostics.

## [1.1.7] — 2026-08-29

- Fix: mobile menu drawer collapsed to header height — the sticky header's
  `backdrop-blur` makes it the containing block for fixed descendants, so the
  in-header overlay anchored to 53px instead of the viewport. The drawer now
  renders through a body-level portal; the layout spec (inset anchoring, no
  viewport units) is unchanged.
- i18n dictionary closed out: 160 dead keys removed (never wired — API routes
  return error copy inline, so `errors.*` duplicates were dead weight);
  3 hardcoded UI strings wired to existing keys (Who to Follow / Find more
  people / Legal name). Verified zero missing / zero dead keys by AST scan.
- README fix: `GET /api/posts` and `GET /api/posts/:code` are public
  (anonymous-IP rate-limited), not Bearer-only — matches actual behavior.
- Version bookkeeping: package.json resynced to the VERSION file (1.1.6 had
  shipped with package.json still at 1.1.5).

## [1.1.6] — 2026-08-29

- Layout system normalization: viewport-length units no longer pin any
  container height on mobile — chat pages anchor to the viewport
  (`fixed inset-0`) instead of measuring `100dvh`/`calc(100dvh - Npx)`;
  sidebars and the mobile drawer use boundary/anchored sizing
  (the drawer regression this introduced — fixed in 1.1.7 — was the
  overlay collapsing to header height on mobile)
- Message polling endpoint (`GET /api/messages/[id]`) for live incoming
  messages without websockets; read-gated (restricted accounts keep
  inbox access), soft-delete state races closed with optimistic locking
- Cursor-paginated post search (`GET /api/search`) with strict
  cursor whitelisting for the raw-SQL keyset predicate
- Security hardening: JSON-LD `<`/U+2028 escaping (stored XSS in
  post pages), per-IP anonymous rate-limit buckets (XFF last hop),
  GIF upload size cap, admin verification review pagination pushed
  down to the DB
- Orphaned-upload cleanup: replaced avatars/banners and images removed
  by post edits/deletes are deleted only when no row references them
- Unified modal a11y hook (focus trap, scroll lock, focus restore)
  shared by image viewer, share overlay, and report dialog
- README fix: direct messages are not end-to-end encrypted — claim removed

## [1.1.5] — 2026-08-04

- Disable Link prefetch across all layout components (Sidebar, MobileNav, MobileMenuDrawer, PageHeader, RightPanel) — reduces RSC prefetch requests by 60% on page refresh
- Enable SWR revalidation on InfinitePostList — profile, bookmarks, explore, and CAS pages now refresh their first page on revisit instead of being stuck on the SSR snapshot
- Remove dead `services/public-api/` build scripts from package.json
- Clean up `.env.example` — remove unused `PUBLIC_API_*` variables
- Update nginx reference config — remove legacy `/api/v1` proxy and Server Actions comments
- System font stack (removes 214 KB Google Fonts download)

## [1.1.4] — 2026-08-01

- Fix image upload: Server Action body size limit was 1MB (Next.js default), blocking uploads >1MB
- Fix layout shift: scrollbar-gutter: stable on main column

## [1.1.3] — 2026-08-01

- Fix layout shift: persistent header on all pages (desktop + mobile)
- Fix inconsistent content padding (px-6 → px-4 unified)
- Optimize About page copy: focus on features, mark as open-source

## [1.1.2] — 2026-08-01

- Add version display in footer (links to GitHub)
- Fix horizontal overflow breaking sticky headers
- Fix post detail z-index stacking issue

## [1.1.1] — 2026-08-01

- Fix: 404 pages no longer redirect to random posts
- Remove deprecated /[username] short-link route
- Clean up orphan redirect chain for removed URLs
