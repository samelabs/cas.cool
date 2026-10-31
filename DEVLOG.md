# DEVLOG

Chronological development log. Append new entries at the bottom — do not
rewrite history. Released-version history lives in `CHANGELOG.md`; this file
starts 2026-10-27 (the governance baseline batch). Entries before that date
were never kept — none are invented here.

---

### 2026-10-27 — Governance Phase 1: workspace & factual baseline

**Context:** Multi-phase governance program kicked off by the owner. Phase 1
mandate: reproducible toolchain (Node/npm/deps/env/migrations), git tracking
audit, and docs corrected against the actual code and Prisma schema — no
fabricated history. Deliverables land on `batch/phase1-fact-baseline`.

**Changes:**
- Toolchain verified end-to-end on a clean environment: `npm ci` →
  `prisma generate` → `npm run db:deploy` (fresh PostgreSQL 16, all 4
  migrations apply) → `lint` / `typecheck` / `build` all green.
- `package-lock.json`: 33 `resolved` URLs pointed at
  `mirrors.tencentyun.com` (unreachable outside that network, breaking
  `npm ci`). Rewritten to `registry.npmjs.org`; integrity hashes unchanged.
- `package.json`: added `typecheck`, `db:generate`, `db:deploy` scripts;
  declared `engines.node >= 22`; kept npm-11 `allowScripts` approvals
  (sharp, unrs-resolver) so install-script approval is reproducible.
- Lint baseline restored to zero: removed 9 unused imports/helpers
  (`bcrypt` in me/profile, `jsonError` in two admin routes, unused
  `request` arg, unused imports in posts/[code], upload, api-auth).
- `.env.example`: documented optional `DB_POOL_MAX` (used by `src/lib/db.ts`).
- `.gitignore`: stopped ignoring `AGENTS.md` / `DEVLOG.md` (they are now
  tracked, ending the local-rules-vs-repo-rules split that had already
  drifted); removed stale ignores for files that don't exist (`AGENT.md`,
  `AUDIT.md`, `scripts/migrate.py`). Removed `prisma/search_trgm_indexes.sql`
  (pre-migration manual script superseded by migration
  `20260710030000_trgm_search_indexes`; it still created an index on the
  since-dropped `Tag` table).
- Docs truth-sync against code: README (proxy.ts does page redirect only,
  not rate limiting; no React Compiler; i18n is an English dictionary
  baseline, not EN/ZH; image pipeline is server-side sharp, client canvas
  module no longer exists; GET post endpoints are public like the Chinese
  table said — English table fixed; API keys are single-tier full-access,
  scopes reserved not enforced; only /sitemap.xml is ISR; project structure
  now matches the tree; DB pool is driver-adapter based with DB_POOL_MAX).
  CONTRIBUTING (same structural fixes, Tag/Comment claims corrected, build
  requires DB). AGENTS.md (Tag model removed; Comment model gone; mutation
  guards are requireWrite/requireAuth from api-auth.ts; image module facts).
  `public/llms.txt` (key validation now points at auth-required
  `GET /api/account/api-keys` instead of "any endpoint's 200"; key
  validation wording aligned with code).
- Closeout corrections (owner review): AGENTS.md UI shim claims removed —
  `@/components/ui/icons` and `@/components/ui/FollowButton` do not exist
  and are imported by nothing; image rule rewritten (/api/upload processes
  bytes, /api/posts only links already-uploaded /uploads/ URLs); password
  change documented as re-issuing a session for the calling device — and
  its header's "session only" claim is NOT enforced in code (no
  auth-method guard; recorded as API-BASELINE constraint 9, product
  decision pending); llms.txt + API-BASELINE now warn that an invalid
  Bearer falls back to session auth, so keys must be validated without
  the browser cookie; list-pagination claims made exact (admin/reports has
  no pagination, messages/:id is fixed-50 polling, admin/verifications
  caps take at 100).
- New `docs/API-BASELINE.md`: full inventory of all 30 route files — auth
  guard, rate tier, response shapes, pagination, permission matrix, and 8
  recorded compatibility constraints/quirks (unscoped keys, unrate-limited
  DELETEs, create-by-id vs read-by-shortCode, page-based admin pagination,
  …) as the Phase-2+ contract baseline.
- New `DEVELOPMENT.md`: the verified standard flow (env vars, npm ci
  pitfalls incl. mirror URLs and npm ≥11.6 script approval, migrations,
  build-needs-DB, local bootstrap, deploy).

**Pitfalls / Notes:**
- `next build` fails without a reachable database: `/sitemap.xml`
  prerenders with a `prisma.user.findMany()`. Documented in
  DEVELOPMENT.md rather than changed — making the sitemap request-time is a
  caching-policy decision, not a Phase-1 call.
- `POST /api/me/password`'s header comment claims API-Key callers are
  rejected; the code has no such guard. Docs now state the real behavior —
  adding the guard is a Phase-2 product decision (API-BASELINE constraint 9).
- `prisma generate` also needs `DATABASE_URL` set (prisma.config.ts loads
  it at config-evaluation time), even though it never connects.
- npm 11.6+ blocks dependency install scripts by default; approvals are
  persisted in `package.json` `allowScripts` — keep that field updated when
  adding packages with install scripts.
- Rate-limit buckets are in-process memory: per-process and reset on
  restart (fine while the deployment is a single process).

---

### 2026-10-27 — Governance Phase 2, batch 1: behavior tests + migration-chain repair + DELETE rate-limit fix

**Context:** Phase 2 kicked off "tests first, then boundaries". The first
API contract test run immediately exposed a broken migration chain: the
User denormalized count columns and the ApiKey table exist in
prisma/schema.prisma but in NO committed migration — they had reached
production via an untracked `db push`. Any database built from the repo's
migrations alone 500s on the timeline (P2022: column `User.postCount` does
not exist). Delivered on `batch/phase2-api-boundary-tests` (not merged).

**Changes:**
- Test harness: vitest 5 (devDependency) with `test` / `test:unit` /
  `test:api` scripts; `@types/node` bumped ^20 → ^22 (vitest 5 requires
  ≥22; runtime engines already said ≥22). vitest runs files serially.
- Unit tests (23, `src/lib/*.test.ts`): token-bucket math + 429 shape
  (rate-limit), verification tiers (permissions), shortCode contract
  (8-char unambiguous alphabet, uniqueness), CAS/mention extraction +
  username sanitize + JSON-LD escaping (utils), API key generation
  (format / sha256 / uniqueness).
- API contract tests (17, `tests/api.contract.test.ts`): black-box HTTP
  against a real `next dev` (port 3199) + throwaway `cascool_test`
  database (name derived from DATABASE_URL by swapping the DB name — can
  never touch a real database; provisioned + migrated + dropped per run).
  Pins: identity model & error envelope, session login round-trip,
  invalid-Bearer-falls-back-to-cookie trap, unverified write gates, post
  lifecycle transactions (CAS linking, reply counters, like/repost
  idempotency + denormalized counts), ownership + 60-min edit window,
  soft delete, API key lifecycle, admin gate, search empty-result
  contract, take clamping, and DELETE rate limiting.
- **Migration-chain repair**: new idempotent migration
  `20261027130000_repair_schema_drift` adds `User.postCount /
  followerCount / followingCount` and the `ApiKey` table with
  `IF NOT EXISTS` semantics — a no-op on production (objects already
  exist; gets the chain recorded in `_prisma_migrations`) and a creator
  on migration-built databases. The `prisma migrate diff` suggestion to
  drop the `*_trgm_idx` / `idx_*trgm` GIN indexes is a Prisma artifact
  (raw-SQL indexes are not expressible in schema.prisma) — deliberately
  NOT applied.
- **DELETE rate-limit gap closed** (baseline constraint 2): write-tier
  `checkRateLimit` added to `DELETE /api/posts/:code`,
  `DELETE /api/posts/:code/:action`, `DELETE /api/account/api-keys/:id`.
  Compatibility: >60 writes/min per identity now yields 429 +
  Retry-After; documented in API-BASELINE + llms.txt.
- CI: `.github/workflows/ci.yml` (lint → typecheck → migrate → build →
  test against a postgres:16 service). Activates on the next push.
- Docs: DEVELOPMENT.md (tests section; fresh-DB note now says the 5-migration
  chain yields a *working* schema), API-BASELINE (DELETE tiers + resolved
  constraint), llms.txt (DELETEs count against the write bucket), AGENTS.md
  (toolchain test line).

**Pitfalls / Notes:**
- The Phase-1 claim "all migrations apply cleanly to an empty DB" was true
  but insufficient: applying cleanly ≠ usable schema. Fresh-DB checks must
  exercise a real query path — that is exactly what the contract tests now
  do (they would have caught this in Phase 1).
- Naive `TIMESTAMP(3)` columns + psql session timezone: seeding
  "2 hours ago" must use `timezone('utc', now())`, not bare `now()`
  (Asia/Shanghai offset wrote a *future* timestamp and silently passed the
  edit window open).
- Production deploy note: run `npm run db:deploy` — the repair migration
  is a no-op there by design, but it must land in `_prisma_migrations` to
  converge the chain.

---

### 2026-10-27 — Phase 2 batch 1 review: test database guard

**Context:** Review found that `TEST_DATABASE_URL` could override the derived
URL without matching `TEST_DB_NAME`, while provisioning drops the named test
database. The previous absolute safety claim was therefore unsupported.

**Changes:**
- `tests/helpers/env.ts` now requires a valid `_test` database name within
  PostgreSQL's 63-character identifier limit and an exact URL/name match,
  and rejects app/admin database name collisions before destructive setup.
- `DEVELOPMENT.md` describes the drop/recreate behavior and requires a
  dedicated local or CI database server. The repair migration comment and
  development guide now qualify the production no-op expectation.

**Pitfalls / Notes:**
- A database ending in `_test` is still destructively replaced by the test
  suite. Check the target server and name before running tests.
- The repair migration's production no-op expectation depends on the live
  schema matching the already-present objects; verify the live schema before
  deployment. This review did not connect to production.

---

### 2026-10-27 — Database site identity and explicit API key access

**Context:** The feed implementation mixed reusable timeline mechanics with
hardcoded site identity, while `ApiKey.scopes` did not enforce any access
level. Following feed requests also materialized the entire follow set in
Node before querying posts, and publishing queried mentioned users for
alerts even though CAS is the structured tag mechanism.

**Changes:**
- Added `ApiKeyAccess` (`read`, `read_write`) and migrated existing keys to
  `read_write` data. New key creation requires an explicit level; the API key
  page displays and selects it. The shared auth guard blocks writes from
  read-only keys, invalid Bearer credentials cannot use a session cookie,
  and password changes require a session.
- Added database-owned `SiteConfig` row 1 and a cached server reader. SEO,
  robots, sitemap, PWA manifest, sharing, primary brand display and
  `/llms.txt` now use that row. The new-key prefix also comes from the row;
  auth looks up the full key hash without a prefix branch. Removed the static
  manifest and agent guide. Renamed the browser cookie to neutral
  `feed_session` using a shared constant.
- Following feed queries use a PostgreSQL relation predicate rather than
  loading every followed author ID into the app process. The generic latest
  feed selects lightweight candidates before hydrating only returned posts.
- Publishing a post no longer resolves `@username` targets or sends mention
  alerts. CAS associations remain the structured chemical tags; passive
  profile links in text remain.
- Updated API contract tests, governance docs and architecture guidance.

**Pitfalls / Notes:**
- Updating `SiteConfig` can take up to one hour to appear because the cache
  interval matches sitemap ISR. DNS, TLS and proxy settings are outside the
  database and must be configured for a new domain.
- Existing API keys are data-migrated to `read_write`; there is no runtime
  interpretation of the retired `scopes` array.
- The cookie rename signs out existing browser sessions. Users sign in again;
  stored Session rows can be cleaned up after their normal expiry.
- The local contract database tests query correctness. Production-shaped
  `EXPLAIN (ANALYZE, BUFFERS)` and p50/p95 timings are still needed before
  tuning ranking or author deduplication further.

---

### 2026-10-27 — Feed performance & server-boundary batch (measure first)

**Context:** Governance batch: measure feed performance at production scale
before touching anything, converge the server boundary for post writes, and
audit landed key permissions + SiteConfig propagation. Baseline main
a72699a. Delivered on `batch/feed-perf-boundary` (not merged).

**Changes:**
- Measurement tooling committed: `scripts/perf/seed.mjs` (cascool_perf:
  792k live posts, 20k users, ~600k follows, zipf engagement, deterministic
  shortCodes; plain SQL, no app imports) and `scripts/perf/measure.mjs`
  (sequential p50/p95 per scenario, per-key rate buckets, RSS sampling,
  payload sizes). Evidence recorded in `docs/FEED-PERF.md`.
- Measured (production build + next start): latest 12.9ms p50, following
  16.2ms, detail 17.8ms, **for-you 297.5ms p50 / 734ms p95** — the outlier.
  15–16 SQL statements per feed request; RSS 34–65MB; ~21KB pages.
- EXPLAIN (ANALYZE, BUFFERS): for-you's 30-day window scan read 10,012 heap
  blocks (30,459 buffers cold, 1.7s cold SQL) to score 100k rows. Added
  partial covering index `Post_feedRank_cover_idx` (migration
  `20261027200000`) → index-only plan (677 buffers), **70ms p50 / 100ms
  p95 end-to-end (4.3× / 7.3×)**, 39MB at 792k posts. Latest/following/
  detail plans verified healthy (backward index scan + incremental sort;
  index-only follow EXISTS; unique shortCode lookup) — untouched.
- Server boundary: post create/edit/delete and like/bookmark/repost moved
  from route handlers into `src/lib/services/post.service.ts` (rules,
  transactions, counter updates, post-commit side effects; typed
  ServiceResult errors identical to the old inline codes/messages). The
  three routes are now HTTP shells (parse → auth → rate limit → service →
  respond). Semantics pinned by the 20 contract tests, all green.
- Robustness fix surfaced by measurement: a malformed compound cursor on
  GET /api/posts used to 500 with an empty body; now validated in the
  route → 400 bad_request. No compat branch.
- Permission matrix pinned by `tests/api.permissions.test.ts` (24 tests
  incl. site-config): a read key gets 403 "This API key is read-only." on
  all 15 write endpoints (7 admin mutations included); admin lists work
  with read keys; read_write admin key passes the gate; password change
  rejects BOTH key levels (session-only). GET side-effect audit: the only
  write reachable from a GET is `ApiKey.lastUsedAt` (caller-owned
  metadata, by design) — documented in API-BASELINE.
- SiteConfig propagation measured on a production build
  (`tests/site-config.test.ts` + manual probes): `/robots.txt`,
  `/manifest.webmanifest`, `/llms.txt`, `/sitemap.xml` are BAKED AT BUILD
  TIME — a row change does not reach them via restart or even an
  incremental rebuild; a cold rebuild with the row updated does.
  Domain switch procedure recorded: UPDATE row → npm run build → pm2
  restart (plus DNS/TLS/proxy). Runtime consumers (key prefix, dynamic
  metadata) lag ≤1h (unstable_cache 3600).
- Docs: FEED-PERF.md (all evidence + limitations), API-BASELINE (cursor
  400, api-keys access field, service layer, lastUsedAt, propagation),
  ARCHITECTURE (measured perf section, write-side boundary), DEVELOPMENT
  (perf tooling section).

**Pitfalls / Notes:**
- Measuring a `next start` server: `kill $!` kills the npx wrapper, NOT the
  `next-server` child — the port stays bound by a zombie and every later
  "restart/rebuild" probe silently hits the old process. Always
  `lsof -ti :PORT | xargs kill` and print the answering PID per probe.
- For-you's computed ORDER BY can't be indexed; the covering index removes
  the heap reads, not the scan. If the 30-day window grows 10×, re-measure
  before assuming this holds (window narrowing is an owner-level semantics
  decision).
- Production deploy: migration `20261027200000` uses CREATE INDEX
  CONCURRENTLY (same pattern as the trgm migration) — no table lock; the
  for-you improvement lands on the next deploy, no code coupling.
- Next 16 dev persists prerendered routes in `.next/dev` across boots, and
  `unstable_cache` data in `.next/cache` is shared between dev and
  production builds. Both leak stale SiteConfig identity into tests —
  `tests/helpers/server.ts` now clears both on every boot to keep the
  suite hermetic (this also explains why a rebrand needs a rebuild: see
  docs/FEED-PERF.md).

---

### 2026-10-28 — Feed batch review and cursor correction

**Context:** Review before local merge found a For You pagination regression
and two misleading operational claims in the batch.

**Changes:**
- Validate the cursor shape used by each feed path in `src/app/api/posts/route.ts`:
  For You's ranked first page and bookmarks emit an ISO timestamp, while
  chronological pages emit timestamp plus ID. Added a black-box regression
  test for the For You second-page form and malformed input.
- Restrict `scripts/perf/seed.mjs` to `_perf` database names and parameterize
  the session termination query. `scripts/perf/measure.mjs` now reads the
  selected performance database from `DATABASE_URL` and requires all keys.
- Corrected `docs/FEED-PERF.md`, `docs/API-BASELINE.md` and
  `DEVELOPMENT.md`: counter changes maintain index entries; a clean `.next`
  build avoids stale SiteConfig when switching immediately.
- The production build route table and Next.js metadata-route documentation
  corrected the batch's cache conclusion: robots, manifest and sitemap have
  1 h revalidation; llms.txt is dynamic. The earlier probes only covered
  the first hour after the row update. A database-only switch can propagate
  after revalidation; the first request after expiry may still be stale.

**Pitfalls / Notes:**
- The measured read improvement has an unmeasured write cost because
  interaction counters appear in the covering index. Re-measure write
  throughput before treating the index as free.
- The already applied index migration has an inaccurate comment saying
  counter changes update its entry in place. Its SQL file remains unchanged
  to preserve Prisma's recorded checksum; the corrected behavior is in
  `docs/FEED-PERF.md`.
- The chemical association code still lives in the shared post write
  service. Moving it behind a product boundary remains architecture work;
  this review does not claim the write service is chemically independent.

---

### 2026-10-28 — Chemistry product boundary, index write-cost pricing, SiteConfig revalidation window

