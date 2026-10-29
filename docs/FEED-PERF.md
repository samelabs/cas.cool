# Feed Performance Baseline — 2026-10-27

Evidence from the "measure first" mandate: a seed database at production
scale, a production `next build` + `next start` server, sequential
(Twitter-mobile-style) HTTP, real `EXPLAIN (ANALYZE, BUFFERS)` plans, and
per-request SQL statement counts from PostgreSQL's own log. Nothing here was
tuned by intuition; the single index change in this batch is backed by the
buffers numbers below.

## Environment & scale

- Benchmark environment: Node.js 22+, PostgreSQL 16, Next.js 16 production server (`next start`).
- Seed database `cascool_perf`: **792,000 live posts** (620k roots + 180k
  replies; 1 % soft-deleted), 20,000 users, ~600k follow edges, 5,000
  chemicals, ~250k post↔chemical links, 100,708 posts inside the 30-day
  ranking window, 3,672 in the last 6 hours. Engagement counts zipf-skewed.
  Seed tooling: `scripts/perf/seed.mjs` (deterministic shortCodes, chunked
  SQL inserts, `ANALYZE` at the end).
- Measurement: `scripts/perf/measure.mjs` — 10 warmup requests, then 120
  sequential requests per scenario, each keyed API request under its own
  API key (= its own 120/min rate bucket); warmup uses its own key, and the
  anonymous run shares the IP bucket and is capped at 80. Server RSS
  sampled per request.
- Limitations: single local machine, no network hop (localhost), warm OS
  page cache after the first pass; p50/p95 of the fast scenarios carry
  ±5–10 ms noise between runs. The for-you improvement (4×+) and the
  buffers counts are far outside that noise band.

## Latency (production server, sequential requests)

| Scenario | p50 before | p95 before | p50 after | p95 after |
|---|---|---|---|---|
| latest (dedup window), keyed | 12.9 ms | 15.4 ms | 13.2 ms | 25.4 ms |
| latest page 2 (cursor) | 13.1 ms | 17.0 ms | 18.2 ms | 46.5 ms |
| following (40 follows) | 16.2 ms | 32.6 ms | 18.5 ms | 31.7 ms |
| **for-you (ranked), keyed** | **297.5 ms** | **734.3 ms** | **69.8 ms** | **100.3 ms** |
| **for-you, anonymous** | **287.4 ms** | **496.9 ms** | **65.4 ms** | **136.5 ms** |
| post detail by shortCode | 17.8 ms | 105.0 ms | 10.9 ms | 15.7 ms |

"after" = with migration `20261027200000_post_feed_rank_covering_index`
(same code, same seed, same build procedure; the index is the only change).
Average response payload ≈ 21 KB per feed page (20 posts), 1.1 KB for
detail. Server RSS stayed **34–65 MB** across all scenarios.

## SQL statements per request (PostgreSQL log_statement, single request)

| Endpoint | statements | breakdown |
|---|---|---|
| GET /api/posts (latest) | 16 | 3 auth (key→user→lastUsedAt) + 1 candidate window + 12 hydration (posts, authors, chemicals, viewer like/repost/bookmark ×2 layers) |
| GET /api/posts (following) | 15 | same shape; candidate window carries the EXISTS follow predicate |
| GET /api/posts (foryou) | 16 | 3 auth + 1 raw ranking query + 12 hydration |
| GET /api/posts/:code | 15 | 3 auth + detail include tree |

Known noise: when a page contains no quoted posts, Prisma still emits one
`SELECT … WHERE id IN (NULL×N)` for `quotedPost` (~0.3 ms, index-only miss).
Not worth hand-rolling hydration to remove.

## EXPLAIN (ANALYZE, BUFFERS) — where the cost actually was

- **For-you ranking (the 300 ms outlier).** The raw ranking query filtered
  the 30-day window via `Post_createdAt_idx` (bitmap scan, 100,691 rows) and
  then read **10,012 heap blocks** to compute the score expression —
  30,459 buffer reads cold, 1,699 ms cold SQL, ~300 ms warm p50. The
  computed `ORDER BY` cannot be indexed; the heap reads were the cost.
  The `Follow` sub-plan was already perfect (index-only, 40 rows).
- **Fix (this batch):** partial covering index
  `Post_feedRank_cover_idx ON Post (createdAt DESC) INCLUDE (likeCount,
  repostCount, replyCount, bookmarkCount, authorId, id) WHERE parentId IS
  NULL AND deletedAt IS NULL` → plan becomes a parallel **index-only scan**:
  677 buffers, 50 ms cold SQL, **70 ms p50 / 100 ms p95 over HTTP**.
  Cost: 39 MB at 792k posts; one extra index entry per post create. Counter
  changes prevent HOT updates and maintain index entries — the measured
  write cost follows.