**Context:** Governance batch from main 4b76dac (which merged the feed
batch with review corrections). Three mandates: pull chemical product
rules out of the generic post write service; price the covering index's
write cost with evidence; verify SiteConfig propagation PAST the 1-hour
revalidation window on a production build (the prior probes only covered
the first hour). Delivered on `batch/chem-boundary-write-cost` (not merged).

**Changes:**
- Chemistry product boundary: new `src/lib/chemistry/post-chemicals.ts`
  owns CAS validation/format, manual+auto-extract merge, Chemical upserts
  and postCount maintenance (create / edit-replace / delete-decrement),
  each running inside the caller's transaction with statement order
  identical to the previous inline code. `post.service.ts` keeps only the
  opaque `chemicals` relation wiring; the edit path preserves its
  historical no-trim filter. Unit tests (6) + contract tests (3) pin the
  merge rules and Chemical.postCount exactness across create/edit/delete.
- Write-cost benchmark (`scripts/perf/write-cost.mjs`): like/bookmark/reply/
  repost op+undo cycles at SQL level, 1500 per interaction, with vs
  without `Post_feedRank_cover_idx`. Result — counters in INCLUDE make
  every counter bump a non-HOT index update: WAL 17.5KB vs 4.5KB per cycle
  (4×), like/bookmark throughput -19…-42 %, but absolute cost ≤5 ms p50
  and ≥175 ops/s single-connection against a 60 writes/min per-identity
  API cap. Read side re-measured: for-you 91.8/107 ms (p50/p95) with the
  index restored — 3.2×+ inside the 287–297 ms no-index baseline.
  Decision: KEEP the index; monitor WAL volume if interaction rates grow
  orders of magnitude. Details in docs/FEED-PERF.md.
- SiteConfig propagation measured ACROSS the 1-hour window (production
  build, row flipped at T0, one probe per surface every 3 min for 84 min,
  no restart/rebuild): every surface kept the OLD identity through T+69,
  and robots/manifest/llms.txt/sitemap/dynamic-home all flipped together
  at T+72. Model: unstable_cache(1h) + static-route hourly revalidation +
  stale-while-revalidate; ~1h10m under continuous traffic, up to ~2h when
  idle. This confirms the review batch's correction and retires the first
  batch's "baked forever" conclusion (those probes never crossed the
  window). Switch procedures recorded in FEED-PERF/DEVELOPMENT: planned =
  row update + clean rebuild + restart (immediate); database-only works
  but serves the old domain ~1–2h.
- Measurement hygiene: long-running probes must kill the port owner
  (`lsof -ti :PORT`), not the npx wrapper (zombie-server confound from the
  previous batch), and must never run `next build` or vitest against the
  same `.next` mid-experiment — both rewrite/clear the shared disk caches
  the experiment is measuring.

---

### 2026-10-28 — Review of chemistry and write-cost batch

**Context:** Pre-merge review found an unsafe benchmark target option and
claims that exceeded what the single-machine measurements established.

**Changes:**
- Moved the edit path's no-trim CAS filter into
  `src/lib/chemistry/post-chemicals.ts` and pinned that behavior with a
  focused unit test. The generic post service no longer imports CAS format
  validation directly.
- `scripts/perf/write-cost.mjs` now rejects names outside `_perf`, limits
  cycle count and verifies the seed marker before cleanup or writes.
- Corrected FEED-PERF and DEVELOPMENT: the 72-minute SiteConfig flip was
  observed under three-minute probes, while an idle site's request-driven
  revalidation has no fixed upper bound. Relation page growth does not
  support a precise byte-per-interaction figure; API limits per identity
  do not bound aggregate database writes.
- Fixed the edit response to read the final post inside the same transaction
  after chemical replacement. Previously PATCH could return the old
  `chemicals` relation even though the database update succeeded; the API
  contract now asserts the returned list.

**Pitfalls / Notes:**
- The observed WAL multiplier is from one local sequential benchmark; use
  aggregate write traffic and WAL monitoring when sizing production.
- The post write service still calls the chemical product module to wire
  Prisma relations in one transaction. Further separation requires a
  deliberate product integration boundary, not a runtime compatibility path.

---

### 2026-10-28 — Module-boundary closure + mobile feed measurement (duplicate-fetch fix)

**Context:** Governance batch from main 260c3b9. Two mandates: close the
module dependency graph so timeline reads and generic interactions never
load the chemistry product module; measure the mobile feed on a production
build and fix only evidence-pointed bottlenecks. Delivered on
`batch/module-boundary-mobile-perf` (not merged).

**Changes:**
- Call graph mapped first: all 7 timeline pages + the 3 post routes imported
  one `post.service.ts` that also contained writes and the chemistry import
  — every feed read transitively loaded the product layer. Minimal split,
  no framework: reads stay in `post.service.ts` (+ shared ServiceError/
  PostActor types), writes (create/edit/delete, chemistry-aware) moved to
  `post-write.service.ts`, generic interactions moved to
  `interaction.service.ts`. Route imports updated; single-transaction write
  semantics and all API behavior unchanged (contract suite 24/24 before and
  after). The import closure is pinned by `tests/module-boundary.test.ts`
  (reads/interactions/feed must not import chemistry; the write service must).
- Mobile feed measured on `next start` + cascool_perf at 390×844 (embedded
  browser) + curl: home TTFB p50 23.7 ms / p95 38.5 ms, HTML 17 KB
  compressed, 20 posts fully SSR, **CLS 0** (no shifts, no long tasks
  during scroll), client JS 191 KB transferred / 626 KB decoded on cold
  first visit. Full table in docs/FEED-PERF.md.
- Bottleneck found and fixed: every pageview re-fetched page 1 (21.7 KB +
  1 API roundtrip) right after hydration. Root cause in SWR 2.4.1 source —
  `useSWRInfinite` never reads `SWRConfig.fallback` (the TimelineFeed SSR
  seeding was dead code), so page 0 counted as uncached. Fix: pre-seed the
  SWRConfig **provider** cache (`Map` with the SSR page). Verified after
  rebuild: exactly one API call on load (the 60 s new-posts poll), 20 posts
  from SSR, CLS still 0; the SSR nextCursor now feeds pagination
  immediately instead of only after the redundant fetch.
- Measurement limitations recorded: this webview's IntersectionObserver
  never fires (zero callbacks for a fully visible element), so infinite
  scroll / pull-to-refresh are unverifiable here and were not changed;
  engine FCP/LCP unavailable — navigation timing + CLS used as proxies.
- Docs: FEED-PERF mobile section, ARCHITECTURE (three-way post-domain split
  + module-boundary test), DEVLOG.

**Pitfalls / Notes:**
- SWR lesson worth keeping: `SWRConfig fallback` works for `useSWR`, is
  IGNORED by `useSWRInfinite` (both fetch loop and page assembly read the
  provider cache only). Seeding via the provider is the correct SSR handoff.
- The provider map is per-`SWRConfig` mount: pages 2+ are not preserved
  across full remounts — same behavior as the previous (broken) fallback
  seeding; revisit only with evidence that back-navigation reloads hurt.
- Embedded webview is not a browser-metrics oracle: IO-dead means
  scroll-triggered UI needs a real-device spot check.

---

### 2026-10-28 — Review: shared infinite cache seed and database wordmark

**Context:** Pre-merge review found that the same SWR fallback pattern still
affected generic post lists, and three visible wordmarks bypassed SiteConfig.

**Changes:**
- Added `SWRInfiniteSeed` and used it from both TimelineFeed and
  InfinitePostList. The wrapper seeds the first page in the cache provider
  before `useSWRInfinite` mounts. A server-render test checks that children
  can read the seeded page and cursor. The generic-list browser latency was
  not re-measured; the home timeline's measurement remains the direct result.
- Added `BrandWordmark`, reading `useSite()` from the database-backed site
  context; homepage, desktop sidebar, mobile drawer and auth layout now use it. A site
  config HTTP test checks the visible home header after a row change and
  cache reset.
- Strengthened the module-boundary test to traverse local TypeScript imports,
  so an indirect path from read or interaction modules to chemistry fails.

**Pitfalls / Notes:**
- The SWR provider is local to each mounted list. It prevents the duplicate
  first-page fetch but does not preserve later pages across full remounts.
  Interaction-state updates across separately mounted lists need a real
  navigation check before claiming cache persistence.
- The embedded webview's IntersectionObserver limitation still prevents an
  end-to-end infinite-scroll check in that environment.

---

### 2026-10-28 — Mobile feed verified on real WebKit + Chromium; back-navigation tree bug fixed

**Context:** Governance batch from main dbebe07: verify the home / CAS /
profile feeds on real mobile Safari and Chrome — pagination, tab switching,
pull-to-refresh, post & interaction updates, detail→back — recording
requests, cursors, visible content and layout shifts, with the local SWR
cache's cross-navigation behavior as the focus. Fix only reproduced issues.
Delivered on `batch/mobile-safari-chrome-verify`.

**Changes:**
- Added `scripts/mobile-verify/engines.mjs` and `tls-proxy.mjs` for
  repeatable two-engine verification over local TLS.
- Preserved `window.history.state` in TimelineFeed's tab URL sync and pinned
  the rule in `tests/module-boundary.test.ts`; the browser harness also
  asserts that Back renders the home feed tree.
- Included `.test.tsx` files in Vitest and corrected the SWR seed test's JSX
  children usage.
- Recorded browser findings and measurement limits in `docs/FEED-PERF.md`.

**Verification setup:** iOS-Simulator Mobile Safari via safaridriver is
blocked by the host Safari "Allow remote automation" gate (interactive-only
authorization) — recorded as an environment limitation. The verification
ran on real ENGINES instead: Playwright WebKit 27.2 (Safari's engine) and
Chromium, iPhone-13 descriptor (touch, 390×844). Production builds set the
session cookie Secure, which engines refuse over plain http://127.0.0.1 —
added `scripts/mobile-verify/tls-proxy.mjs` (self-signed TLS terminator,
mirroring the nginx-TLS production topology) and ran everything over
https://127.0.0.1:8443. Harness: `scripts/mobile-verify/engines.mjs`.

**Verified working (both engines):** home 20 SSR posts with exactly ONE
API call (the 60 s poll — SWRInfiniteSeed fix holds); scroll pagination
20→100 posts with four correct compound cursors; CAS page SSR + `cas=`
cursor pagination (2 KB additional JS transferred in the warm session);
profile SSR + Replies tab via
scope=replies; login over TLS → feed tabs; tab round-trip refetches page 1
(SWR revalidateFirstPage freshness, by design); compose POST 201 → prepend
without refetch (Chromium instant, WebKit ≤1.5 s); like toggles
aria-pressed. Chromium-only checks: CDP touch pull-to-refresh fires the
since&take=50 request (pull indicator CLS 0.061); the new-posts banner
appears 59.2 s after an out-of-band post (60 s poll) and click-prepends
20→21. Chromium CLS 0 elsewhere. This WebKit build cannot report CLS or
long tasks because it lacks the required PerformanceObserver entry types;
the harness now reports these as unavailable.

**Bug reproduced and fixed — back-navigation rendered the wrong tree:**
home → post detail → browser BACK left the page at `/` still rendering the
DETAIL component tree (one post, no feed tabs), zero network activity, no
self-healing; clicking Home recovered. Reproduced on WebKit and Chromium.
Discriminating experiments: direct-URL entry + back navigated correctly
(with a proper '/' refetch), proving the cache itself was fine. Root cause
was app-side: TimelineFeed's tab-URL sync called
`history.replaceState(null, '', url)` on every mount, wiping Next.js's
router bookkeeping from the home history entry — the popstate then carried
no Next state, the router ignored it, and the previous tree stayed
mounted. Fix: pass `window.history.state` through (one line). Verified on
both engines: back now renders the home feed with Next state intact.
Regression pinned in tests/module-boundary.test.ts (TimelineFeed must pass
history.state; no client component may call replaceState(null)).

**Known-and-documented, not changed:** loaded pages 2+ do not survive the
home remount on back (per-mount SWRInfiniteSeed provider — dbebe07 review
note); a cache that outlives remounts is a cross-user data-leak design
decision. Tab switch back to Latest refetches page 1 by design.

**Pitfalls / Notes:**
- `history.replaceState(null, …)` in any client component destroys Next's
  router state for that history entry. The rule is now source-pinned for
  every client file.
- Testing a production build locally REQUIRES TLS (Secure session cookie):
  keep `tls-proxy.mjs` handy; plain-HTTP local verification silently
  degrades to anonymous sessions.
- The embedded webview's dead IntersectionObserver is an environment
  limitation; pagination worked in both browser engines. WebKit's missing
  layout-shift and longtask observers also mean zero cannot be inferred
  from an empty event list.

### 2026-10-28 — Feed core / chemical product layer split

**Context:** The generic feed had absorbed the product: `feed.ts` carried a
`casNumber` filter, `postInclude` loaded `chemicals` on every read,
`post-write.service.ts` interleaved CAS rules with the generic lifecycle,
and admin report-resolution owned a second `Chemical.postCount` delete path
(with per-CAS decrements) that could drift from the author delete.

**Changes:**
- New internal contract: `CorePost` (product-free projection, what
  `serializePost` returns) vs `SafePost` (CorePost + `chemicals`), assembled
  only at the application layer. `postInclude` no longer loads the
  Chemical relation.
- `FeedFilter.casNumber` removed; `getFeed` accepts an opaque
  `postWhere?: Prisma.PostWhereInput` applied in SQL before keyset
  pagination. The chemistry layer supplies `chemicalPostWhere(cas)` via
  `src/lib/chemistry/post-feed.ts`.
- `src/lib/chemistry/post-views.ts`: `attachPostChemicals` attaches tags
  for a whole page (posts + quoted posts) in one bounded statement.
- Core extracted: `post-core.service.ts` (reads) and
  `post-core-write.service.ts` (create/edit/soft-delete transaction steps).
  `post.service.ts` / `post-write.service.ts` are now application
  composition; each operation is ONE transaction combining core steps with
  chemistry rules. `adjustChemicalPostCounts` is a single bulk UPDATE.
- Moderation delete: `deleteReportedPost(postId)` in
  `post-write.service.ts`; the admin resolve route's inline delete block is
  gone. Author/admin/moderation share the guarded, idempotent delete
  transaction (no second counting implementation).
- `search.service.ts` attaches tags through the same helper;
  `/api/posts/[code]` GET reads through the application service;
  `interaction.service.ts` imports shared types from the core (it must not
  transitively load chemistry).
- Tests: module-boundary now pins core modules chemistry-free (imports AND
  identifiers) and moderation reuse; api.contract adds CAS keyset
  pagination (no dup/skip, tags retained) and moderation-delete
  idempotency.

**Pitfalls / Notes:**
- `interaction.service.ts` must import shared service types from
  `post-core.service.ts`, not `post.service.ts` — the latter is
  application composition and loads chemistry.
- The delete transaction reads the post's current CAS association inside
  the transaction (after the guarded tombstone update wins) because
  `postInclude` no longer carries it.
- SQL-count evidence (seeded probe DB, 28 posts / 5 authors, identical
  harness on main and branch): reads identical and bounded on both sides
  (latest 13, following 12, foryou 13, CAS 12, detail 12 statements; no
  per-post queries either side — after the split the Chemical table is
  touched by exactly one batched attach per page); writes: edit 41→29
  statements (no in-transaction full re-read), delete 10→12 (association
  read moved into the tx), create 26→27 (relation connect as its own
  statement when CAS present). Numbers are acceptance evidence for this
  refactor, not a general benchmark.

### 2026-10-28 — Feed core split review: atomic response and explicit CAS filtering

**Context:** The new product projection was initially read after create/edit
committed; a failed read could make a successful write appear to fail. The API
also accepted CAS combined with modes that silently ignored its predicate.

**Changes:**
- `post-views.ts` accepts the transaction client. Create/edit assemble their
  final `SafePost` before commit, preserving response/write atomicity.
- `GET /api/posts` returns 400 for unsupported CAS combinations, and the
  `FeedQuery` type only permits product predicates on chronological selection.
- Contract tests cover quoted-post CAS tags and rejected CAS combinations.
  Architecture/API docs and route comments now describe the actual layers;
  stale write-auth labels and a stale SiteConfig test comment were corrected.

**Pitfalls / Notes:**
- Ranked For You first-page SQL does not accept arbitrary product predicates;
  callers must not pass `postWhere` into that sort and expect a filtered list.
- The extra product read stays one bounded query per response, now inside
  create/edit transactions. Recheck write latency if this path changes.

### 2026-10-28 — Browse-state lifecycle: identity-owned feed cache

**Context:** Scrolling to page 2+ and opening a post detail, then going
back, landed on the first page with the scroll position lost — every
infinite list mounted its own SWR cache provider (`SWRInfiniteSeed`
created a fresh Map per mount), so pages/cursors/size died with the
remount. Promoting a cache to global state would let identities read each
other's lists.

**Changes:**
- `BrowseStateProvider` (new, `src/components/posts/`): mounted once at
  the app root inside `AuthProvider`. Owns the SWR cache + a per-list
  scroll memory for the current identity (`currentUser?.id ?? 'anon'`);
  the key remounts the provider on logout/login/account switch, dropping
  the previous identity's data. All state is per-instance — no
  module-level cache.
- `SWRInfiniteSeed`: no longer creates a provider; it seeds the SSR page
  into the ambient browse cache ONLY when the key is absent (on
  back-navigation the cached pages are newer than the SSR snapshot).
  Without a provider above it warns in dev instead of writing to SWR's
  module-global default cache (which would leak across SSR requests).
- `useBrowseScroll(key, contentTick)`: saves window.scrollY per list key
  (rAF-throttled, final save on unmount), consumes the memory per key on
  mount and restores once the document is tall enough — with the
  persistent cache the pages render synchronously, so this applies in the
  first post-mount commit. Wired into TimelineFeed (`home:<tab>`) and
  InfinitePostList (`basePath`).
- `TimelineFeed`: adopts the URL's `?tab=` in the first-render state
  initializer (back-navigation replays Next's router cache, which holds
  the SSR-time tree) and mounts the inner feed **keyed by tab**.
- Pull-to-refresh indicator and new-posts banner became fixed overlays
  (rotation/opacity/translateY feedback, zero layout impact).

**Root causes found on the way (both reproduced WebKit + Chromium):**
- Back landed on the wrong tab: Next's router cache replayed the stale
  SSR tree; the user's tab lived only in the URL.
- Cross-tab cache corruption: re-keying ONE `useSWRInfinite` across tabs
  let SWR pair a stale-key `revalidate` closure with the current-render
  fetcher (`fetcherRef.current` read fresh in the closure), writing
  Following's 4 pages into the Latest cache entry — Latest then rendered
  Following's list. Traced with a patched `cache.set` in the browser.
  Instance-per-tab keying removes the re-key class entirely.

**Verification** (`scripts/mobile-verify/browse-state.mjs`, production
build via tls-proxy, WebKit + Chromium, all checks passed):
- 4 pages (80 posts) → detail → back: 80/80 cards, identical cursor
  chain, scroll restored exactly (6000 px), 0–1 list requests (no storm).
- Latest ⇄ Following distinct + cached; publish prepends; like toggles.
- In-place identity switch: first page only, scroll 0 — previous
  identity's pages and position gone.
- CLS incl. pull-to-refresh (Chromium): 0.0000 — was 0.061 (in-flow pull
  indicator growing height). The gesture still fires the real refresh.

**Pitfalls / Notes:**
- Never re-key a `useSWRInfinite` instance (pinned by tests: TimelineFeed
  keys its inner feed by tab).
- The scroll memory must be consumed per key BEFORE the save effect's
  initial write can overwrite it; a pending restore is dropped when the
  key changes (tab adoption / switch).
- Production-build browser testing needs `scripts/mobile-verify/
  tls-proxy.mjs` — WebKit refuses the Secure session cookie over plain
  HTTP (Chromium tolerates 127.0.0.1, WebKit does not).
- In-memory browse state covers the tab session; a hard reload starts
  fresh by design (sessionStorage would outlive reloads — deliberately
  not used).

### 2026-10-28 — Browse-state provenance and bounded lifetime

**Context:** Review found that URL-tab adoption could pair Following's
cache key with a replayed Latest SSR snapshot on a cache miss. The new
identity-owned cache also retained every visited list indefinitely, which
would turn back-navigation state into a mobile memory liability.

**Changes:**
- `TimelineFeed` uses SSR posts/cursor only for the tab that produced them;
  a mismatched URL tab waits for its own cache or fetch. The production
  browser harness delays Following, navigates away and back, then checks
  tab content before and after the response on WebKit and Chromium.
- `BrowseStateProvider` retains mounted post lists and five recently closed
  lists. Eviction removes a list's first page, cursor pages, SWR infinite
  metadata and scroll position together. Unit tests cover recency, active
  consumers and 30 distinct profile/CAS list keys.
- `InfinitePostListInner` is keyed by base path so generic infinite lists
  cannot re-key one SWR instance across profile/CAS/search navigation;
  WebKit and Chromium profile-tab smoke checks retain the correct content.
- `docs/ARCHITECTURE.md` and `docs/FEED-PERF.md` record the lifecycle and
  cold-start comparison with `main`.

**Pitfalls / Notes:**
- A router-replayed SSR page belongs to `initialTab`, regardless of the
  live URL. Never seed or render that page under a different tab key.
- The five-list bound applies to post-list browse state; unrelated SWR
  entries remain under their own hooks. Evicted lists restart from SSR and
  top on revisit. Whole-app heap includes Next/React state and may still
  change across route navigation.
- Local cold-load samples show about-route JS transfer +6.3 KB from the
  root SWR provider but overlapping first-content/first-action ranges;
  they do not settle the broader frontend startup governance task.

---

### 2026-10-28 — Correctness fixes: latest feed cursor, atomic report resolve, and parameterized search cursor

**Context:** Governance step 2: address three verified correctness exposures with failure reproductions, contract tests, and robust implementations on the main line.

**Changes:**
- `src/lib/feed.ts`: Fixed latest feed deduplication pagination. Previously, when candidate count was less than the internal window (`candidates.length < fetchSize`), the function erroneously returned `nextCursor: null`, permanently cutting off subsequent pages. Now checks if unconsumed candidates remain (`lastIndex < candidates.length - 1` or `candidates.length === fetchSize`) and returns the keyset cursor for the last emitted item.
- `src/lib/services/post-write.service.ts` & `src/app/api/admin/reports/[id]/resolve/route.ts`: Soft deletion of reported posts, user suspension, and report status transition are now executed in a single atomic database transaction (`prisma.$transaction`). Replays of already-resolved reports safely return 400 without re-executing penalties or re-decrementing CAS counters. Notifications and image cleanup are deferred strictly until post-commit.
- `src/lib/services/search.service.ts`: Replaced raw SQL string interpolation of cursor values (`'${cursorDate}'::timestamptz`, `'${cursorId}'`) with bound parameterized SQL (`$2::timestamptz AT TIME ZONE 'UTC'`, `$3`). Converted timestamp to UTC naive timestamp to prevent session timezone offset corruption on PostgreSQL. Preserved trgm query structure and limit clamping.
- `tests/api.contract.test.ts`: Added reproduction contract tests for candidate-count < window latest pagination, replay-safe admin report resolution with atomic rollback on admin target, and parameterized search multi-page pagination.
- `tests/module-boundary.test.ts`: Added assertion verifying search service contains no SQL string interpolation for cursors.

**Pitfalls / Notes:**
- Naive `TIMESTAMP(3)` columns in PostgreSQL (`"Post"."createdAt"`) must be converted to UTC naive timestamp via `($2::timestamptz AT TIME ZONE 'UTC', $3)` when parsing ISO UTC strings in parameterized SQL; otherwise Postgres converts the naive column using local session timezone, causing comparison offsets.

---

### 2026-10-28 — Governance closure: frontend audit, SEO convergence, and configuration hygiene

**Context:** Governance steps 3, 4, 5: timed frontend architectural audit, public SEO and tombstone contract convergence, configuration secret/topology hygiene, and release gating.

**Changes:**
- **Frontend Architecture Audit:** Traced dependency graph and state lifecycle from Root layout (`layout.tsx`) → Providers (`Providers.tsx`) → SSR first screen (`page.tsx`) → Client takeover (`TimelineFeed.tsx` / `SWRInfiniteSeed.tsx`) → Keyset pagination / Back navigation / Identity switch. Verified that the perceived "heavy shell" is not caused by code boundary bugs or layout re-rendering shifts (CLS remains 0.0000; SSR delivers 20 full post cards in initial HTML; SWRInfiniteSeed eliminates duplicate page 0 fetch; provider trees do not remount on route navigation). In accordance with the "evidence-first" rule, avoided speculative component rewrites.
- **Canonical URLs & Discovery:** Added explicit canonical URLs (`alternates: { canonical: ... }`) across active post details (`/p/[code]`), explore (`/explore`), and about (`/about`) matching existing CAS (`/cas/[cas]`) and profile (`/u/[username]`) standards.
- **Tombstone Contracts & JSON-LD:** Maintained 200 HTTP tombstone status, wiped content, reply chain stability, and API contract invariants for soft-deleted posts without adding `noindex`, `404`, or `410`. Corrected stale comments that erroneously suggested search engines naturally index tombstones. Guarded post detail structured data (`jsonLdScript`) so that soft-deleted posts never emit `SocialMediaPosting` claiming valid headline or body content.
- **Sharded Bounded Sitemap:** Converted monolithic sitemap into bounded, sharded segment sitemaps: `/sitemap.xml` (root static pages `/`, `/explore`, `/about`), `/p/sitemap.xml` (bounded active posts, excluding tombstones), `/u/sitemap.xml` (bounded active public users), and `/cas/sitemap.xml` (bounded chemical community pages). Removed 302-redirecting `/search` from sitemap. Updated `/robots.txt` to point to all sitemap shards.
- **Configuration & Secret Hygiene:** Removed online PM2 process names, port numbers, RAM constraints, and restart commands from `AGENTS.md`. Updated `ecosystem.config.cjs` to use relative directory paths (`__dirname`) instead of hardcoded `/var/www/cas.cool`. Created `deploy/nginx.conf.template` and `deploy/README.md` with environment placeholders. Corrected Nginx configuration drift where `/llms.txt` was statically aliased, ensuring dynamic requests proxy cleanly to Next.js while preserving client IP forwarding (`X-Real-IP`, `X-Forwarded-For`) for rate limiting.
- **Release Gating:** Ran full gating checks: ESLint (0 errors), TypeScript `tsc --noEmit` (0 errors), Vitest unit and contract tests (12 suites, 111 tests passing), Next.js production build (`next build` 45/45 static pages prerendered).

**Pitfalls / Notes:**
- Next.js segment sitemaps (`src/app/(shell)/p/sitemap.ts`) generate distinct `/p/sitemap.xml` files alongside the root `/sitemap.xml` without triggering metadata route collisions.
- `/llms.txt` must never be statically aliased in reverse proxies as it reads dynamic database `SiteConfig` values on demand.

---

### 2026-10-28 — cascool RC Correction: Information flow model, permissions, and configuration closure

**Context:** Complete the final governance convergence by fixing known model and permission gaps across bookmark ownership, repost dual-record lifecycle, post view atomicity, admin report preemption, latest feed cursor consumption boundary, bookmark compound pagination, crawler discovery links, SiteConfig decoupling, and legacy MENTION enum cleanup.

**Changes:**
- **Bookmark Ownership & Following Privacy:**
  - `src/app/api/posts/route.ts` & `src/lib/services/post-core.service.ts`: Enforce strict ownership on `bookmarkedBy` (anonymous 401, cross-account 403, owner 200 via session cookie or read API key) in both route and service layers. Enforce anonymous 401 on `tab=following`.
- **Repost Dual Record & Lifecycle:**
  - `prisma/schema.prisma` & migration `20261028170000_governance_rc_schema_fixes`: Added `repostPostId` (`@unique`, foreign key to `Post.id` onDelete SetNull) to `Repost` model, linking pure repost rows directly to the generated empty quote `Post`. Backfilled existing records.
  - `src/lib/services/interaction.service.ts`: On repost creation, atomically creates empty quote post, creates `Repost` row linked via `repostPostId`, increments original `repostCount` and reposter `postCount`. On undo repost, if the generated repost post has replies, it is soft-deleted as a 200 tombstone (preserving conversation context without cascade loss); if 0 replies, it is deleted.
  - `src/lib/services/post-write.service.ts`: Author and admin delete operations (`softDeleteProductPost`) check for linked `Repost` via `repostPostId` and automatically delete the `Repost` row and decrement original post `repostCount`. Editing pure reposts is rejected with 400 Bad Request.
- **PostView Atomic Deduplication:**
  - `src/app/api/posts/[code]/view/route.ts`: Swapped independent insert and increment into a single `prisma.$transaction`. Authenticated requests execute conflict-ignoring `postView.createMany` with `skipDuplicates: true`; only newly inserted records increment `Post.views`. Any failure rolls back the deduplication row and returns HTTP 500, preventing false 200s and allowing safe retries.
- **Admin Report Preemptive Claim:**
  - `src/app/api/admin/reports/[id]/resolve/route.ts`: Preemptively updates `Report.status = RESOLVED` before applying penalties. If preemption fails (report already handled or missing), returns 400/404 with 0 prior writes. If any penalty fails (e.g. attempting to suspend admin), the entire transaction rolls back via custom error throw. Replays return 400.
- **Latest Feed Consumption Boundary & Bookmark Composite Keyset:**
  - `src/lib/feed.ts`: Rewrote `dedupedByAuthorPage` so candidate consumption boundary strictly corresponds to candidate order (`createdAt desc, id desc`). When backfilling duplicates, candidate order is strictly maintained. The keyset cursor points to the last candidate evaluated in this window, ensuring next page never repeats previously displayed posts.
  - `src/lib/feed.ts` & `src/app/api/posts/route.ts`: Converted bookmark pagination to composite keyset cursor `(Bookmark.createdAt, Bookmark.id)` with composite ordering, preventing omissions for bookmarks sharing identical timestamps.
- **SEO, Discovery & Banned Chemicals:**
  - `src/app/(shell)/cas/sitemap.ts`: Filtered out chemicals where `banned: true`.
  - `src/app/(shell)/page.tsx` & `src/app/(shell)/explore/page.tsx`: Added server-rendered crawler `<Link rel="next" className="sr-only">` pagination links to public timeline and explore views, enabling search engines to discover all active posts beyond initial sitemaps.
- **SiteConfig Decoupling & Configuration Hygiene:**
  - Added optional `analyticsId` and `githubUrl` to `SiteConfig` model, populated in migration backfill. Decoupled `Analytics.tsx` and `RightPanel.tsx` from hardcoded site analytics IDs and GitHub repo URLs.
  - Sanitized tracked `deploy/cas.cool.nginx.conf` of private machine directories and certificate paths. Cleaned `README.md` and `docs/FEED-PERF.md` of machine-specific RAM and topology details.
- **Legacy MENTION Enum Cleanup:**
  - Removed unused `MENTION` enum value from `NotificationType` in PostgreSQL via migration, deleted dead `case 'MENTION':` UI branch, and updated types and i18n dictionaries.
- **Verification Gating:**
  - Extended `tests/api.contract.test.ts` to 39 comprehensive contract tests covering all new invariants. Full test suite (12 suites, 120 tests), `npm run lint` (0 errors), `npm run typecheck` (0 errors), and `npm run build` (45/45 static pages prerendered) all passed.

**Pitfalls / Notes:**
- Query parameter validation for illegal combinations (e.g. `cas` with `bookmarkedBy`) must precede authentication gates so malformed requests consistently yield 400 Bad Request regardless of auth state.
- In Next.js App Router, segment sitemaps like `src/app/(shell)/p/sitemap.ts` must export a default async function returning `MetadataRoute.Sitemap` rather than `generateSitemaps` to correctly serve `/p/sitemap.xml` directly.

---

### 2026-10-28 — cascool Final RC Governance: Repost cascade preservation, sitemap sharding, and fault resilience

**Context:** Address the final batch of RC corrections: preserve quoting posts when un-reposting via soft-delete tombstones; enforce non-nullable `Repost.repostPostId` database constraint with complete backfill; revert crawler deep cursor injection from HomePage/Explore cache keys; partition post sitemaps with Next.js 16 `generateSitemaps` id Promise contract and dynamic `robots.txt` listing; guard admin report post-commit side effects against false retryable 500s; add real database trigger fault-injection test for PostView atomic rollback; correct operational mechanism documentation.

**Changes:**
- **Repost Lifecycle & Relationship Tree Preservation:**
  - `src/lib/services/interaction.service.ts`: Cancel repost (`action: 'repost'` toggle off) now uniformly soft-deletes the generated repost post as an HTTP 200 tombstone (`softDeleteCorePost`) rather than physically hard-deleting when `replyCount === 0`. This eliminates the cascade deletion bug where third-party posts quoting the reposted post were deleted by PostgreSQL `onDelete: Cascade`. Author direct delete, admin report delete, and undo repost now share the exact same tombstone and counter invariants.
  - `prisma/schema.prisma` & migration `20261028170000_governance_rc_schema_fixes`: Enforced `repostPostId String @unique` (NOT NULL) and `onDelete: Cascade` foreign key constraint. Backfill in migration SQL handles multi-match deterministically (`ROW_NUMBER() = 1`), synthesizes posts for any unlinked reposts, and deletes legacy `MENTION` notifications prior to enum type conversion.
- **Feed Cache Key & Browse State Cleanup:**
  - `src/app/(shell)/page.tsx` & `src/app/(shell)/explore/page.tsx`: Reverted the injection of `searchParams.cursor` into SSR feeds and removed the crawler `<Link rel="next">` tags from home/explore layouts. Visiting URLs with deep cursors no longer seeds deep posts into page 0 cache keys (`/api/posts?tab=latest&take=20` or `/api/posts?tab=foryou`) or rewrites browser URL history.
  - Latest feed author diversity suppression is formally clarified as an anti-spam feed ranking mechanism, not an SEO traversal mechanism.
- **Partitioned Sitemaps & Dynamic Robots Entries:**
  - `src/app/(shell)/p/sitemap.ts`: Implemented Next.js 16 `generateSitemaps` contract returning `{ id: number }[]` partitions. Default `sitemap` handler resolves `props.id` Promise, applying deterministic total order `(createdAt desc, id desc)` across 50,000-post partition boundaries with zero duplicate/omission risk.
  - `src/app/robots.ts`: Dynamically calculates active post sitemap partition count and lists actual generated sitemap endpoints (`/p/sitemap/[id].xml`) alongside `/sitemap.xml`, `/u/sitemap.xml`, and `/cas/sitemap.xml`.
  - `src/app/(shell)/u/sitemap.ts` & `src/app/(shell)/cas/sitemap.ts`: Clarified and enforced single-shard bounded sitemaps capped at the 50,000 specification limit.
- **Admin Report Resolution Post-Commit Guard:**
  - `src/app/api/admin/reports/[id]/resolve/route.ts`: Maintained preemption of `PENDING` reports inside transaction. Guarded post-commit side effects (notifications, image cleanup) in dedicated `try...catch` blocks with structured audit logging so post-commit failures never emit false 500 responses that trigger invalid client retries on already-resolved reports.
- **Contract Tests & Fault Injection:**
  - `tests/api.contract.test.ts`: Added contract test verifying that canceling a repost when quoted (0 replies) does NOT cascade-delete the quoting post, returning the quoted post as an HTTP 200 tombstone. Added database trigger fault-injection test for `PostView` confirming that view counter failure rolls back the deduplication row and subsequent retry succeeds. Total contract tests expanded to 42 (all passing).

**Pitfalls / Notes:**
- Under Next.js 16 metadata route loading, when `generateSitemaps` is defined, Next.js generates static routes at `[route]/sitemap/[id].xml` (e.g. `/p/sitemap/0.xml`). `robots.txt` must explicitly list these generated endpoints instead of the root `/p/sitemap.xml`.
- When testing database transactional rollbacks, attaching a temporary PostgreSQL trigger with `RAISE EXCEPTION` before update provides a 100% faithful black-box fault-injection test without application code pollution.




### 2026-10-28 — RC Closeout: migration checksum alignment, sitemap shard lifecycle, unified repost lock order, side-effect outbox

**Context:** Final RC closeout on top of cfa0854. Three gaps: (1) migration `20261028170000_governance_rc_schema_fixes` had been rewritten in cfa0854 AFTER the local dev database applied the old version (checksum divergence); (2) post sitemap shards used `generateSitemaps`, whose shard set is frozen at prerender — crossing 50,000 posts required a rebuild and a shrunken count could leave robots.txt advertising a 404; (3) repost cancel and direct post delete acquired row locks in opposite order (Repost→Post vs Post→Repost) and cancel used an unguarded `repost.delete`, so concurrent operations could deadlock or throw P2025; report-resolution side-effect failures were only `console.error`'d — not trackable, not retryable.

**Changes:**
- **Migration alignment:** Rehearsed on dirty-data copies (`cascool_rc_f1/_n/_r`): F1 proves the OLD migration fails and rolls back atomically on MENTION data (hence every DB that recorded it has zero MENTION rows); path N (fresh apply of the rewritten file) and path R (old applied → repair SQL → checksum re-baseline) end byte-identical (links, synthesized posts, NOT NULL + CASCADE FK, notification deltas, user counts; orphan pure-repost posts preserved). Dev `cascool` repaired via `deploy/repair-20261028170000-old-version.sql` + checksum re-baseline; `prisma migrate deploy/status` clean. Production never reached this migration (origin at v1.1.7) — deploy-time verification query documented in the repair file.
- **Sitemap shard lifecycle:** New `src/lib/sitemap.ts` (pure shard math + XML builder) and stateless shard route `src/app/(shell)/p/sitemap/[index]/route.ts` (replaces `generateSitemaps` file): any numeric index answers at runtime — out-of-range serves a valid empty `<urlset>`, never 404; crossing 50,000 needs no rebuild. robots.txt derives shard count from `shardCountFor`. Removed the unproven "zero overlap / zero omission" claim (code comment + ARCHITECTURE + DEVLOG) and documented the honest semantics: shards are independently revalidated snapshots that converge at rest, but may transiently overlap/miss near the boundary during writes. `/u/sitemap.xml` and `/cas/sitemap.xml` documented as bounded (50,000), NOT exhaustive.
- **Unified repost lock order:** Canonical order in both `interaction.service.ts` (cancel) and `post-write.service.ts` (direct delete): Repost row → generated post row → user row → original post row. Both claim the Repost row with an id-guarded `deleteMany` (count>0 = winner), making concurrent cancel/cancel and cancel/delete race-proof: loser no-ops, counters decrement exactly once, no P2025, no deadlock.
- **Side-effect outbox:** New `SideEffectTask` model + migration `20261028200000_side_effect_outbox`; `src/lib/services/side-effect.service.ts` (enqueue-in-tx, drain post-commit, failures stay `pending` with `attempts`/`lastError`). `notification.ts` and `upload-cleanup.ts` split into throwing primitives (`deliverNotification`, `removeUnreferencedUpload`) + unchanged swallowing wrappers. Report resolve now enqueues notification + per-image cleanup tasks in the resolution transaction and drains after commit; `POST /api/admin/side-effects/retry` (admin write) drains pending tasks and returns per-task outcomes.
- **Tests:** 134 total (was 123; 11 new). New: concurrent double-cancel; concurrent cancel vs direct delete (5 rounds each, counters exact); re-repost after cancel claim guard; sitemap out-of-range=200-empty; full 50,001-post boundary crossing up and down (robots listing, shard sizes, quiescent exact-partition union, shrink to empty-not-404); fault injection — directory-shaped upload makes unlink fail for real (committed resolve still 200, task pending with lastError, retry endpoint compensates after fault cleared); service-level injected notification-executor fault (pending → tracked → recovered); retry endpoint auth gates. Unit: `src/lib/sitemap.test.ts` boundary math + XML escaping.

**Pitfalls / Notes:**
- `generateSitemaps` shard routes are prerendered per id at build time — useless for a count that grows past the boundary between builds. The replacement route handler registers as dynamic (`ƒ /p/sitemap/[index]` in build output) and serves every numeric index at request time.
- Any database that recorded the OLD `20261028170000` version cannot contain MENTION notifications — the old version's enum cast fails on them and the whole migration rolls back (Prisma runs migrations in one transaction). The repair SQL therefore needs no MENTION handling.
- Claim-by-id pattern: read the Repost row outside the tx for the fast 404 path, then claim inside with `deleteMany({ where: { id } })` and treat `count === 0` as "a concurrent actor won; no-op". A re-repost after a concurrent cancel creates a NEW row id, so the stale claim correctly misses and never deletes the fresh repost.
- `psql -1` wraps a file in one transaction like Prisma; files containing `CREATE INDEX CONCURRENTLY` must be applied without it (Prisma does the same).

### 2026-10-28 — RC Acceptance Fixes: shard index validation, outbox claim lease, notification eventKey

**Context:** Acceptance review of b57363e found two code defects. (1) The shard route multiplied any safe-integer index into `skip` before validation — `9007199254740991.xml` produced a Prisma-overflowing OFFSET → 500. (2) `drainSideEffects` had no atomic claim: the auto-drain and the admin retry endpoint could execute the same task concurrently, a process death mid-execution left no re-claim path, and notification retries had no persistent idempotency key for postId-NULL events.

**Changes:**
- `src/lib/sitemap.ts` + shard route: `shardSkip()` returns null for non-safe-integer offsets; route order is malformed→404, overflow→200 empty (no DB), beyond `shardCountFor(count)`→200 empty (no OFFSET query), then the skip/take query. Contract tests extended with `9007199254740991.xml` and `500000.xml`; unit tests pin the overflow threshold (~1.8e11).
- Migration `20261028210000_outbox_claim_and_notification_eventkey`: `SideEffectTask.claimToken/claimedAt` (60 s lease; claimed via per-row conditional `updateMany`, released on success AND failure, re-claimable after lease expiry) and `Notification.eventKey` (unique; `deliverNotification` upserts on it — covers postId-NULL report notifications). Resolve route enqueues notification tasks with `report:<id>:resolved:reporter|reported:<uid>` event keys.
- New tests: concurrent auto-drain × admin retry on one task → exactly one notification (`eventKey` count = 1, single `succeeded`, `attempts = 0`); delivered-then-crashed-before-marking → retry produces no duplicate. Production-build HTTP regression suite `tests/prod-sitemap.http.test.ts` (opt-in `RUN_PROD_HTTP=1`: `next build` + `next start`, asserts 0/beyond-range/overflow/malformed indices never 500). RC report gained the REQUIRED pre-deploy migration-record + count-reconciliation queries and an explicit "production never connected / not verified" statement. `/.tmp/` explicitly gitignored.

**Pitfalls / Notes:**
- `registerAndLogin` prefixes usernames (`t_<seed>_<tag>`) — never look users up by the bare seed name in tests.
- Claim pattern: read nothing first; claim = conditional `updateMany` writing a fresh `claimToken`, then `findMany({ claimToken })`. Per-row atomicity means concurrent drains each get disjoint sets without locks or retries.
- Notification dedup now has three tiers: `eventKey` (outbox events, incl. postId NULL) → compound `(userId, fromId, type, postId)` (postId-based) → application-level findFirst+create (FOLLOW/MESSAGE).

### 2026-10-28 — RC Acceptance Fixes (round 3): eventKey vs compound unique, claim limit, pre-deploy SQL split

**Context:** Second acceptance pass on 4c2ab02. (1) The eventKey upsert conflicted with the legacy `@@unique([userId, fromId, type, postId])`: a different event over the same tuple (same admin resolving a second report of the same post) hit P2002 and left the task permanently pending; its retry branch also re-surfaced already-read notifications. (2) `drainSideEffects` claimed ALL pending rows regardless of `limit` (rows beyond the limit held claims for the 60 s lease) and wrote results back by id only. (3) The RC report's pre-deploy SQL referenced new-chain columns, which cannot run on a v1.1.7-era schema.

**Changes:**
- `src/lib/notification.ts`: eventKey delivery is now a parameterized raw `INSERT … ON CONFLICT DO NOTHING`. eventKey hit = same-task retry = pure no-op (read/createdAt untouched). Compound hit (postId non-null) = genuine new event = re-surface that single row once and re-stamp its eventKey to the latest event, so that event's own retries no-op. Semantics documented in-code.
- `src/lib/services/side-effect.service.ts`: claim is one `UPDATE … WHERE id IN (SELECT … ORDER BY createdAt LIMIT $n) RETURNING id` (parameterized, make_interval lease) — at most `limit` rows claimed; unexecuted tasks stay claim-free. Success/failure write-backs guarded by `where: { id, claimToken }` (stale executors cannot overwrite a new claimant).
- Tests (+2, one extended): two sequential resolutions of the same post by the same admin → both 200, all 4 tasks succeeded, one notification row per recipient stamped with the later key, zero pending; crash-retry leaves `read=true` and backdated `createdAt` untouched; limit drains 2/2/1 with no held claims between passes.
- RC report: pre-deploy block P (old-schema-safe; adds `reposts_without_generated_post` and `multi_match_reposts` prediction counts) split from post-migration block M (reconciliation + FK/NOT NULL/UNIQUE spot-checks). Production stays marked not connected / not verified.

**Pitfalls / Notes:**
- Bare `ON CONFLICT DO NOTHING` (no target) swallows every unique violation — then distinguish retry (row found by eventKey) from new event (compound match) with one lookup. Never re-surface on the eventKey path; only the compound path re-surfaces.
- `@default(cuid())`/`@default(now())` are CLIENT-side defaults — raw SQL INSERTs must supply `id` explicitly (`randomUUID()`); `createdAt`/`read` have real DDL defaults.

### 2026-10-28 — RC Acceptance Fixes (round 4): persistent delivery record, SKIP LOCKED claims, executable report SQL

**Context:** Third acceptance pass on 7a1c53d. (1) The eventKey stamp lived on the mutable notification row — an OLD event retried after a NEWER event re-stamped the row would re-surface it (delivery state was overwritable). (2) The claim's id-subselect re-checked nothing on the locked row version — under READ COMMITTED two concurrent claims could both select the same candidates and double-claim. (3) RC report SQL banners used non-ASCII dashes (not legal SQL comments) and the blocks had never been executed.

**Changes:**
- Migration `20261028220000_notification_delivery_record`: `NotificationDelivery` (eventKey PK, notificationId FK ON DELETE SET NULL, deliveredAt). `deliverNotification` event path: delivery-record insert `ON CONFLICT DO NOTHING` is the idempotency gate; new events create-or-re-surface the visible row (compound `DO UPDATE` touches only read/createdAt — the row's eventKey stamp is set once at insert and never moved); record and visible change commit in ONE transaction. Old-event retries after newer events are pure no-ops.
- `buildSideEffectClaimSql` (exported, fully parameterized): `WITH candidates AS (SELECT … ORDER BY createdAt LIMIT $n FOR UPDATE SKIP LOCKED) UPDATE … RETURNING` with the lease predicate in both the scan and the outer WHERE. `drainSideEffects` executes it via `$queryRawUnsafe` with bound values only. Limit/lease/claimToken write-back guards unchanged.
- Tests (+3): the A/B/read/retry-A/retry-B sequence (row frozen: eventKey/read/createdAt; two delivery records; one row); legacy LIKE + FOLLOW-shaped dedup still collapses to one row; two live pg connections contend — executor 1 claims inside an open transaction, executor 2 gets only the unlocked rows, contended task keeps executor 1's token after commit. Fixed two `= ANY($1)` calls to pass a nested array parameter.
- RC report: P/M banners now legal `--` comments; blocks executed for syntax validation (P on an old-schema rehearsal DB with `_prisma_migrations` present; M on local dev). Production still not connected / not verified.

**Pitfalls / Notes:**
- Dedup authority must live in a table whose rows are never UPDATEd by the event flow — a stamp on the visible row is state, not a record; any later-event write to it re-opens the retry window.
- `FOR UPDATE SKIP LOCKED` inside the CTE is what makes candidate selection and claiming one operation; the outer-WHERE lease re-check is defense-in-depth for the locked-row version, not the exclusion mechanism itself.
- The `pg` driver treats a bare array in `values` as multiple bind parameters — `= ANY($1)` needs the array nested (`[[a, b]]`).

### 2026-10-29 — Code audit closure: post transaction boundaries, outbox leases, pagination

**Context:** Runtime code audit after the RC closeout, independent of production migration/deployment work. Confirmed defects: committed posts could fail on cache invalidation or recipient lookups; edit checks and image snapshots could become stale before the write; outbox batches could execute tasks reclaimed while waiting and miscount superseded completions; fractional page sizes disagreed with query/cursor termination, and regex-valid invalid calendar dates reached PostgreSQL.

**Changes:**
- `post-write.service.ts`: capture reply/quote recipients during validation, removing post-commit lookups. Edit locks the post row before checking live state, ownership, the 60-minute window and pure-repost status; image/CAS snapshots and writes use that same transaction. `editCorePost` additionally guards author and live state.
- `user.service.ts`: centralize logged, best-effort trending invalidation for committed creates, edits and deletes; moderation reuses it. Edits now invalidate trending after chemical changes as well.
- `side-effect.service.ts`: distinguish omitted IDs from an explicit empty list; renew each task's claim with the database clock before execution; skip queued tasks whose ownership changed; count only owned success/failure write-backs. Retry endpoint documentation now states the 500-task bound and per-run versus global fields.
- `pagination.ts`: share bounded integer page sizes and canonical calendar-timestamp validation across timeline/search. Search binds LIMIT along with query/cursor values; feed and search use the same normalized size for queries and pagination termination.
- Add 13 real-database regressions across `tests/post-write.audit.test.ts`, `tests/side-effect.audit.test.ts`, and `tests/pagination.audit.test.ts`; extend HTTP contracts for fractional sizes and invalid search dates. Initial runs reproduced the affected paths before their fixes.
- Sitemap boundary test: parse each XML shard once and compare sets in linear time instead of reparsing inside 50,000 assertions; always clean the bulk fixture in a scoped teardown. This fixes the observed 30-second baseline timeout without increasing the test timeout. Update API and architecture contracts to match the final mechanisms.
- Test database lifecycle: replace the manual backend-termination sweep with PostgreSQL's native `DROP DATABASE ... WITH (FORCE)` for the already-validated throwaway database name. A full run passed all 155 cases but exposed an intermittent `permission denied to terminate process` in teardown; background-worker shutdown belongs to the database drop operation ([PostgreSQL 16 contract](https://www.postgresql.org/docs/16/sql-dropdatabase.html)).
- Final verification: `npm test` **155 passed**, clean exit (the opt-in production HTTP suite is skipped by default); `RUN_PROD_HTTP=1 npx vitest run tests/prod-sitemap.http.test.ts` **1/1 passed**; lint has zero errors/warnings; typecheck passes; cold `npm run build` succeeds with **45/45** prerender work units and dynamic post sitemap shards. Production-mode HTTP verification used the throwaway test database; the final build used local dev `cascool`.

**Pitfalls / Notes:**
- A lease is not an unbounded execution lock: an executor running longer than 60 seconds can overlap a retry. NotificationDelivery remains the transactional event-idempotency authority, and cleanup remains idempotent. Superseded executions count as attempted but cannot report the new owner's success or failure.
- Concurrency regressions use independent PostgreSQL connections and observe real blocked writers; lease regressions advance stored claim timestamps instead of sleeping. Test pools close explicitly before dropping the throwaway database. Cache/framework boundaries alone are mocked in post-service tests.

### 2026-10-29 — Independent re-review of the audit-closure working tree

**Context:** Second reviewer pass over the uncommitted audit-closure changes (HEAD `eb80957` + dirty tree), tracing schema → query → transaction → serialization → callers across post writes, the outbox, pagination/search and the test infrastructure. Goal: confirm or refute defects without expanding scope.

**Changes:**
- `src/app/api/posts/route.ts`: an unparseable `since` was silently treated as absent while `if (cursor && !since)` skipped cursor validation — `?since=banana&cursor=banana` fell through to the feed tabs and reached Prisma with an Invalid Date (500). Invalid `since` now returns 400 `bad_request`; `cursor` is validated whenever present, including alongside a `since`. The banner client sends `toISOString()` and is unaffected.
- `tests/api.contract.test.ts`: HTTP regression for invalid `since` (400), `since`+garbage cursor (400), valid-`since`+garbage cursor (400) and the canonical-`since` banner path (200). Reproduced red before the fix (invalid `since` returned 200).
- `docs/API-BASELINE.md`: the `/api/posts` cursor/since validation contract is now stated explicitly.

**Pitfalls / Notes:**
- Verified clean, no changes: edit checks run under the post row lock with unchanged error order/codes; edit (Post → Chemical) vs delete/cancel (Repost → Post → User → original → Chemical) cannot form a lock cycle (edit never takes the Repost row lock); image cleanup snapshots are read after the lock (audit test pins deletion of the actually-replaced file); create/edit post-commit paths are non-fallible (`upsertNotification`, `deleteUnreferencedUploads` swallow internally; `revalidateTrending` logs).
- Outbox verified against its docs: omitted ids = all claimable, explicit `[]` = none; renewal re-checks `claimToken`+`pending` on the database clock before each execution, so queue-reclaimed tasks are skipped; superseded executors cannot report outcomes — `attempted` may exceed `succeeded+failed` exactly as documented.
- Search's cursor id-shape regex never sees `repost_*` backfill ids: synthesized pure reposts have empty content and no CAS links, so they cannot enter search pages. Timeline cursors accept any non-empty id by design.
- Test infra: `fileParallelism: false` serializes the four DB-backed files sharing the throwaway database; `DROP DATABASE … WITH (FORCE)` applies only to the name-validated `_test` database with pools closed first.

### 2026-10-29 — Unified Credential Dynamic Authorization, Streamable HTTP MCP, Post Deletion Snapshot & Audit Closure

**Context:** The user mandated a unified identity credential model replacing the legacy dual-tier `read`/`read_write` access system. A single API key now acts purely as an identity proof across both REST and MCP, with capabilities dynamically derived at request time (`active` + current `verified` for write; unverified or restricted for read-only; suspended/revoked/expired for 401). Official Model Context Protocol (MCP) Streamable HTTP endpoint implemented at `/mcp` for agentic chemical discovery and interaction. Concurrently, closed all remaining write bypasses (`GET /api/messages/:id` read receipt, `POST /api/posts/:code/view` programmatic gate, and API key creation count race) and fixed the post deletion image snapshot concurrency race under the canonical lock hierarchy.

**Changes:**
- **Database & Schema:** Created migration `20261029140000_retire_api_key_access` dropping `ApiKey.access` and `ApiKeyAccess` enum. Updated `prisma/schema.prisma` and regenerated Prisma client (`npm run db:generate`). Rehearsed legacy key migration in `tests/migration-compatibility.test.ts` verifying that legacy keys seamlessly transition to dynamic authorization without data loss.
- **Dynamic Authorization Engine:** Updated `src/lib/permissions.ts` with `hasCurrentVerification` (handles invalid calendar dates, null/undefined indefinite verification, and strict `> now` evaluation) and `computeCapabilities` safe metadata summary. Refactored `src/lib/api-auth.ts`: removed `apiKeyAccess`, updated `writeAccessError` and `adminAccessError` to enforce programmatic verification for API keys while preserving browser membership tiers. Added public/authenticated `GET /api/account/capabilities` route with `Cache-Control: no-store`.
- **API Key Lifecycle & Concurrency:** Refactored `POST /api/account/api-keys` and `DELETE /api/account/api-keys/:id`: removed `access` field; permitted active unverified web members to create and revoke unified keys; eliminated the `count -> create` concurrency race by locking the owning `User` row (`SELECT id FROM "User" WHERE id = $1 FOR UPDATE`) within the transaction; barred API keys from managing credentials. Updated `SettingsHub.tsx` and `ApiKeysClient.tsx` to unlock key management for unverified users, render live capability badges, and show `/mcp` client configuration snippets.
- **Write Bypass Closures:**
  - `GET /api/messages/:id`: Replaced `apiKeyAccess !== 'read'` with `writeAccessError(auth.identity) === null`. Programmatic callers without write permission can read conversation history without modifying `readAt`.
  - `POST /api/posts/:code/view`: Enforced explicit Bearer authorization: invalid Bearer returns 401; unverified Bearer returns 403 (neither records `PostView` nor increments views). Anonymous and session telemetry remain intact.
- **Shared Follow Service:** Extracted `setUserFollow` into `src/lib/services/follow.service.ts` with atomic transaction, denormalized counter updates, self-follow prevention, and notification handling. Replaced redundant implementations in `POST /api/users/:username/follow` and MCP `set_follow`.
- **Post Deletion Image Snapshot Concurrency:** In `post-core-write.service.ts`, updated `softDeleteCorePost` to acquire post row lock (`FOR UPDATE` following the canonical `Repost -> Post -> User -> original Post` hierarchy) and return the live `{ deleted: boolean, images: string[] }` snapshot. Updated `softDeleteProductPost`, `deletePost`, and `deleteReportedPost` to pass the live snapshot to unreferenced upload cleanup and outbox report payload.
- **Official MCP Streamable HTTP (`/mcp`):** Implemented `/mcp` Route Handler using `@modelcontextprotocol/sdk` and `WebStandardStreamableHTTPServerTransport`. Enforced per-request Server/Transport instantiation, `SiteConfig.origin` check across all HTTP methods (GET, POST, DELETE, PUT, PATCH), 64KB body limit with stream cancellation, batch array rejection, Bearer-only auth, shared rate-limiting, and 12 end-to-end tools (7 read: `get_capabilities`, `list_posts`, `get_post`, `get_post_discussion`, `search_posts`, `get_chemical`, `get_profile`; 5 write: `create_post`, `edit_post`, `delete_post`, `set_interaction`, `set_follow`).
  - Added `get_post_discussion` for bounded, paginated thread context exploration.
  - Implemented exact attachment preservation in `edit_post` under post row lock: `images` omitted preserves existing images; `images: []` clears all images; `images: [urls]` replaces with provided images.
  - Aligned MCP content normalization with REST (trimmed whitespace, empty text posts rejected unless quotes or media).
  - Adopted official SDK `ToolAnnotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`), synchronized JSON schemas via `zodToInputSchema` with zero manual schema drift, and sanitized error masking (`Error ID: <uuid>`).
- **Tests & Verification:** Added `tests/mcp.integration.test.ts` (6 tests), `tests/migration-compatibility.test.ts` (1 test), concurrency regression tests in `tests/post-write.audit.test.ts` (deletion image snapshot race, concurrent key creation, edit attachment preservation), and dynamic authorization suites in `tests/api.permissions.test.ts` (21 tests) and `tests/api.contract.test.ts` (58 tests). Handled PostgreSQL 16 teardown background worker race in `tests/helpers/db.ts`.

**Pitfalls / Notes:**
- `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport` throws if reused across requests; stateless HTTP requires instantiating a fresh `Server` and `Transport` per request.
- Post deletion must lock the post row immediately after claiming the Repost row to capture the live image snapshot without deadlocking concurrent cancellations or edits.
- Post editing must resolve omitted vs empty `images` inside the transaction after acquiring the row lock to avoid race conditions with concurrent edits.
- Teardown database drops in PostgreSQL 16 can race with background worker termination; catching transient permission errors in test teardown prevents false test failures.
- PostgreSQL naive `TIMESTAMP(3)` columns must be queried/updated using UTC (`timezone('utc', now())`) to avoid local timezone offsets skewing expiration calculations.

---

### 2026-10-29 — Discussion Context Bounded Query, Capability Alignment, Strict MCP Contract & Dependency Security

**Context:** Codex review identified remaining items across dependency security, discussion query bounds, capability description fidelity, MCP contract strictness, and test teardown failure visibility. Specifically: (1) multiple security advisories across Next.js, Sharp, and Prisma required validated minimal in-place upgrades; (2) discussion context queries (`getPostChain`) previously fetched all conversation messages into memory, risking resource exhaustion on unbounded threads; (3) `computeCapabilities` evaluated `maxPostLength` and direct message permissions using a redundant check that conflicted with web session verification rules; (4) MCP tools lacked strict schema rejection (`.strict()`), `edit_post` misstated its destructive attachment hint, and input schemas manually picked properties; (5) database teardown silently swallowed drop failures instead of exposing persistent errors after bounded retries.

**Changes:**
- **Dependency Security Upgrades:**
  - Upgraded Next.js and `eslint-config-next` to `16.4.3` (resolves SSRF, cache poisoning, RCE advisories, and nested PostCSS issues).
  - Upgraded Sharp to `0.35.5` (resolves libvips, libheif, librsvg native library vulnerabilities; maintains WebP pipeline compatibility).
  - Upgraded Prisma client and engines to `7.10.1` (resolves `mysql2`, `deepmerge-ts`, and `valibot` transitive vulnerabilities; runs migrations cleanly).
  - Synchronized `package.json` `allowScripts` to `"sharp@0.35.5": true`, `"unrs-resolver@1.12.2": true`, `"prisma@7.10.1": true`, and `"@prisma/engines@7.10.1": true`. Updated `baseline-browser-mapping`.
  - Documented reachability: the sole remaining advisory in `npm audit --omit=dev` is `@hono/node-server <= 2.1.2` (transitive in `@modelcontextprotocol/sdk@1.32.2`'s unused server binding), whose `serveStatic` path is completely unreachable in cas.cool's Next.js App Router.
- **Bounded Discussion Queries (`getPostChain`):**
  - Replaced full conversation loading in `post-core.service.ts` with a bounded recursive CTE (`WITH RECURSIVE ancestor_walk ... WHERE aw.depth < ${limit + 1}`) that strictly traverses parent pointers (`p."parentId"`), ignoring unrelated sibling branches and capping database query volume.
  - Returns `PostChainResult` containing `ancestors` (reversed to chronological root -> direct parent), `hasMoreAncestors` (boolean), and `oldestAncestorId` (boundary cursor).
  - Soft-deleted tombstone placeholders are preserved in ancestor chains.
  - Extended MCP `get_post_discussion` with optional `ancestorTake` (1..50, default 20), returning `ancestorsTruncated`, `hasMoreAncestors`, and `oldestAncestorId`.
  - Added discussion regression tests in `tests/mcp.integration.test.ts` asserting bounded 25-ancestor traversal, sibling branch isolation, tombstone retention, and paginated replies.
- **Faithful Capability Computation:**
  - In `src/lib/permissions.ts`, aligned `computeCapabilities` with actual application service rules:
    - Session callers derive `effectiveMaxPostLength` via `maxPostLength(user)` (allowing 2000 chars for web members regardless of programmatic API key verification expiration) and `canDirectMessageAnyone` via `canDirectMessage(user)`.
    - API key callers strictly require `isVerified` (`active` + current programmatic verification) for write capabilities and 2000 characters.
    - Restricted callers retain read capabilities with zero write permissions.
  - Added unit test suite in `src/lib/permissions.test.ts` covering session vs API key under valid, expired, and restricted states.
- **MCP Contract Strictness & Annotations:**
  - Applied `.strict()` across all 12 tool schemas in `src/lib/mcp/tools.ts` to reject unknown business parameters.
  - Corrected `editPostTool.annotations.destructiveHint` to `true` reflecting its capability to clear post attachments.
  - Replaced manual property picking in `zodToInputSchema` with direct pass-through of the complete Zod JSON Schema.
  - Added input validation for `get_capabilities` (`getCapabilitiesSchema.safeParse(args ?? {})`).
  - Single continuous MCP client tests in `tests/mcp.integration.test.ts` verify the full dynamic lifecycle across unverified, verified, expired, and restricted states on a single key.
- **Exposed Test Teardown Failures:**
  - Refactored `tests/helpers/db.ts` `dropTestDatabaseWithExecutor`: retries transient errors up to 3 times with a fixed wait (`backoffMs = 200`); if retries are exhausted, throws `Failed to drop test database after 3 attempts: <cause>`; unknown non-transient errors are thrown immediately without retry.
  - Added fault injection test suite `tests/db-lifecycle.test.ts` validating retry recovery, persistent retry exhaustion, and immediate failure propagation.
- **Contract & Documentation Alignment:**
  - Updated `docs/API-BASELINE.md` clarifying read-receipt side effects on `GET /api/messages/:id` and API key `lastUsedAt` updates.

**Pitfalls / Notes:**
- Recursive CTE parent traversal bounds the walk at `limit + 1` in SQL before any rows are transferred to Node.js, protecting against memory exhaustion in deep reply threads.
- `edit_post` `destructiveHint: true` informs LLM agents that clearing attachments is potentially destructive, aligning MCP annotations with Anthropic/OpenAI agent expectations.
- Continuous MCP client lifecycle tests demonstrate that capability changes on the server take effect immediately without requiring client reconnection.

---

### 2026-10-29 — Ancestor Cursor Continuation, Independent Discussion Pagination & Web UI Reading Retention

**Context:** Codex acceptance required closing the ancestor pagination loop without changing discussion target identities or breaking on soft-deleted boundary posts. Specific mandates: (1) define a directly consumable ancestor continuation cursor (`nextAncestorCursor` / `ancestorCursor`) enabling traversal through soft-deleted boundary nodes while keeping single-post `get_post` 404 contracts intact; (2) wire ancestor continuation into `PostDetailClient` with an upward loading entry that preserves scroll reading position; (3) decouple ancestor and reply pagination so advancing one never resets or corrupts the other's state; (4) add targeted regressions for deep chains, soft-deleted boundary nodes, consecutive deleted nodes across pages, and multi-page reads to root with branch isolation.

**Changes:**
- **Ancestor Continuation Engine (`getPostChain`):**
  - Updated `src/lib/services/post-core.service.ts` and `src/lib/services/post.service.ts` to accept `options?: { limit?: number; cursor?: string | null }` and return `{ ancestors, hasMoreAncestors, oldestAncestorId, nextAncestorCursor }`.
  - The recursive CTE anchors at `(SELECT "parentId" FROM "Post" WHERE id = ${cursor || postId})`, seamlessly traversing past soft-deleted boundary posts without requiring boundary posts to be queried as live target posts.
  - Hydrated ancestors reverse from depth-asc to chronological order (`root -> direct parent`), preserving tombstones.
- **REST Ancestor Endpoint (`GET /api/posts`):**
  - Added `ancestorsOf=<postId>` support to `GET /api/posts` with `cursor=<ancestorCursor>` and bounded `take` (1..50). Returns `{ posts, nextCursor, hasMoreAncestors }`.
  - Rejects malformed ancestor cursors with 400 `bad_request`.
- **MCP `get_post_discussion` Independent Pagination:**
  - Extended `getPostDiscussionSchema` with `.strict()` and `ancestorCursor: z.string().optional()`.
  - Independent pagination branches:
    - Initial call (`!cursor && !ancestorCursor`): returns first page of ancestors and first page of replies.
    - Ancestor continuation (`ancestorCursor` provided, `cursor` omitted): fetches older ancestors; replies and `nextCursor` are omitted, preventing reply cursor reset.
    - Reply continuation (`cursor` provided, `ancestorCursor` omitted): fetches subsequent direct replies; ancestors and `hasMoreAncestors` are omitted, preventing false `hasMoreAncestors: false` overwrite.
    - Joint continuation: both advance independently when both cursors are provided.
- **Web UI Post Detail Context Loading (`PostDetailClient`):**
  - Passed `initialHasMoreAncestors` and `initialAncestorCursor` from `src/app/(shell)/p/[code]/page.tsx` to `PostDetailClient`.
  - In `src/components/posts/PostDetailClient.tsx`, added "Show earlier posts" button above ancestor thread.
  - Preserves scroll reading position via `prevScrollHeight` delta adjustment on prepending older ancestors.
  - Follows mobile-first touch guidelines (`min-h-[44px]`), semantic design tokens (`text-brand`, `bg-canvas/40`, `border-line/60`), and 100% English UI copy.
- **Regressions & Quality Verification:**
  - Added full multi-page ancestor pagination suite in `tests/mcp.integration.test.ts` covering 25-depth chains, soft-deleted boundary node `A16`, multiple consecutive soft-deleted nodes (`A17`, `A16`, `A15`, `A14`), branch isolation, independent reply pagination, and single-post deleted 404 verification.
  - Added unit regression in `tests/pagination.audit.test.ts` asserting recursive CTE cursor traversal across soft-deleted posts to root.

**Pitfalls / Notes:**
- Querying ancestors via `ancestorCursor` on the original discussion target preserves the thread identity and conversation tree, avoiding the trap of re-querying the boundary post (which would 404 if deleted or switch the reply root if alive).
- Upward DOM insertion shifts the document height; recalculating `window.scrollTo(0, prevScrollY + (newScrollHeight - prevScrollHeight))` in a layout frame is required to prevent viewport jump.

---

### 2026-10-29 — Ancestor Cursor Target Binding, Signature Verification & Bare-ID Retirement

**Context:** The ancestor continuation cursor previously accepted any post ID (including `oldestAncestorId` returned as boundary info), allowing callers to re-anchor pagination on arbitrary posts or replay cursors across discussions. This round makes the cursor an opaque, cryptographically signed, target-bound token, retires the legacy bare-ID form, and syncs the MCP tool contract description and API baseline to tell agents to pass `nextAncestorCursor` only.

**Changes:**
- **Target-Bound Signed Cursor (`src/lib/pagination.ts`):**
  - `encodeAncestorCursor(targetPostId, boundaryAncestorId)` emits `base64url(payload:HMAC-SHA256)` with a dedicated purpose string `cascool:ancestor_cursor:v1`, keyed by `JWT_SECRET` (falling back to `AUTH_SECRET`).
  - `decodeAndValidateAncestorCursor(cursor, expectedTargetPostId)` enforces payload format, exact target-post binding (rejects cross-discussion cursor reuse), and `timingSafeEqual` signature verification.
- **Service Enforcement (`src/lib/services/post-core.service.ts`, `src/lib/services/post.service.ts`):**
  - `getPostChain` decodes and verifies `options.cursor` before anchoring the recursive CTE; invalid, foreign, or tampered cursors raise `PostServiceError(400)`, surfacing as `Invalid ancestorCursor` from MCP and 400 `bad_request` from REST `GET /api/posts?ancestorsOf=`.
  - `nextAncestorCursor` is emitted only when more ancestors remain and is always the signed token; `oldestAncestorId` stays in responses as boundary information only.
- **Legacy Bare-ID Retirement:**
  - Bare post IDs (e.g. a previous page's `oldestAncestorId`) now fail cursor decoding (`Malformed ancestor cursor format`) and are rejected with 400 / tool error on both REST and MCP paths.
- **Contract & Docs Sync (this commit):**
  - `src/lib/mcp/tools.ts` `ancestorCursor` description now reads: `Pass nextAncestorCursor from the previous response for the same target post.`
  - `docs/API-BASELINE.md` documents `nextAncestorCursor` as the only token accepted by `ancestorCursor` (opaque, HMAC-signed, target-bound) and `oldestAncestorId` as boundary info only.
- **Regressions:** `tests/mcp.integration.test.ts` rejects bare `p_a16`, tampered signatures, tampered boundary IDs, tampered target IDs, and cross-discussion token reuse on both REST and MCP; `tests/pagination.audit.test.ts` covers signed-cursor continuation across soft-deleted posts to root.

**Pitfalls / Notes:**
- The cursor signature binds to the discussion target post (the `postId` of the original request), not to the boundary ancestor: anchoring at the target preserves thread identity when boundary posts are soft-deleted.
- Signature comparison uses `timingSafeEqual` on equal-length buffers; a length mismatch short-circuits into the same rejection path.
- Without `JWT_SECRET`/`AUTH_SECRET`, encode/verify falls back to a dev-only constant; production throws instead of silently using it.

---

### 2026-10-29 — 1.2.0 Closeout: Concurrency Lock Ordering, Pagination Error Contracts, Dependency Audit, Quality Gates, Release Notes & Version 1.2.0

**Context:** Independent 1.2.0 audit confirmed eight findings on the uncommitted batch: opposed User lock order deadlocking mutual follows (P2034), opposed CAS input orders deadlocking post transactions (P2034 → after a first fix attempt, P2002), `ApiKey.access` retirement incompatible with the documented deploy order, unvalidated notification cursor (500 on garbage), MCP root posts skipping ancestor-cursor validation, 4 audit findings in the lockfile, a machine-speed-dependent rate-limit test plus sitemap/migration flakiness under full-suite load, and Node engines wider than the toolchain supports. This closeout fixes each at the system layer with red-then-green regression evidence; the working tree stays uncommitted for Codex re-verification.

**Changes:**
- **Follow concurrency (`src/lib/services/follow.service.ts`):** both branches now lock the two User rows up front in one canonical order (ascending id, `FOR NO KEY UPDATE` — the exact strength the counter UPDATEs take, so FK `KEY SHARE` readers are not blocked) before any relation change or counter move. Fixes mutual follow, mutual unfollow and interleaved bursts for REST and MCP through the shared service; duplicate requests remain idempotent via the P2002 catch / deleteMany count guard. Notification stays outside the transaction.
- **Chemical write concurrency (`src/lib/chemistry/post-chemicals.ts`):** canonical CAS order (dedup + sort) everywhere; `lockChemicalAdvisory` takes per-CAS `pg_advisory_xact_lock(hashtext('cascool:chemical:'||cas))` via `$executeRaw` (void columns break `$queryRaw`) in canonical order before row locks, serializing creators of the same still-missing Chemical (root cause of the P2002: Prisma 7 + pg adapter upsert is read-then-insert, not atomic ON CONFLICT); `lockExistingChemicalRows` takes `FOR NO KEY UPDATE` on existing rows in canonical order (row locks cannot order rows that do not exist; `UPDATE … IN` order is not guaranteed). Covers create, edit-replace and delete through the union of old ∪ new CAS sets. No transaction retry needed — all lock acquisitions are globally ordered.
- **Notification cursor contract (`src/lib/services/notify.service.ts`, `src/app/api/notifications/route.ts`):** `validateNotificationCursor` (shared service, canonical `<timestamp>|<id>` shape via `isCanonicalTimestamp`) runs before any query; the route maps `InvalidNotificationCursorError` to the standard 400 `bad_request` envelope. Sorting, page size and visibility untouched.
- **MCP root-post cursor parity (`src/lib/mcp/tools.ts`):** the ancestor branch no longer special-cases `parentId` — root and reply alike go through `getPostChain`, so signature verification and target binding apply uniformly; a root post without a cursor returns an empty ancestor page. HMAC binding, bounded queries and independent ancestor/reply pagination unchanged.
- **Quality gates:** rate-limit integration test rewritten as a bounded true burst (drain until provably limited, cap 200 requests, assert `capacity ≤ allowed ≤ capacity + elapsed refill`; REST↔MCP share per-key buckets; key isolation probed on the read tier); exact token-bucket math (999/1000ms boundary, denial-keeps-accrual, 120/min fractional refill, capacity cap, 10min stale-bucket GC) pinned by controlled-clock unit tests in `src/lib/rate-limit.test.ts`; the 50k-sitemap boundary test gets a justified per-test 120s budget, `AbortSignal.timeout` on its fetches and a bounded verified fixture cleanup; `provisionTestDatabase` rethrows with the schema engine's stdout/stderr attached.
- **Dependencies:** `npm update @hono/node-server` (1.19.11→2.1.5, inside the SDK's declared `^1.19.9 || ^2.0.5`), `npm update brace-expansion browserslist js-yaml` (1.1.21/5.0.12, 4.29.5, 4.3.2 + normal browserslist data deps). Full `npm audit` and `npm audit --omit=dev` both report **0 vulnerabilities**. No `--force`, no overrides, no unrelated majors.
- **Node engines:** `>=22` → `^22.12.0 || >=24.0.0` (intersection of Prisma 7 `^20.19||^22.12||>=24.0` and Vitest 5 `^22.12.0||^24.0.0||>=26.0.0`); synced into `package-lock.json` root metadata and `DEVELOPMENT.md` prerequisites. CI stays on `node-version: 22` (resolves to latest 22.x ≥ 22.12).
- **Release notes:** new `docs/RELEASE-1.2.0-ACCESS-RETIREMENT.md` — compatibility matrix around the `access` drop (old binary + migrated DB = 42703, rehearsed on a throwaway DB), why binary-only rollback fails, snapshot-based DB rollback path, honest deploy sequence with the interruption window called out; `DEVELOPMENT.md` deploy section points at it.
- **Version 1.2.0:** `package.json`, `package-lock.json` (root + packages entry), `VERSION` file, `src/lib/version.ts` all moved 1.1.7 → 1.2.0; MCP `serverInfo` now imports `VERSION` instead of a second hardcoded copy; `CHANGELOG.md` gains the 1.2.0 entry.
- **Regression evidence (red → green):** 8 new failing assertions were captured on the unfixed tree (banana cursor 500, malformed compound cursors 500, mutual follow `[500,200]`, mutual unfollow `[500,200]`, interleaved burst 500, opposed CAS create `[500,201]`, opposed CAS edit-replace `[200,500]`, MCP root foreign-token success) and all pass after the fixes; the CAS fix's first attempt surfaced the deeper P2002 race, fixed by the advisory admission gate.

**Pitfalls / Notes:**
- Prisma 7 with `@prisma/adapter-pg` does not compile this upsert to atomic `INSERT … ON CONFLICT` — the loser of a concurrent-create race gets P2002, not an update path. Any future "ensure exists" upsert on a unique key under concurrency needs the advisory-admission pattern (or a native ON CONFLICT raw statement).
- `pg_advisory_xact_lock` returns void; `$queryRaw` cannot deserialize a void column — use `$executeRaw` for lock-only statements.
- Gated regression tests deliberately reproduce AB-BA deadlocks with DB triggers + session advisory gates; on fixed code only one waiter can reach a gate, so the bounded poll (2.5s) times out and both requests complete — the gate wait is part of the test's runtime.
- The mutual-follow fix locks users pairwise by sorted id; pairwise-sorted acquisition is cycle-free for any combination of pair operations (a cycle would require id1 < id2 < … < id1).
- The audit's "migrate → build → reload is not zero-downtime" finding is a flow property, not a code defect — no runtime compat branch was added; the release notes own the window.

---

### 2026-10-29 — 1.2.0 Review Closeout: Advisory Lock Resource Ordering, Node Engines Correction, Release Notes Corrections

**Context:** The independent 1.2.0 review confirmed the prior closeout's fixes but rejected final sign-off on three findings: (1) the new CAS advisory admission locks sorted the CAS strings, not the actual hashed lock resources — a 32-bit hashtext collision (two distinct CAS mapping to the same key) let two transactions acquire the same resource pair in opposite orders, a real AB-BA deadlock the review reproduced over HTTP on a production build (40P01/P2010, 500/201); (2) the declared Node range `^22.12.0 || >=24.0.0` was not the toolchain intersection — it admits Node 25, which Vitest 5.0.5 does not support; (3) the release notes asserted an unverified production state, carried a stale migration count (13 vs 14), and reused 1.2.0/MCP health checks for old-baseline rollback acceptance where MCP does not exist.

**Changes:**
- **Advisory resource ordering (`src/lib/chemistry/post-chemicals.ts`):** `lockChemicalAdvisory` now computes the ACTUAL resource keys first (`SELECT DISTINCT hashtext('cascool:chemical:' || cas)::text`), deduplicates by key (colliding CAS are one resource, locked once), sorts them numerically (ascending signed 64-bit — one global order over the real resources), and acquires each key in its own statement from application code, so the execution order is the loop order — never an unordered set output, planner-dependent evaluation, or the input CAS order. Chemical row locks stay ordered by casNumber (rows are identified by casNumber; that IS their resource order). The P2002 concurrent-create protection, row-lock strength, relation/counter atomicity and side-effects-outside-transaction are unchanged; no retries, no error swallowing.
- **Regression (red → green):** new `advisory hash-collision lock ordering` suite in `tests/api.contract.test.ts` asserts the collision precondition live (7009484-11-4 and 7107931-11-6 hash to the same key on the test database; 7009485-11-7 differs), then stages the deterministic FIFO interleave with a controller session holding both resources: on the unfixed tree both create and edit-replace failed red ([500,201] / [500,200], the review's 40P01 reproduction); after the fix both pass with [201,201] / [200,200], exact CAS associations and delta-exact `postCount`s. Observation timeouts fail the test — coverage is never claimed from a race that did not form. The staging is fix-agnostic: post-fix both requests queue on the numerically smallest key first, so the same choreography merely serializes them. Ran green 4 consecutive times.
- **Node engines:** `^22.12.0 || >=24.0.0` → `^22.12.0 || ^24.0.0 || >=26.0.0` (the exact Prisma 7 ∩ Vitest 5 intersection) in `package.json`, `package-lock.json` root metadata and `DEVELOPMENT.md`; the unreleased CHANGELOG 1.2.0 entry updated to match. semver-verified against the actual declared ranges: 22.11 exclude, 22.12 accept, 23 exclude, 24 accept, 25 exclude, 26 accept — project range and toolchain intersection agree on all six. CI `node-version: 22` unchanged. This corrects the engines claim in the previous entry without rewriting it; metadata verification only — no tests were run on Node 22.12/24/26 binaries this round.
- **Release notes (`docs/RELEASE-1.2.0-ACCESS-RETIREMENT.md`):** the compatibility matrix is now conditional (no "current production state" — live binary version unverified); health checks are split into new-version checks (may assert `/mcp` serverInfo 1.2.0) and old-baseline rollback checks (no `/mcp` — its absence is correct rollback behavior); rehearsal evidence regenerated: fresh isolated DB, `prisma migrate deploy` reports "14 migrations found … All migrations have been successfully applied", `_prisma_migrations` holds 14 finished records cross-checked item-by-item against the 14 `migration.sql` files (zero missing/extra), `ApiKey.access` absent post-deploy, legacy `SELECT access` → 42703.
- **Full gates re-run after the fixes (serial):** `npm test` 19 files passed / 1 opt-in skipped, 194 passed / 1 skipped, 0 failed; lint, typecheck, `git diff --check` clean; full `npm audit` and `--omit=dev` both 0; `RUN_PROD_HTTP=1` prod-sitemap HTTP regression 1/1. Production build on an isolated migrated DB + official MCP SDK client: serverInfo 1.2.0, 12 tools verified / 7 read-only for an unverified key, verified write OK, all 6 read tools OK, root-post foreign/bare ancestor cursors rejected (MCP isError, REST 400 parity), invalid notification cursor 400 (valid 200), unverified programmatic write denied, unverified browser member post 201 (browser permissions unchanged).

**Pitfalls / Notes:**
- Sorting lock NAMES (CAS strings) is not sorting lock RESOURCES: any hash-keyed lock set must order by the post-hash key. The staging trick that proves this deterministically relies on PostgreSQL heavyweight-lock FIFO grant order — the earlier-queued waiter wins the released key, which is exactly what turns the collision into a guaranteed cycle pre-fix.
- `pg_locks` exposes single-`int8` advisory keys as (classid = high 32 bits, objid = low 32 bits unsigned): match with `objid = (key::bigint & 4294967295)`.
- The advisory acquisition is deliberately one statement per key (loop order = lock order); do not collapse it back into a single set-returning statement whose row evaluation order the planner owns.
- All throwaway databases, processes, advisory locks and temp scripts from this round were cleaned up (verified: no `cascool%test%` databases, no stray `next` processes, zero advisory locks). Tree remains uncommitted at HEAD eb80957 for the next independent review.

### 2026-10-29 — 1.2.0 Production Release Preflight

**Context:** The accepted 1.2.0 workspace is being prepared for its first production release. Read-only inspection confirmed the running 1.1.7 checkout at `955d7e0` and four finished migration records through `20260710040000_remove_tag_system`; their checksums match the release chain.

**Changes:**
- Recorded the actual release scope: ten pending migrations, including retirement of the old `ApiKey.scopes` representation and the intermediate `access` column. No application compatibility branch is added.
- Production baseline: 134 reposts, 785,129 live posts, three legacy MENTION notifications and six API keys. The migration intentionally removes MENTION rows; surviving key identity metadata must be preserved.
- Release preparation uses a protected production snapshot restored to an isolated server database for migration rehearsal and a native Linux/Node 22.23.3 build, followed by a maintenance window, final recovery snapshot, production migration and process cutover.
- Production Nginx currently aliases `/llms.txt` to a retired static file. The cutover will route it to the dynamic application endpoint and retain direct serving of static assets and uploads.

**Pitfalls / Notes:**
- The inspected production binary predates the access-column baseline and reads `scopes`; applying the pending migration set while it serves would likewise break key authentication. Production schema changes and process replacement therefore share an explicit maintenance window.
- This entry records completed read-only preflight and the release plan; execution outcomes are recorded separately after deployment. Production credentials, database snapshots and uploaded files remain outside Git.

### 2026-10-29 — Fresh-Checkout Upload Fault Fixture

**Context:** The release CI reached all build gates but the filesystem fault-injection test failed before exercising the outbox because a fresh checkout has no gitignored `public/uploads` directory. Existing local upload storage had hidden that test precondition.

**Changes:**
- The API contract fixture creates its upload parent directory recursively before constructing the directory-shaped image fault. The EISDIR/EPERM failure and compensation assertions remain unchanged.

**Pitfalls / Notes:**
- Tests must create their own filesystem prerequisites; production uploads are neither committed nor required as test setup. This changes only the fixture, not application behavior or migrations.

### 2026-10-30 — 1.2.0 Interaction Closure: private media, notification lifecycle, pagination/read contracts, Agent receive loop, hydration root cause

**Context:** Independent closure review of the released v1.2.0 (`3f8d577`) confirmed F01–F08 and G01/G02: verification documents were anonymously readable from `public/uploads`; duplicate/lost-race state changes re-notified; null-postId notifications deduped by a racy findFirst→create; the notifications page marked everything read (including rows it never returned and events arriving after its SELECT); the notification list could not page past the SSR first page; DM threads opened on the oldest 200 messages while marking all received as read; same-millisecond messages were dropped at the poll boundary; the likes list kept soft-deleted posts; ordinary notifications had no durable compensation; and agents had no receive loop. Every fix was written red-first: the review's characterization probes were inverted into correct-behavior regressions, captured red on the published baseline, then turned green.

**Changes:**
- **F01 private verification media** (`src/lib/image.ts`, `src/app/api/media/verification/[filename]/route.ts`, `src/app/api/upload/route.ts`, `src/app/api/account/verification/route.ts`, `src/lib/upload-cleanup.ts`, `PrivateMedia` model): verification purpose writes to `private-uploads/` (outside public/) with the private URL prefix; reads go only through the identity-gated route (anonymous 401, unrelated member 404 with no existence leak, applicant/admin 200, `Cache-Control: private, no-store`, strict UUID filename regex + path containment); upload records ownership so the applicant can preview pre-submission; public references stay confined to `/uploads/` (REST narrowing + zod). One-off migration (`POST /api/admin/verification-media/migrate`, `src/lib/verification-media-migration.ts`: copy → reference update → ref-counted delete, idempotent, interruption-recoverable) rehearsed on an isolated database; NOT executed against production.
- **Notification lifecycle** (`src/lib/notification.ts`, `src/lib/notification-policy.ts`, `src/lib/services/side-effect.service.ts`, follow/interaction/post-write services, message routes): all core notifications are outbox tasks enqueued inside the business transaction (P2002 losers roll their event back with the relation), drained post-commit with a bounded backlog sweep; null-postId dedup is now a partial unique index `(userId, fromId, type) WHERE "postId" IS NULL` with atomic UPSERT everywhere (migration merges pre-existing duplicates to the newest row and repoints `NotificationDelivery` to the survivor); toggle types (LIKE/REPOST/FOLLOW) get a 60-minute recipient-side cooldown enforced inside the same UPSERT (content types always re-surface); retries of old events remain pure no-ops via `NotificationDelivery`; `upsertNotification` (fire-and-forget) is deleted.
- **Read confirmation scope** (`src/lib/services/notify.service.ts`, `BadgeProvider.tsx`, notifications page): `Notification.revision` bumps on every re-surface; page loads mark only returned rows at the revision they observed (stale confirmations miss re-activated rows; post-SELECT arrivals untouched); the badge converges to the server-confirmed remaining count; explicit mark-all stays a separate write-gated endpoint.
- **F04 notifications pagination** (`NotificationList.tsx`): reuses the SWRInfiniteSeed mechanism with a REAL page-0 key (the null page-0 key disabled SWRInfinite's iteration entirely); id-dedupe, cursor-driven pages, verified at 0/30/31/61/same-millisecond rows in a real browser.
- **F06/F07 DM contracts** (`message.service.ts`, `messages/[id]/route.ts`, `send/route.ts`, `MessageThread.tsx`): threads open on the most recent window and mark only returned received messages; incremental polling uses the composite `afterTs`+`afterId` cursor with `hasMore` continuation (old `since` contract retired, no compat branch); send returns the server message identity (id + createdAt) so the optimistic bubble is replaced without clock inference; out-of-order responses are sequence-guarded; failed sends restore the draft; MESSAGE notifications ride the outbox.
- **F08 likes list** (`post-core.service.ts`): `post: { deletedAt: null }` in SQL before pagination — normal lists uniformly exclude soft-deleted posts; tombstones exist only for direct detail access and discussion chains.
- **State convergence (V.3) + shell hydration root cause** (`PostActions.tsx`, `FollowButton.tsx`, `Sidebar.tsx`, `icons.tsx`, `next.config.ts`): the unconfirmed probe observation was chased to TWO real baseline defects. (1) `useState(props 初值)` never converged when fresh server props arrived — both components now sync props→state (guarded against in-flight optimistic toggles). (2) The Sidebar user card nested an `<a>` (Avatar's own Link) inside its Link — invalid HTML made the browser parser restructure the tree, React hydration failed (#418) on EVERY authenticated page, the recovery destroyed SWR's registered event listeners, and focus revalidation was dead app-wide. Fixed at the source (Avatar called with src/username; RepostIcon no longer forwards `filled` as an invalid attribute); `allowedDevOrigins` added so the dev HMR socket (whose failure aborts dev hydration entirely) works from localhost/127.0.0.1.
  - CORRECTION (2026-10-30, independent acceptance): the original claim "Focus→refetch→converge verified in a real browser after the fix" was NOT what the shipped test verified — that test used a hard RELOAD, which any `useState(props)` baseline passes. The production focus chain was later proven WORKING but gated by SWR's `focusThrottleInterval` (5 s): the page-load focus opens the throttle window, so synthetic focus dispatched within it is silently swallowed — every earlier probe (ours and the review's) fired inside the window. The real in-place convergence (no reload) is now verified in `tests/closure.regression.browser.test.ts` with focus dispatched after the window, plus identity-dependent read APIs gained `Cache-Control: private, no-store` (a missing header lets browsers serve revalidations from stale copies).
- **Agent receive loop (G02)** (`src/lib/mcp/tools.ts`): `list_notifications` (read-only, cursor-paged, post-context) and `mark_notifications_read` (write-gated, explicit); `get_profile` exposes `viewerRelationship`; `create_post` accepts an optional `clientRequestId` bound to (caller, key) for 24 h (same key+content replays the original post, same key+different content → 409 `request_key_conflict`, `PostRequestKey` self-cleans); all business errors return structured `structuredContent.error` with stable codes and recovery directions.
- **Attachment lifecycle (VII.1)** (`src/lib/upload-sweep.ts`, `src/app/api/admin/uploads/sweep`): orphan sweep for never-attached uploads after a 24 h grace window with a reference re-check immediately before each unlink; stale `PrivateMedia` ownership rows expire on the same sweep.
- **Docs**: API-BASELINE (message polling contract, notification read semantics, MCP tools 8/14, create_post idempotency) and ARCHITECTURE (notification lifecycle section) updated.
- **Capacity evidence (VII.2)** (`scripts/perf/load.mjs`, scaled `scripts/perf/seed.mjs`): production build on an isolated 20k-post/600-user database, 24-way concurrent phases — served 243–440 req/s (reads p95 71–111 ms, mixed writes p95 75 ms) with zero 5xx, zero pool waits, zero lock waits, RSS ≈ 380 MB; load-time invariants held (denormalized like-count delta exactly preserved over 14.7k like writes, zero duplicate notifications, zero pending outbox tasks). Rate-limited rejections (429) measured separately from served traffic; the per-key limiter remains the throughput ceiling by design. Single machine, localhost, warm cache — not a production projection.

**Pitfalls / Notes:**
- The partial unique index is invisible to `prisma migrate diff` (Prisma cannot express partial indexes); it lives only in the migration SQL. `deliverNotification` arbitrates null-postId upserts through `ON CONFLICT … WHERE "postId" IS NULL` — do not "simplify" it back to the compound constraint.
- `dev` mode: a failed `/_next/hmr` websocket aborts client hydration entirely (pages render SSR-only, zero interactivity — this is what made earlier dev-mode probes appear "not hydrated"). `allowedDevOrigins` in `next.config.ts` fixes it for localhost/127.0.0.1; CI hosts must be listed there.
- The verified media route authorizes via submission reference (applicant/admin) OR `PrivateMedia` ownership (uploader-only, pre-submission preview). `PrivateMedia` is deliberately NOT a cleanup reference: never-submitted attachments are orphans and the sweep removes file + row after the grace window.
- `getConversationThread`'s returned `unreadInConv` is now the count actually MARKED read (badge decrement basis), not the pre-mark total.
- Load harness gotcha: raw API keys shorter than 20 characters silently fall through to anonymous identity (resolveIdentity length gate) — reads appear to "work" anonymously and 429s dominate; use ≥20-char keys.
- Synthetic fixtures only in this round (4×4 color blocks, synthetic usernames); no real documents touched. All throwaway databases dropped, synthetic media removed, no `next` processes left running. Tree remains UNCOMMITTED on top of `3f8d577` (v1.2.0) for independent acceptance.

### 2026-10-30 — Closure acceptance round 2: R1–R10 fixes after independent review

**Context:** Codex's independent acceptance of the first closure round returned NOT PASSED with 9 reproduced flaws (R1–R5 blockers, R6–R10 gaps). Every fix below was written against those reproductions, converted into correct-behavior regressions (`tests/closure.acceptance.regression.test.ts` 14/14, upgraded closeout suite 12/12, browser suite 8/8), and re-gated.

**Changes:**
- **R1 attachment ownership (P1)** (`verification/route.ts`, `media/verification/[filename]/route.ts`): submissions validate BOTH attachments inside the submit transaction against the upload-time `PrivateMedia` anchor (canonical URL shape → ownership row → live file under the per-URL lifecycle lock); filling someone else's URL grants nothing. The READ trust chain inverts: `PrivateMedia` is the single ownership anchor; a submission row (user-authored) can only ADD admin review access, never create or override ownership. Unclaimable, un-takeover-able, preview-safe.
- **R2 atomic idempotency (P1)** (`post-write.service.ts`, `mcp/tools.ts`): request-key arbitration moved INTO the creation transaction — key insert (with TTL cleanup of the same key) → post → counters → CAS → outbox → key→postId binding commit or roll back together. Concurrent losers leave nothing (verified: post count, postCount counter delta, notification tasks). Key expiry (24 h) is enforced at arbitration time, not by opportunistic cleanup. Contracts: same key+content → replay of the committed original (`replayed: true`); same key+different content → `request_key_conflict` (an MCP tool error, NOT an HTTP 409 response — protocol boundary preserved); original deleted → `request_key_post_gone`. Mid-transaction failure rolls everything back (fault-injected).
- **R3 send/receive boundary (P1)** (`MessageThread.tsx`): the send response no longer advances the shared receive boundary — it merges the server identity of OUR message and triggers an immediate in-order drain; incoming messages between the old boundary and our send are delivered by that drain or the next poll, never skipped. Failed-send draft restore only fills an empty draft (user's newer typing always wins).
- **R4 migration closure (P1)** (`verification-media-migration.ts`): rewritten as a reconstructable 3-phase state machine — (A) copy + privatize references + establish trusted `PrivateMedia` ownership for the submission owner; (B) rewrite remaining PUBLIC references (post images removed, avatar/banner nulled — declared product rule: an identity document is never legitimate public content); (C) delete the old public copy under the lifecycle lock once nothing public references it. Historical URLs are untrusted data (canonical name + containment + magic-byte type checks). Completion verdict `publicFaceClosed` is derived from post-state (no leftover /uploads/ submissions, no public copies, no public references); anything open lands in `unresolved` with a machine-readable problem. Rehearsed: full closure, interruption-after-update (rerun reconstructs), shared public references.
- **R5 lifecycle coordination (P2)** (`upload-lifecycle.ts`, `upload-cleanup.ts`, `upload-sweep.ts`, write paths): per-URL `pg_advisory_xact_lock(hashtext(url))` held across (deletion: final reference check + unlink) and (reference write: availability assertion + write) — mutually exclusive by construction, no grace-window or re-check race. Reference writes: createPost, editPost, verification submit, profile avatar/banner. Real unlink failures (EACCES/EIO) propagate as errors (task stays pending / sweep records an error); only ENOENT means "already gone". Verified with a genuine interleaving (locked write blocked mid-sweep, then rejected asset_gone) and a permission-failure rehearsal.
- **R6 production focus chain (closed)**: root cause of the "inert focus revalidation" was SWR's `focusThrottleInterval` (5 s) swallowing every synthetic focus fired within the window opened by the page-load focus — not an SDK break. Verified in the production build: refetch fires after the window → new props arrive (`Cache-Control: private, no-store` added to identity-dependent read APIs so browsers can't serve stale copies) → the SAME PostActions instance converges in place (like and UNLIKE both). Lost-update fix: props arriving while an interaction is pending are HELD (refs not advanced) and applied when it settles; one pending interaction can't swallow other controls' changes; identity change on a reused instance resets state from props.
- **R7 DM history paging** (`messages/[id]/route.ts`, `MessageThread.tsx`): `beforeTs`/`beforeId` composite-boundary history pages (same ordering as the incremental path) + scroll-to-top loading in the thread UI with scroll-position preservation. Walked 245 fixture messages back to #1 with zero gaps/repeats; received history messages enter the read scope when actually returned.
- **R8 page-read ack** (`notifications/ack/route.ts`, notify serialization, `NotificationList.tsx`): notifications now serialize `revision`; each displayed non-SSR page is confirmed via `POST /api/notifications/ack` with per-object `(id, revision)` guards (stale confirmations can't clear re-activated rows; foreign rows ignored); the badge converges to the server-confirmed remaining count. REST/MCP list reads stay side-effect-free; explicit mark-all remains separate.
- **R9 capacity evidence** (`scripts/perf/load.mjs`): the original `hotLikeDeltaPreserved:false` was a HARNESS sampling flaw — baseline Like rows were hardcoded 0 while prior runs had added rows (diagnosis preserved in the report alongside the frozen log). Rewritten harness: DB-read baselines, per-operation counters (like/unlike/create/notify/read/retry counted separately — no more "200s = writes"), REAL like→unlike round-trips (432) and a real retry phase, network errors vs 5xx vs failure rate, TTFB vs full-body percentiles, continuous in-phase pg_stat_activity wait sampling (lock waits distinguished), invariant failure ⇒ exit 1, synthetic-identity disclosure (100 identities × 8 keys — exceeds the 5-key product limit; a rate-bucket fan-out experiment, not user capacity). Rerun: ALL INVARIANTS HELD (like-delta exactly preserved, post rows == counter sum delta, 0 duplicate notifications, 0 pending outbox, 0 5xx, 0 net errors; peak lock-waiting 9 during the like-heavy phase reported honestly).
- **R10 agent contract** (`mcp/tools.ts`, `llms.txt/route.ts`, side-effect service): every business tool error is now structured (`structuredContent.error{code,message,recovery}` — including invalid arguments, invalid cursors, permission, not-found; internal exceptions stay scrubbed with an error ID; MCP protocol errors untouched). COMMENT notifications carry `replyShortCode` (the actual new reply), consumed by the web row link and the MCP inbox; the official-client task now runs receive → locate THE reply → read its anchored context → counter-reply → receive and verify that, without scanning parent reply pages. Outbox progress no longer requires a new event: `drainEnqueuedSideEffects` performs a throttled (30 s/process) bounded check+drain on committed backlogs even when the current request enqueued nothing. `/llms.txt` lists all 14 tools, the idempotent-retry recovery flow, structured error codes and the new endpoints.

**Pitfalls / Notes:**
- R2's arbitration lives in the SHARED write service (`createPost`), not the MCP layer — REST gains the same atomicity when it passes `idempotency`. The `PENDING_KEY_MARKER` sentinel is bound to the real postId inside the same transaction; do not split them.
- The advisory lock is per-URL and transaction-scoped: reference-write transactions MUST acquire it before their availability stat (order in `assertUploadAssetsAvailable`), and deletions must do check+unlink inside one transaction. Re-ordering reintroduces the race.
- Reference writes now REJECT references to missing files (`409 asset_gone`) — a fixture referencing a non-existent `/uploads/x.webp` fails; tests must create real files (the contract suite's fault fixture was updated to replace its seeded file with the directory-shaped fault).
- `getNotificationsPage` and the first-page fetcher both serialize `revision` + `replyShortCode` — the ack path and reply-locating links depend on them; don't trim the serialization.
- Synthetic materials only (color blocks, synthetic users/keys); no real documents. All throwaway databases dropped, upload fixtures removed, no `next` processes left. Tree remains UNCOMMITTED on top of `3f8d577` for the next independent acceptance.

---

### 2026-10-30 — Post-R2 Closure Correctness & Lifecycle Coordination

**Context:** Codex Round 2 independent review confirmed five correctness defects and one test evidence gap: (1) advisory asset locks deadlocked on opposed URL arrays (`[A, B]` vs `[B, A]`) and accepted alias URLs (`/uploads/../uploads/...`) deleting valid files; (2) verification media migration committed reference updates before private media anchors were durable, producing unanchored files falsely reported as `publicFaceClosed: true`; (3) idempotent replay check ordering rejected valid replays of surviving replies or quotes when their parent or quoted post had been soft-deleted; (4) message history pagination permanently disabled paging (`setHasMoreHistory(false)`) on transient HTTP 429/500 errors; (5) pending state convergence tests relied on fixed sleep timings rather than deterministic in-flight interleaving.

**Changes:**
- **Unified asset lifecycle & lock ordering (`src/lib/upload-lifecycle.ts`, `src/lib/upload-cleanup.ts`, `src/lib/upload-sweep.ts`, write paths):**
  - Unified URL parsing (`parseUploadUrl`) enforcing canonical `/uploads/[a-f0-9-]{36}\.[a-z0-9]+` grammar, path containment within `UPLOAD_DIR`, and rejection of traversal aliases (`..`, encoded variants) with 400 `bad_request`.
  - Replaced ad-hoc URL string sorting with strict numeric ascending ordering over deduplicated 32-bit PostgreSQL advisory lock keys (`pg_advisory_xact_lock(0x55504c44, hashtext(canonicalUrl))`). Two-key advisory locks run in `objsubid = 2`, preventing collisions with 64-bit chemical advisory locks (`objsubid = 1`).
  - Unified asset existence assertion across `createPost`, `editPost`, profile avatar/banner updates (`/api/me/profile`), and verification submissions (`/api/account/verification`), raising uniform `PostServiceError` (bad_request / asset_gone) and releasing locks atomically on transaction finish.
- **Migration transactional anchor atomicity & post-state criteria (`src/lib/verification-media-migration.ts`):**
  - Grouped `PrivateMedia.upsert` and `VerificationSubmission.update` in a single database transaction. Foreign anchor conflict aborts the transaction without mutating submission references. Zero runtime mock detection in application code: test fault injection wraps `$transaction` to execute actual writes before triggering rollback, asserting atomic rollback and complete recovery on rerun.
  - Added self-healing recovery for pre-existing partial migration states: detects unambiguous orphaned private files belonging to the submission owner and binds them to trusted `PrivateMedia` anchors on rerun.
  - Post-state verdict (`publicFaceClosed`) directly evaluates ground truth: verifies private media file existence, valid `PrivateMedia` ownership record, submission reference update, and absence of public copies or unmigrated public references. Reports unresolved status on any discrepancy.
- **Idempotent replay check ordering (`src/lib/services/post-write.service.ts`):**
  - Reordered creation flow so request-key arbitration runs first inside the transaction. On P2002 conflict on `(userId, requestId)`, immediately retrieves and replays the committed post without failing on subsequently soft-deleted parent or quote posts.
  - Retained strict live parent and quote assertions for fresh post creation, preserving `request_key_post_gone` contract when the committed original post is soft-deleted.
- **Message history paging error recovery (`src/components/messages/MessageThread.tsx`, `src/lib/api-client.ts`, `tests/closure.regression.browser.test.ts`):**
  - In `loadOlderHistory`, transient HTTP errors (`!result.ok`) preserve `hasMoreHistory(true)` and the current cursor boundary.
  - Added HTTP 429 `Retry-After` parsing and cooldown backoff (`retryUntilRef.current`), preventing spin-looping while allowing smooth retry on subsequent user scroll.
  - Deduplicated prepended messages by id to guarantee zero duplicates or gaps across retried loads.
  - Parameterized browser tests covering both 429 and 500 failure injection: proves exact cursor parameter reuse (`beforeTs`/`beforeId`), verifies Retry-After cooling period under 429, and confirms message continuity with zero duplicates.
- **Pending state test evidence & browser regression (`tests/closure.regression.browser.test.ts`):**
  - Deterministic Playwright route barrier holding like interaction in-flight while concurrent server props arrive via focus revalidation.
  - Deterministically observes that new props (`replies: 1`) commit to the same component in the DOM before releasing the barrier, while asserting that the like button remains in pending/disabled state; releases the write barrier, waits for write completion and button re-enablement, and asserts final converged state without arbitrary timeout heuristics or remounts.
- **Focused test suite (`tests/closure.r2.focused.regression.test.ts`):**
  - Converted review characterization probes into permanent regression tests:
    - Reversed asset array concurrency: barrier placed before first lock to prevent test self-deadlock, recording executed lock keys to assert identical numerically ascending sequences.
    - Duplicate asset URLs: asserts actual lock acquisition count is exactly 1 rather than redundant locks.
    - Path traversal alias rejection and reference protection.
    - Transactional migration rollback and self-healing recovery.
    - Soft-deleted parent and quote idempotent replay.

**Pitfalls / Notes:**
- PostgreSQL advisory locks in `(class::int4, key::int4)` form use a distinct namespace from single `int8` locks; `0x55504c44` ('UPLD') is strictly partitioned from chemical advisory keys.
- Sorting lock keys must be performed on the signed 32-bit hash value, not on URL strings, to prevent hash-order inversions.
- Testing lock ordering under concurrency requires placing arrival barriers before the first lock acquisition: placing a barrier after the first lock on sorted keys causes test self-deadlock because both transactions contend for the same minimum key.
- All temporary test databases, advisory locks, and node processes were verified clean. Working tree remains uncommitted on `main` for Codex final acceptance.

### 2026-10-30 — Public Copy, SEO/GEO & REST Integration Governance

**Context:** Public-facing copy, SEO metadata, Schema.org structured data, robots crawling directives, and developer access guides contained discrepancies and unconfirmed indexing exclusions: application self-added `noindex` was placed on public user and chemical pages; robots.txt enumerated personal user paths; `SocialMediaPosting` lacked complete post text and used truncated headlines; `ChemicalSubstance` mounted non-standard `smiles`, `commentCount`, or `interactionStatistic` properties; `llms.txt` promised a nonexistent `retryAfterSec` JSON response, leaked internal implementation details, and lacked task-oriented organization; sitemaps imposed unconfirmed product exclusions on registered entities; and the API key page lacked direct REST API guidance.

**Changes:**
- **Material & Report Cleanup:** Removed historical Codex review/instruction markdown files from `/tmp`; cleaned temporary file path references from `DEVLOG.md`.
- **Public Copy & UI English Quality:** Realigned `about.description` to define the product as a global chemical trade social network; added English strings for REST API integration instructions; labeled API Key documentation link as "API and MCP guide".
- **Robots Directives & Discovery:** Cleaned personal feature path enumeration (`/settings`, `/messages`, `/notifications`, `/bookmarks`, `/compose`) from `src/app/robots.ts`, keeping concise crawl rules (`allow: /`, `disallow: /api/`) and real sitemap addresses while relying on server-side authentication for personal paths.
- **Sitemap Scope Realignment:** Cleaned unconfirmed product exclusions from sitemaps (`postCount: { gt: 0 }` and `banned: false` in `cas/sitemap.ts`; `status: 'active'` in `u/sitemap.ts`). Updated `docs/ARCHITECTURE.md` and `tests/api.contract.test.ts` to reflect that all registered chemicals and users up to the 50,000 cap are indexed.
- **SEO, Metadata & Indexing Invariants:** Removed self-added `noindex` and `none` from public user profiles (`u/[username]`), chemical pages (`cas/[casNumber]`), and `not-found.tsx`; verified canonical URLs point to distinct canonical addresses.
- **Schema.org Structured Data Correction:**
  - `SocialMediaPosting` (`p/[code]`): emits full page-visible `text`, `image` with absolute origin URLs, `datePublished`, and `dateModified` bound to `editedAt`; omitted headline on untitled posts.
  - `ChemicalSubstance` (`cas/[casNumber]`): removed non-standard `smiles`, `commentCount`, and `interactionStatistic`; emits valid `hasRepresentation` for SMILES, identifier, name, url, and description. Existing post count display in the page UI HTML stats bar is retained.
- **llms.txt Task-Oriented Reorganization:** Structured into 5 user-facing sections (Connecting, Reading, Posting & Interactions, Receiving Notifications, Error Handling & Recovery); moved internal implementation details (password rules, cookie fallback, bucket key syntax, transaction arbitration internals) back to internal materials; expressed public rate limits using request quotas and HTTP 429 `Retry-After` header; described `/api/search` as "Search posts by text or CAS number (verified members)."
- **API Key REST Guidance:** Extended `ApiKeysClient` with a dedicated REST API integration card, documenting shared key model, dynamic capability derivation, `Authorization: Bearer YOUR_API_KEY` header, curl example with placeholder credentials, and direct link to `/llms.txt`.
- **Automated Verification:** Added `tests/seo-geo-guidance.test.ts` covering static governance and live HTTP output assertions for robots.txt, llms.txt, CAS JSON-LD, Post JSON-LD, and sitemaps.

**Pitfalls / Notes:**
- Schema.org `ChemicalSubstance` does not define `interactionStatistic` or `commentCount`; interaction counts belong to the social page presentation rather than the chemical compound entity. SMILES uses `hasRepresentation`.
- Sitemaps index public pages up to the 50,000 capacity boundary without arbitrary filtering of banned or low-activity entities, as those entities render valid HTTP 200 public pages with appropriate status notices.
- Robots.txt should not enumerate authenticated personal endpoints (`/messages`, `/settings`); server-side authentication handles access control cleanly without leaking private paths.

---

### 2026-10-30 — Site Profile Centralization, Full English i18n Collection & Post SEO Test Correction

**Context:** Site profile presentation (tagline, description, product intro) was fragmented across the About page, TimelineTopBar, auth pages, and metadata. Administration lacked a public profile editor for SiteConfig row 1 fields. Front-end and admin UI components had lingering hardcoded English/Chinese strings, unlocalized aria-labels/counts, and un-parameterized status messages. Additionally, `tests/seo-geo-guidance.test.ts` post fixture creation accessed `postData.post.shortCode` rather than top-level `postData.shortCode`, causing post SEO assertion blocks to return early without asserting.

**Changes:**
- **Site Profile Unification (`src/app/(shell)/about/page.tsx`, `src/components/posts/TimelineTopBar.tsx`, `src/app/(auth)/login/page.tsx`, `src/app/(auth)/register/page.tsx`, `src/lib/site.ts`, `src/lib/version.ts`):**
  - Standardized product introduction and tagline usage: About page and home guest banner strictly render `site.description` and `site.tagline` from `SiteConfig` row 1 (`getSiteConfig()` / `useSite()`).
  - Login and registration pages utilize parameterized `site.name` interpolation (`t.auth.signInTo(site.name)`, `t.auth.join(site.name)`, `t.auth.welcomeTo(site.name)`).
  - Removed deprecated / duplicate constants including `GITHUB_URL` in `src/lib/version.ts`, `seo.homeDescription`, and `t.about.description`.
  - Added Next.js 16 cache revalidation tags to `getSiteConfig()` (`tags: ['site-config']`) and exported `revalidateSiteConfig()` invoking `revalidateTag('site-config', 'max')` and `revalidatePath('/', 'layout')`.
- **Admin Site Profile Management (`src/app/api/admin/site/route.ts`, `src/app/(shell)/admin/site/page.tsx`, `src/app/(shell)/admin/AdminTabs.tsx`):**
  - Added `/api/admin/site` endpoint supporting `GET` (`requireAdmin('read')`) and `PATCH` (`requireAdmin('write')`) with rate limiting and strict payload validation (`name`, `shortName`, `tagline`, `description`, optional `githubUrl`, optional `analyticsId`). Fixed mutation target to `SiteConfig` row 1 with immediate cache invalidation via `revalidateSiteConfig()`.
  - Built `/admin/site` administration page in the admin shell, exposing live editing for public site profile fields and displaying read-only deployment parameters (`origin`, `keyPrefix`). Established explicit `htmlFor`/`id` associations on all 6 editable input fields (`site-name`, `site-short-name`, `site-tagline`, `site-description`, `site-github-url`, `site-analytics-id`).
- **Comprehensive Front/Back-End i18n Collection (`src/lib/i18n/en.ts` and components):**
  - Collected and parameterized all user-facing strings across `TimelineTopBar`, auth pages, `ProfileLogoutButton`, `MobileReplyBar`, `ReplyBox`, `PostDetailClient`, `PostCard`, error pages (`src/app/error.tsx`, `src/app/(shell)/error.tsx`, `src/app/global-error.tsx`, `src/app/not-found.tsx`), `VerificationPanel`, `ApiKeysClient`, user profile, CAS page, Explore page, `RightPanel`, `ConversationList`, `ImageModal`, and `ShareButton` (replacing Chinese `'微博'` with `'Weibo'`).
  - Consolidated duplicate `postsCount` dictionaries into `t.common.postsCount`, preserving true count pluralization while restoring compact number formatting (`formatNumber`) on the profile page and full comma-delimited counts on CAS/Explore/Admin pages.
  - Centralized chemical status tokens (`Restricted` in `ChemicalInfo`), `SMILES available`, CAS metadata descriptions (`t.cas.*`), relative time formatting tokens (`t.time.*` via `timeAgo`), and user-visible SiteConfig API validation messages (`t.admin.siteProfile.validation.*`).
  - Localized admin views (`/admin/users`, `/admin/reports`, `/admin/verifications`) with mapped status enums, parameterized messages (`t.admin.statusChangedTo`, `t.admin.handledBy`, `t.admin.approvedOn`, `t.admin.rejectedOn`), and pluralized counters.
- **Post SEO Fixture Correction & Site Identity Test Reinforcement (`tests/seo-geo-guidance.test.ts`, `tests/site-config.test.ts`):**
  - Fixed post creation fixture to read top-level `postData.shortCode` and assert HTTP 201.
  - In `SocialMediaPosting` test: asserted full post text, absence of headline on untitled post, valid `datePublished`, and initial undefined `dateModified`.
  - Executed real authenticated PATCH `/api/posts/:code` edit to verify full edited text, `dateModified` matching `editedAt`, and immutable `datePublished`.
  - Added test coverage in `tests/site-config.test.ts`:
    - Playwright form test using `getByLabel` across all 6 input fields, executing live field input and saving via form submit.
    - Cache propagation flow: pre-warming server caches (`/about`, `/`, `/llms.txt`, `/manifest.webmanifest`), saving via admin, and asserting immediate same-process first-read update across all 4 surfaces.
    - Verified authentication boundaries (401 anon, 403 member) and input validation (400).

**Pitfalls / Notes:**
- Next.js 16 requires `revalidateTag(tag, 'max')` within active route handler contexts; omitting `'max'` triggers deprecation warnings.
- In `adminAccessError()`, write access (`access === 'write'`) requires both `role: 'admin'` and verified standing (`verificationStatus: 'verified'`). Test fixtures must promote test users with both flags.
- All modifications remain uncommitted in the working tree for Codex independent review.

### 2026-10-30 — Responsive Home Branding and White Canvas

**Context:** The home header duplicated the sidebar logo on desktop, and the page canvas used a light gray background. CAS JSON-LD still duplicated description text already collected in the English dictionary.

**Changes:**
- Aligned the home brand header with the sidebar's `md` breakpoint: the header appears below 768px and yields to the sidebar at larger widths.
- Changed the shared `canvas` design token to white; retained surface interaction colors, borders and semantic accents.
- Reused the existing CAS dictionary functions for the JSON-LD description.

**Pitfalls / Notes:**
- Keep the home header and sidebar visibility complementary at the same breakpoint, including the header's occupied space.

### 2026-10-30 — Runtime Closure and Deployment Boundary

**Context:** Independent review reproduced stale reply notification targets, ownership expiry racing verification submissions, missing read-traffic outbox recovery, invalid ack revisions reaching PostgreSQL, and weaknesses in test cleanup and load validation.

**Changes:**
- Added `Notification.replyPostId` in the unpublished closure schema migration to identify the current reply independently of the original event stamp and delivery dedup records.
- Serialized private ownership expiry and submission validation with the same asset locks; reference checks reuse the cleanup transaction connection.
- Scheduled throttled, bounded outbox recovery after feed/notification GET and authenticated MCP responses through Next.js `after()`.
- Validated complete notification ack batches and PostgreSQL integer bounds before writes.
- Limited attachment fixture cleanup to owned filenames; repaired the lifecycle concurrency fixture and observed real PostgreSQL lock waiting; corrected the load counter invariant and added arithmetic regressions.
- Removed the one-time legacy attachment migration route, runtime module and associated application rehearsals. Legacy file handling belongs to the deployment window; normal private uploads, authorization and orphan cleanup remain application behavior.

**Pitfalls / Notes:**
- Asset locks precede ownership reads and deletion checks; acquire the transaction's complete asset set in canonical resource order.
- An old delivery retry must leave the current reply pointer, revision and read state untouched.
- Deployment must preserve and back up private storage and close legacy public attachment URLs before writes resume.
- Validation: `RUN_PROD_HTTP=1 npm test` passed all 273 cases across 28 files, including production browser and sitemap HTTP suites; lint, typecheck and diff checks passed. A separate private-directory marker survived the complete suite, and the production route manifest excludes the retired migration endpoint.

### 2026-10-30 — Browser Regression CI Prerequisites

**Context:** The closure suite includes real Chromium interactions, while CI previously prepared only Node.js and PostgreSQL.

**Changes:**
- Install Playwright Chromium and its Linux system dependencies before running the CI test suite.

**Pitfalls / Notes:**
- Use the repository's pinned Playwright CLI so browser binaries match the installed package.

### 2026-10-30 — Keep Browser Acceptance in Development

**Context:** Development browser acceptance had been included in the routine test suite, adding Chromium installation and a second production build to CI.

**Changes:**
- Removed the dedicated closure browser suite, its production-server helper and the site-profile browser form case from the repository.
- Removed Chromium installation from CI; retained unit and API regressions and the separately opt-in sitemap HTTP check.

**Pitfalls / Notes:**
- Browser acceptance remains a development activity; routine CI builds the application once.

### 2026-10-31 — 1.2.1: follow-recommendation removal, sitemap shard result reuse, brand bar breakpoint

**Context:** The "Who to Follow" right-panel block cost a ranked user query on every logged-in page load for little value; the post sitemap shard route is a dynamic route handler, so its `revalidate = 3600` never engaged Next's ISR cache and every shard hit re-counted and re-read up to 50,000 posts (~7.5 MB XML per request); the home brand bar hid at `md` while the sidebar wordmark only appeared at `xl`, leaving 768–1279px without full brand text.

**Changes:**
- Removed the follow-suggestion capability end to end: RightPanel block/props, ShellLayout wiring, `getFollowSuggestions`, `getSidebarData`/`SidebarData` (no remaining callers), and the `whoToFollow`/`noSuggestions`/`findMorePeople` dictionary entries. `ProfileCard` (Explore people results), `FollowButton`, follow APIs and counters unchanged.
- New `src/lib/services/sitemap.service.ts`: per-(origin, index) shard XML cache with 1 h TTL in a byte/entry-bounded LRU (48 MiB / 64 entries, state on globalThis like the prisma client), single-flight coalescing, ≤2 parallel generations (slot semaphore, released in `finally`), live-post count cached 5 s and shared by `robots.txt` (same `deletedAt: null` rule), generation streamed in 10k cursor-forward batches of the identical `(createdAt desc, id desc)` skip/take window. Route keeps the 404/empty edge contracts and reports `x-sitemap-cache: hit|miss|empty`; the dead `revalidate` export is gone. `src/lib/sitemap.ts` gained `formatUrlRow`/`joinUrlsetXml`/`EMPTY_URLSET` (output byte-identical) and stays DB/Next-free; unit tests for the cache semantics live in `src/lib/services/sitemap.service.test.ts` with mocked DB/site.
- Home page brand bar: `md:hidden` → `xl:hidden` (visible below 1280px, complementing the sidebar wordmark at xl); avatar menu and bottom nav keep their mobile breakpoints.
- Version 1.2.1 across package.json, package-lock.json (top + packages[""]), VERSION, src/lib/version.ts; CHANGELOG 1.2.1 entry and header note refreshed; ARCHITECTURE/API-BASELINE sitemap contract text synced.

**Pitfalls / Notes:**
- Next 16 route handlers with dynamic params never enter the ISR cache regardless of `revalidate` — cache claims must be verified against actual request behavior, not config exports.
- The shard cache lives on globalThis because Turbopack can re-instantiate modules per route segment (same reason the prisma client is global-cached); otherwise robots and the route would hold separate counts.
- Origin changes invalidate via cache key (entries record the origin they were generated with); after `revalidateSiteConfig()` revalidates the data cache, new keys miss and regenerate — never serving the old domain persistently.
- Publish/edit/delete paths deliberately touch nothing: freshness is TTL-window only (shards 1 h, count 5 s, robots ISR 1 h), so posting stays O(1).

### 2026-10-31 — 1.2.1 closeout round 2: two-tier sitemap shard cache, non-blocking count, Age header

**Context:** Reviewer reproduction of three issues in round 1: a ~16-shard working set thrashed the 48 MiB in-process cap (two full miss rounds per sweep); every request still gated on the live-post COUNT before its cache lookup (a lapsed 5 s window blocked a valid hit on a recount, and a count failure failed the request); and responses re-advertised a full `max-age=3600` regardless of source-side age, so end-to-end freshness could reach ~2 h.

**Changes:**
- Two-tier reuse in `src/lib/services/sitemap.service.ts`: the memory LRU (48 MiB / 64 entries, unchanged) is now backed by a disk tier — XML atomically published (tmp + rename) under `.next/cache/sitemap-shards/<origin-hash>/` (relocatable via `SITEMAP_CACHE_DIR`), filenames `shard-<index>-<storedAtMs>.xml` so freshness never depends on mtimes. Bounded pruning after publishes: TTL-expired files, superseded versions per index, orphaned tmp files, 64-file cap (oldest first). Evicted-from-memory shards are re-served from disk without re-querying; single-flight now covers read-or-generate; the ≤2-generation semaphore is unchanged.
- Cache hits never touch the DB: a fresh count range-gates the hit (shard removal still converges within the 5 s window); a lapsed window triggers a background count refresh (backoff-limited to one attempt per window — no periodic scanner, no per-hit retry storm) while the valid XML is returned immediately. Count failures are logged and never discard cached results; only the miss path (which must range-gate) and robots.txt await the count.
- `Age` correctness: results carry `ageSeconds` since their generation stamp (memory entry or disk filename) and the route emits it as `Age`, so downstream caches derive the remaining hour. Near-expiry responses no longer grant a fresh full hour (unit- and HTTP-verified).
- Docs/tests: ARCHITECTURE/API-BASELINE describe the two tiers, caps, honest reuse/eviction behavior and Age; the "dynamic params never ISR" phrasing was narrowed to this route's actually measured Next 16.4.3 behavior. Unit tests cover disk reuse after memory eviction/reset, count-lapsed hot hits, background-refresh failure backoff, the fresh-count shrink gate and Age at 3,590 s; the API contract gained an Age/`x-sitemap-cache` regression.

**Pitfalls / Notes:**
- Tier-2 freshness keys off the filename stamp, not mtime — mtime-based TTL breaks under test clocks and after file copies.
- The cache root is resolved once per request and threaded through read/publish/prune, so an env relocation cannot split a request's read/write pair across two roots.
- Disk-tier unit tests need iteration-bounded waits (fake clock makes wall-clock deadlines loop forever) and an afterEach settle+retry cleanup: publishes are fire-and-forget by design.
- Working-set probe (16 full shards, throwaway DB, production build) stays out of the repo/CI by design; it is a development-time activity.

### 2026-10-31 — 1.2.1 closeout round 3: cold generation task owns its publish

**Context:** Round 2 published tier-2 shards fire-and-forget: the generation slot was released when the rows finished (not after the publish), so publishes drifted outside the ≤2 bound, and the single-flight record was cleared when the response returned — an L1 eviction before the first publish completed started a duplicate generation and re-query. Cold responses also reported `Age: 0` even though the publish wait had consumed time.

**Changes:**
- `src/lib/services/sitemap.service.ts`: one generation slot now spans the whole cold task — rows → memory store → atomic disk publish (tmp + rename) → bounded cleanup — released in `finally` only after the publish ends; `generateShard` became a pure rows→XML helper (slot ownership moved to the task). The per-key in-flight record lives until the publish or its failure handling completes, so same-key requests arriving after an L1 eviction join the running task instead of regenerating. The memory result is stored before the publish, keeping it servable when the disk write fails; no queue, scheduler or resident task was added — everything is awaited inline.
- Cold `ageSeconds` is computed after the awaited publish, so the returned `Age` reflects actually consumed time including the write wait.
- Tests (`sitemap.service.test.ts`): a test-layer write barrier (mocked `node:fs/promises` writeFile with a deterministic gate + failure switch) pins the lifecycle — slow writes hold cold-task concurrency to exactly 2 slot-spanning tasks; a same-key request after a full memory reset mid-publish coalesces onto the running task with no extra query; a failed publish keeps serving the memory result and releases both the slot and the single-flight record (verified by regeneration retry and two gated fresh tasks both reaching their publish).
- ARCHITECTURE sitemap bullet updated to state the slot scope, the publish-complete single-flight lifetime and the publish-inclusive Age.

**Pitfalls / Notes:**
- The write barrier must be a plain function inside the `vi.mock` factory: `vi.resetAllMocks()` must not strip it, and gate/failure state lives in `vi.hoisted` objects reset per test.
- Awaiting the publish inside the request is deliberate: it is the price of the bounded lifecycle, and it shows up in `Age` rather than being hidden.
- The big-shard disk-tier unit test got slower (each request now waits out its 7.2 MB publish); kept at 7 full-size shards since the byte-cap eviction path needs real sizes.