## Interaction write cost — covering index priced (2026-10-28)

`scripts/perf/write-cost.mjs` replays the exact interaction transactions
(op + undo per cycle) as raw SQL against `cascool_perf`, 1,500 cycles per
interaction, single sequential connection:

| Interaction (op+undo) | with index ops/s · p50 · p95 | without index ops/s · p50 · p95 |
|---|---|---|
| like | 348 · 2.5 ms · 4.8 ms | 414 · 2.1 ms · 4.4 ms |
| bookmark | 309 · 2.7 ms · 5.5 ms | 440 · 2.1 ms · 3.8 ms |
| reply (create + soft-delete) | 205 · 3.7 ms · 7.9 ms | 182 · 4.5 ms · 10.9 ms |
| repost (dual record + undo) | 261 · 3.5 ms · 5.6 ms | 175 · 5.0 ms · 10.4 ms |
| **WAL per cycle** | **17.5 KB** | **4.5 KB** |
| Index growth | observed during run; page-level size | — |

Reading: the counter columns in `INCLUDE` make every like/bookmark/repost/
reply counter bump a non-HOT update that also maintains the index entry —
hence **4× WAL per cycle**. Without the index, the pure like/bookmark
benchmark ran 19–42 % faster. The reply/repost inversion between runs is
inside this machine's noise band; treat those two rows as "no significant
difference". Relation size is allocated in pages, so the observed index
growth does not give a reliable per-interaction byte cost.

**Decision — keep the index.** Absolute write cost stays ≤5 ms p50 and
≥205 cycles/s on a single connection. The API caps each identity at
60 writes/min, but aggregate traffic across identities can still make
index maintenance material. The read side gains
4.3× on the default timeline tab. The WAL multiplier is the real trade-off:
monitor WAL/archive volume if interaction rates ever grow by orders of
magnitude, and re-run this benchmark before reconsidering.

Re-measured reads after the benchmark churn (index present, concurrent
probe traffic): for-you p50 91.8 ms / p95 107 ms (keyed), 72.8 / 90.2 ms
(anonymous) — still 3.2×+ inside the pre-index 287–297 ms baseline;
latest 13.7 / 17.7 ms, following 17 / 30 ms, detail 9.3 / 13 ms.
- **Latest candidate window** (dedup anti-spam): backward index scan on
  `Post_createdAt_idx` + incremental sort, LIMIT 100 — 5.6 ms cold. Healthy;
  the app-side dedup-then-hydrate design pays for itself.
- **Following membership**: `EXISTS` on `Follow_followerId_followingId_key`,
  index-only, 0.15 ms. The "keep membership in SQL" boundary is validated.
- **Post detail**: `Post_shortCode_key` unique index, 3.7 ms cold. The
  detail tail (p95 105 ms before) came from the include tree, not the
  lookup, and is inside noise on repeat runs.

## Findings recorded (not changed)

1. Garbage `cursor` values on GET /api/posts used to surface as a 500 with
   an empty body; the route now validates each path's cursor shape and
   returns `400 bad_request`. For You's first page emits an ISO timestamp;
   chronological pages emit a timestamp plus ID. No compat branch kept.
2. Every API-key-authenticated request — GETs included — fires a
   fire-and-forget `UPDATE ApiKey SET lastUsedAt` (visible as the settings
   page "last used" column). Assessed as the intended metadata behavior,
   not a permission violation: read keys never mutate domain data. This is
   the only write reachable from a GET.
3. View counting is POST-only; trending cache invalidation happens on
   writes only.

## Site-identity propagation (SiteConfig) — measured across the revalidation window

Production build (`next build` + `next start`), row flipped at T0, then one
probe request to `/robots.txt`, `/manifest.webmanifest`, `/llms.txt`,
`/sitemap.xml` and the dynamic home page every 3 minutes for 84 minutes —
no restart, no rebuild (2026-10-28):

- **T0 … T+69 min: every surface serves the OLD identity** (robots,
  manifest, llms.txt, sitemap and the dynamic home page alike).
- **T+72 min: all five surfaces flipped together** to the new origin/name
  (observed between the T+69 and T+72 probes; two stale serves after
  eligibility, consistent with stale-while-revalidate).

Model that fits the data: `getSiteConfig()` is `unstable_cache(1 h)` and
the static metadata routes (robots/manifest/sitemap) revalidate on the
same hourly cycle; after expiry the first request serves stale while
regeneration runs, and the next request serves fresh. Under continuous
traffic this run observed a database-only change at **T+72 min**. On an idle
site, revalidation is request-driven: no finite propagation time is
guaranteed until requests arrive after expiry.

Correction history: the first batch's probes (all inside the first hour)
concluded "baked at build, rebuild required" — that was measuring the
pre-expiry window, compounded by a zombie-process probe error. The review
batch's route-table correction (static routes with 1 h revalidation,
llms.txt dynamic) is what the 84-minute run confirms.

**Domain/brand switch procedures:**

- **Planned switch (recommended):** `UPDATE SiteConfig` → build from a
  clean `.next` (a reused cache can carry the old identity into the new
  build) → `pm2 restart cascool`. New identity is live immediately.
- **Database-only switch:** works without a rebuild; this run served the old
  identity until T+69 and the new one at T+72 under regular probes. An idle
  site can remain stale until requests resume. Keep both origins reachable
  (DNS/TLS) through the window; new-key
  prefixes issued during it still use the old prefix from the cached row.

## Mobile feed experience checklist

Latest/following/detail are all ≤ ~20 ms p50 with ≤ 16 SQL statements and
~21 KB feed pages in this local test. For You improved from ~300 ms to
~70 ms p50; mobile field latency still needs measurement.

## Mobile feed — production-build measurement (2026-10-28)

Embedded-browser run at 390×844 against `next start` + `cascool_perf`, plus
server-side curl timings:

| Metric | Value |
|---|---|
| Home TTFB (curl ×30, anonymous) | p50 23.7 ms · p95 38.5 ms |
| Home HTML | 199 KB raw / **17 KB compressed** (brotli) |
| DOMContentLoaded (cold visit) | ~430 ms warm, ~1.0 s first-hit-after-boot (route warmup) |
| Client JS (cold first visit) | **191 KB transferred / 626 KB decoded, 16 scripts** |
| Articles rendered at first paint | 20 (fully server-rendered) |
| CLS (load + all scroll steps) | **0** — zero layout shifts, zero long tasks |
| Image layout | no shift (posts reserve space); seeded images served via /uploads |

**Fix applied (evidence-pointed):** every pageview issued a duplicate
first-page fetch (21.7 KB + 1 API roundtrip) after hydration. Root cause in
SWR 2.4.1 source: `useSWRInfinite` reads page data only from the cache
provider and never consults `SWRConfig.fallback` — the SSR seeding in
`TimelineFeed` was dead code. Fixed by pre-seeding the **provider** cache
with the SSR page (`SWRConfig provider → Map`): page 0 is a cache hit, no
mount fetch, and the SSR page's `nextCursor` feeds pagination immediately.
Re-measured after the fix: exactly **one** API call on load (the 60 s
new-posts poll), 20 posts rendered, CLS still 0.

Review found the same dead `fallback` in `InfinitePostList` (profile, CAS,
explore and bookmarks). Both components now use one `SWRInfiniteSeed`
implementation. The no-duplicate-fetch browser measurement above covers
the home timeline; generic lists use the same cache path and have a
provider-seeding test, but were not separately timed in a browser.

Measurement limitations (recorded, not fixed): this embedded webview's
`IntersectionObserver` never fires (verified: zero callbacks for a fully
visible element), so infinite-scroll pagination and pull-to-refresh cannot
be validated here — their code paths (sentinel observer → setSize → cursor
key) are sound by inspection and were NOT changed beyond the cache seeding;
spot-check on a real mobile browser when convenient. Engine-level paint
metrics (FCP/LCP) are likewise not exposed by this webview; navigation
timing (DCL/load) and CLS were used as first-screen proxies.

## Mobile feed — engine verification on real WebKit & Chromium (2026-10-28)

Full-flow verification at 390×844 with touch (Playwright WebKit 27.2 =
Safari's engine; Playwright Chromium = Chrome's engine), against
`next start` + cascool_perf behind a local self-signed TLS proxy
(`scripts/mobile-verify/tls-proxy.mjs` — production builds mark the session
cookie `Secure`, which browsers refuse over plain http://127.0.0.1; the
real deployment's nginx TLS makes the cookie valid there). Harness:
`scripts/mobile-verify/engines.mjs`; evidence phases logged per engine.

| Flow | WebKit (Safari engine) | Chromium (Chrome engine) |
|---|---|---|
| Home load | 20 SSR posts · 1 API call (60 s poll) · CLS unavailable | 20 SSR posts · 1 API call · CLS 0 · FCP ≈ 0.2–2.0 s |
| Scroll pagination | 20→100 posts · 4 cursor fetches, compound cursors correct · CLS unavailable | same (4 cursor fetches) · CLS 0 |
| Detail → **back** | **fixed this batch** — home renders, Next state intact | same |
| CAS page | SSR 20 → 60 with `cas=` cursors · 2 KB extra JS transfer in this warm session | same |
| Profile + Replies tab | SSR 20 → 9 replies via `scope=replies` | same |
| Login → tabs | Latest/Following tabs appear · following fetch OK | same |
| Tab round-trip | back to Latest: page-1 refetch + poll (freshness by design) | same |
| Compose | POST 201 → post prepended ≤1.5 s, no refetch | prepended immediately |
| Like | POST fires · aria-pressed flips | same |
| Pull-to-refresh | — (touch gesture not dispatched in this run) | CDP touch gesture fires `since&take=50` · CLS 0.061 (pull indicator) |
| New-posts banner | — | trigger 201 → banner at 59.2 s (60 s poll) → click prepends 20→21 |

**Bug found & fixed:** after home → post detail → browser back, the page
at `/` kept rendering the DETAIL tree (single post, no feed tabs), zero
network, no self-healing — reproduced on both engines. Root cause was
app-side: TimelineFeed's tab-URL sync called
`history.replaceState(null, '', url)`, wiping Next.js's router bookkeeping
from the home history entry; the popstate then carried no Next state, the
router ignored it, and the previous tree stayed mounted. Direct-URL entry
+ back (no prior wipe) navigated correctly, which isolated the cause.
Fix: pass `window.history.state` through the replaceState call. Verified
on both engines; regression pinned in tests/module-boundary.test.ts, and
the browser harness asserts that Back renders the home feed tree.

Known-and-documented: at the time of this table, loaded pages 2+ did not
survive the home remount on back (per-mount SWR provider cache) — solved
the same day by the identity-owned browse cache below. Tab switch back to
Latest may refetch page 1 (SWR `revalidateFirstPage` freshness semantics)
— at most one request, by design.

## Browse-state lifecycle — identity-owned cache (2026-10-28)

Replaced the per-mount SWR provider with `BrowseStateProvider`
(`src/components/posts/BrowseStateProvider.tsx`), mounted once at the app
root inside `AuthProvider`: the SWR cache (pages + cursors + loaded-page
count under `$inf$<firstPageKey>`) and a scroll memory now live for the
whole route session, keyed by identity (`currentUser?.id ?? 'anon'`) —
logout/login/account switch remounts the provider and drops the previous
identity's data wholesale; there is no module-level cache to leak across
identities. `SWRInfiniteSeed` seeds the SSR page into this cache
only-if-absent (a back-navigation's cached pages are newer than the SSR
snapshot). All infinite lists (home timeline, CAS, profiles, bookmarks,
explore, detail replies) restore their pages, cursors and scroll position
on back-navigation.

Two root causes found and fixed along the way (both reproduced on
WebKit + Chromium before the fix):

1. **Back landed on the wrong tab and first page only.** Next's router
   cache replays the SSR-time tree on back — the tab the user switched
   to lives only in the URL (`?tab=`). `TimelineFeed` now adopts the
   URL's tab in its first-render state initializer (client mount, so no
   hydration mismatch), and mounts the inner feed **keyed by tab**.
2. **Cross-tab cache corruption (the reason for keying).** One
   `useSWRInfinite` instance re-keyed across tab switches; SWR's
   revalidate closure pairs a stale key with the current-render fetcher
   (`fetcherRef.current` is read fresh), so a pagination revalidation
   wrote Following's 4 pages into the Latest cache entry — the Latest
   tab then rendered Following's list. Traced via a patched `cache.set`
   in the browser (write timeline vs request timeline). Keying each tab
   to its own instance removes the re-key entirely; each tab also gets
   its own scroll memory.

Pull-to-refresh CLS **0.061 → 0.0000** (Chromium, CDP touch gesture, same
harness): the shift was the pull indicator growing an in-flow container
height, pushing the whole feed down. The indicator (and the new-posts
banner) are now fixed overlays — rotation/opacity/translateY carry the
feedback, no layout impact. The gesture still fires the real refresh
(`since&take=50` asserted).

Verification (`scripts/mobile-verify/browse-state.mjs`, production build
via tls-proxy, both engines — all checks passed):

| Flow | WebKit | Chromium |
|---|---|---|
| Scroll to 80 posts (4 pages) → detail → back | 80/80 cards · identical cursor chain · scroll restored exactly (6000 px) · 0 list refetches | same · 0–1 list refetch |
| Latest ⇄ Following | distinct tops · Following cached on return | same |
| Publish / like | post at top of Latest · aria-pressed flips | same |
| In-place identity switch (login as another user) | 20 cards (first page only) · scroll 0 — previous identity's pages and position gone | same |
| CLS (load + paginate + tabs + publish) | unavailable on this WebKit build | **0.0000** |
| Pull-to-refresh CLS | — (Chromium-only CDP gesture) | **0.0000** · refresh fetch fired |

Verification environment notes: the iOS-Simulator Mobile Safari leg
(safaridriver) is blocked by the host Safari "Allow remote automation"
gate, which requires interactive authorization — engine-level
verification stands in its place. The embedded webview used in earlier
measurements has a non-firing IntersectionObserver; pagination and
pull-to-refresh are verifiable on real engines, as shown above. This
Playwright WebKit build does not expose the `layout-shift` or `longtask`
PerformanceObserver entry types, so its CLS and long-task values are
**unavailable**, not zero; Chromium supplies the CLS figures above. The
verification harness now records entry-type support and emits `null` for
unsupported measurements.

## Browse-state review correction and startup cost (2026-10-28)

Next can replay an SSR tree for Latest while the URL holds `?tab=following`.
The first browse-state batch adopted the URL tab, but still passed the
Latest SSR posts and cursor into that tab's fallback and seed. On a cache
miss, this could show Latest under Following and seed the wrong key. The
timeline now uses SSR data only when `initialTab === tab`; otherwise it
shows a loading state until the selected tab's cache or fetch is ready.
The browser harness delays Following's first response, leaves the page,
returns through Next navigation, and asserts no Latest cards appear under
Following before the correct response arrives. WebKit and Chromium pass.

The identity cache now keeps every mounted list plus the five most recently
closed post lists. Closing a sixth older list evicts that list's first page,
cursor pages, `$inf$` metadata and scroll memory together. A revisit then
starts from its SSR first page at the top. `InfinitePostListInner` is keyed
by `basePath` as the home feed is keyed by tab, so profile/CAS/search
navigation never changes the key of a mounted SWR infinite instance.
Unit checks exercise 30 distinct list keys with a fixed bound of 15 owned
cache entries (three per retained list in that fixture), active-list
retention, recent-list reuse and identity separation. A production-build
smoke check in WebKit and Chromium switched a profile through Replies,
Media and Likes (zero posts each) and back to Posts (20 posts) without
cross-tab content.

Cold anonymous browser comparison against `main` (same local PostgreSQL
test data and production Next builds; 390×844 Chromium, 4× CPU, 1.6 Mbps
downlink, 150 ms network latency, fresh browser context each run; 51.la
blocked to isolate application startup; two runs per route):

| Route and metric | `main` | corrected branch |
|---|---:|---:|
| `/` JS transfer / decoded | 197.2 / 642.6 KB | 198.3 / 645.5 KB |
| `/` first content | 0.87–0.99 s | 0.90–0.94 s |
| `/` Share dialog response after DOMContentLoaded | 1.21–1.42 s | 1.25–1.47 s |
| `/about` JS transfer / decoded | 172.4 / 570.7 KB | 178.6 / 585.1 KB |
| `/about` first content | 0.76–0.78 s | 0.76–0.78 s |

The root SWR provider raises the quiet `/about` route by 6.3 KB of JS
transfer; the homepage rises by 1.1 KB because it already loaded SWR.
First-content and first-action ranges overlap in this small local sample:
the browse-state fix shows no measured startup regression, but the roughly
1.2–1.5 s interval from DOMContentLoaded to the first Share response remains
a separate frontend-startup issue. This experiment does not establish
real-user percentiles or prove the provider is the cause of that interval.

Chromium heap after explicit garbage collection during two passes through
six profiles × four tabs (24 distinct post-list keys, then 24 revisits)
was 6.25 MB on home, 7.34 MB after the first pass, 7.71 MB after the
second and 9.06 MB on the final home render. The owned post-list cache is
bounded by construction and unit test; total browser heap also contains
React, Next router state and the current DOM, so these samples do not prove
a flat whole-app heap. The second pass added less than the first, with no
explosive growth in this local session.
