# RC Closeout Report — 2026-10-28

Base: `main@cfa0854`, four local commits on top: `b57363e` (closeout: checksum alignment, stateless sitemap shards, unified repost lock order, side-effect outbox) → `4c2ab02` (shard-offset validation, outbox claim lease + notification eventKey) → `7a1c53d` (eventKey/compound-unique coexistence, bounded claims, split pre-deploy SQL) → `9a5e81d` (persistent notification delivery record, SKIP LOCKED claims, executable report SQL). **Final RC = `9a5e81d`.** No push, no deploy.

**Workspace status:** clean after commit; branch `main`, local-only (origin/main still at `955d7e0` v1.1.7). `/.tmp/` is explicitly gitignored (rehearsal artifacts stay local). Cumulative change set across the four commits: stateless sitemap shard route replacing `p/sitemap.ts` + pure `sitemap.ts` lib, side-effect outbox + notification delivery record with three new migrations (`20261028200000`, `20261028210000`, `20261028220000`) plus the rewritten `20261028170000`, lock-order rewrites in 2 services, resolve-route outbox wiring, new admin retry endpoint, docs, tests. Dev database `cascool` reconciled (below).

---

## 1. Migration history alignment

**Which databases executed the OLD version of `20261028170000_governance_rc_schema_fixes`** (old checksum `4bdac9075494…`, current file `f9e3ba085578…`):

| Database | State | Action |
|---|---|---|
| local dev `cascool` | OLD version applied (checksum diverged) | Repaired + re-baselined 2026-10-28; `migrate deploy` applied `20261028200000`, `migrate status` → "Database schema is up to date!" |
| local `cascool_perf` | chain stops at `20261027180000` — never reached it | none (stale perf DB, unaffected) |
| local `cascool_test` | throwaway, recreated by the test run from the current files | none |
| `migchk_*` | no `_prisma_migrations`, no `Repost` table (scratch DBs) | none |
| production | **NOT CONNECTED, NOT VERIFIED** — no production connection exists on this machine; "origin/main at v1.1.7 predates the migration" is repo reasoning, not a database inspection | run the pre-deploy queries below on production; fresh applies need nothing |

**Rehearsal on dirty-data copies** (`deploy/rc-rehearsal-20261028170000.sh`, artifacts in `.tmp/rc-rehearsal/`, seed = exact-match, **unmatched**, **multi-match**, tombstoned-only Reposts, an orphan generated post, **2 historical MENTION** + 2 other notifications):

- **F1 — old version vs MENTION data:** fails (`invalid input value for enum "NotificationType": "MENTION"`) and rolls back atomically (MENTION rows preserved, column absent). ⇒ any DB that recorded the old version has, by construction, zero MENTION rows.
- **Path N — fresh apply of the rewritten file:** all 4 Reposts linked (`r1→gen_ok`, unmatched `r2→repost_r2` synthesized, multi-match `r3→gen_early` = deterministic earliest, `r4→gen_dead` tombstone preserved); `repostPostId` NOT NULL, unique, FK `ON DELETE CASCADE`; MENTION rows deleted (notifications 4→2, LIKE/REPORT_RESOLVED intact); enum rebuilt without MENTION; multi-match loser (`gen_late`) and historical orphan (`orphan1`) preserved as live unlinked posts; `User.postCount` untouched by design.
- **Path R — old applied, then `deploy/repair-20261028170000-old-version.sql` + checksum re-baseline:** mid-state shows the old defects (2 unlinked reposts, nullable column, `SET NULL` FK, arbitrary `r3→gen_late` pick); after repair **end state is identical to Path N** (diff of links/constraints/counts = empty), and `prisma migrate deploy` accepts the chain.
- No empty test database was used to prove safety — all three rehearsal DBs carried the adversarial seed above.

## 2. Sitemap shard lifecycle

- `generateSitemaps` (shard set frozen at prerender) replaced by stateless route `src/app/(shell)/p/sitemap/[index]/route.ts` + pure `src/lib/sitemap.ts`. Any numeric index answers at runtime; **out-of-range = valid empty `<urlset>`, never 404**; crossing 50,000 requires **no rebuild** (route registers dynamic `ƒ /p/sitemap/[index]` in build output). robots.txt lists `shardCountFor(count)` shards.
- Cross-boundary tests (real HTTP, real `next dev`): out-of-range shard 200-empty; 50,001 bulk posts inserted → robots lists shards 0–1, shard 0 has exactly 50,000 URLs, shard 1 has the remainder, quiescent union = exact full live set with zero overlap; tombstoning the bulk posts → shard 1 serves 200-empty, robots drops it. No 404 at any point in either direction.
- Consistency semantics stated honestly (code + `docs/ARCHITECTURE.md` + DEVLOG): each shard is an independently revalidated (1 h) snapshot of `(createdAt desc, id desc)`; during writes shards may transiently overlap/miss near the boundary and converge at rest. **The previous "zero duplicate/omission" claim is deleted everywhere.**
- `/u/sitemap.xml` (newest 50,000 active users) and `/cas/sitemap.xml` (top 50,000 non-banned chemical hubs) are documented as **bounded, not exhaustive** — entries beyond the cap appear in no sitemap; only the post sitemap is full-coverage (sharded).

## 3. Unified repost lock order + report-resolve side-effect compensation

- Canonical lock order in BOTH paths — `Repost` row → generated post row → user row → original post row — with the Repost row claimed by an id-guarded `deleteMany` (`interaction.service.ts` cancel; `post-write.service.ts` direct delete). Tests over real HTTP, 5 rounds each: concurrent double-cancel → both 200, counters move exactly once; concurrent cancel vs direct delete → no 500/deadlock, outcomes ∈ {200, 404}, final state exact; cancel → re-repost → cancel only removes the new repost.
- Side-effect compensation: `SideEffectTask` transactional outbox (migration `20261028200000_side_effect_outbox`) — resolve enqueues notification + per-image cleanup tasks **in the resolution transaction**, drains post-commit; failures stay `pending` with `attempts`/`lastError`; `POST /api/admin/side-effects/retry` (admin write) re-drains and reports per-task outcomes.
- Fault injection (both real and injected): a directory-shaped upload makes unlink genuinely fail → **committed resolution still returns 200**, cleanup task pending with lastError, notifications delivered, retry endpoint compensates once the fault is cleared; a throwing notification executor (service-level injection) → pending + tracked, then recovers on default drain. Retry endpoint is 401 anonymous / 403 non-admin.

## Acceptance fixes (second pass, on top of b57363e) — HISTORICAL acceptance record

> Historical verification record for that pass only. The claim-lease and eventKey-dedup mechanisms described here were superseded by the third and fourth passes — the final mechanism is the fourth pass below.

1. **Sitemap request validation order** (`src/lib/sitemap.ts` `shardSkip` + shard route): malformed segment → 404; offset not a safe integer (e.g. `9007199254740991.xml`) → 200 empty urlset with **no DB query**; index beyond `shardCountFor(count)` → 200 empty urlset with **no OFFSET query**; only in-range indices issue the skip/take query (skip always < count). Previously a huge index multiplied into a Prisma-overflowing `skip` → 500.
2. **Outbox atomic claiming + notification event idempotency**: `drainSideEffects` claims pending rows per-row atomically (`claimToken` + 60 s lease, migration `20261028210000`), so the route's auto-drain and `POST /api/admin/side-effects/retry` never double-execute a task, and a task orphaned by a process death is re-claimed after lease expiry. Notification payloads now carry a persistent `eventKey` (`Notification.eventKey` unique, migration `20261028210000`) — at-least-once execution collapses to exactly one notification row per event, **including postId-NULL report notifications** that the compound `(userId, fromId, type, postId)` unique constraint cannot dedup. Transactional enqueue / pending-on-failure / committed-resolve-returns-200 mechanisms unchanged (existing tests kept passing).
3. New tests: overflowing shard indices (`9007199254740991.xml`, `500000.xml`) answer 200-empty; concurrent auto-drain × admin retry on the same task → exactly one notification, single `succeeded`; delivered-but-crashed-before-marking → retry produces no duplicate (eventKey absorbs). Production-build HTTP regression added as opt-in suite `tests/prod-sitemap.http.test.ts` (`RUN_PROD_HTTP=1`): builds, boots `next start`, asserts `0.xml` (content), beyond-range, `9007199254740991.xml` → no 500 (200/404 as appropriate) — run in this session, passing.

## Acceptance fixes (third pass) — HISTORICAL acceptance record

> Historical verification record for that pass only. Its delivery/dedup semantics and claim implementation were superseded by the fourth pass (persistent delivery record, `SKIP LOCKED` claims) — the final mechanism is the fourth pass below.

1. **Notification event-key semantics vs the legacy compound unique:** the eventKey upsert previously errored with P2002 whenever a *different* event hit the same `(userId, fromId, type, postId)` tuple (same admin resolving a second report of the same post) — the task went permanently pending — and its retry path re-surfaced read notifications. `deliverNotification` now inserts with bare `ON CONFLICT DO NOTHING`: an eventKey hit is a pure retry (read/createdAt untouched); a compound hit is a genuine new event and re-surfaces the single matching row once, re-stamping it with the new eventKey so that event's retries no-op. postId-NULL events cannot hit the compound unique and always key on eventKey. Contract test: same admin resolves two reports of the same post (same reporter) — both 200, 4 outbox tasks all `succeeded`, exactly one notification row per recipient stamped with the later event's key, zero pending.
2. **Outbox claim limit + token-guarded write-back:** claiming is one parameterized `UPDATE … WHERE id IN (SELECT … LIMIT $n)` — at most `limit` rows are claimed, so tasks beyond the limit hold NO claim and are immediately claimable by the next drain (test: 5 tasks, `limit:2` drains execute 2/2/1 back-to-back with `claimToken IS NULL` in between). Completion/failure write-backs are `where: { id, claimToken }` — a stale executor whose lease expired and was re-claimed can no longer overwrite the new owner's state.
3. Pre-deploy SQL split into block P (old-schema-safe: no `repostPostId`/`SideEffectTask`/`eventKey` references; adds the two prediction counts — reposts without a generated post, multi-match reposts) and block M (post-migration reconciliation + constraint spot-checks). Production remains marked not connected / not verified.

## Acceptance fixes (fourth pass) — FINAL mechanism

1. **Persistent notification delivery record:** new `NotificationDelivery` table (migration `20261028220000`) — one immutable row per delivered eventKey, written in the SAME transaction as the visible notification change, never overwritten by later events, surviving notification-row cascade deletion (FK `ON DELETE SET NULL`). `deliverNotification`'s event path now: insert delivery record `ON CONFLICT DO NOTHING` → if already recorded, pure no-op (eventKey/read/createdAt untouched, regardless of what newer events did to the visible row); otherwise create-or-re-surface the visible notification (compound `DO UPDATE` touches only `read`/`createdAt`, never the row's eventKey stamp) and link the record — one transaction. Regression sequence tested: A delivered (task pending) → B delivered (re-surface) → user reads → retry A = no-op; retry B = no-op; exactly one visible row, two delivery records. Legacy LIKE/FOLLOW-shaped dedup (non-event paths) verified unchanged.
2. **True mutual exclusion in outbox claiming:** claim is now a bounded `SELECT … FOR UPDATE SKIP LOCKED` CTE feeding `UPDATE … RETURNING` (lease predicate re-checked in the outer WHERE under the held lock). Deterministic two-connection test: executor 1 holds an open transaction having claimed one task; executor 2's claim returns ONLY the unlocked tasks (disjoint sets, no blocking); after commit the contended task still belongs to executor 1. Limit, lease, and claimToken-guarded write-backs preserved (limit test still passes).
3. P/M block headers converted to legal `--` SQL comments; both copyable blocks executed to validate syntax: **P** on a rehearsal database holding the old schema (chain through `20261027200000`, `_prisma_migrations` present as on any Prisma-managed production) — clean; **M** on the local dev database — clean. Production remains **not connected, not verified, not accepted**.

## Pre-deploy verification on production (REQUIRED before first deploy of this chain)

Production has never been connected from this development machine — **not connected, not verified, not accepted**; nothing below has been executed against it. The queries are split by schema version: block P runs on the OLD schema before deploying, block M runs after `prisma migrate deploy` completes. Both blocks are syntax-validated by execution (P: old-schema rehearsal DB; M: local dev DB — see the fourth-pass section above).

```sql
-- P. Pre-deploy, on the OLD schema (references no column/table created by
--    this chain — safe on a v1.1.7-era database)

-- P1. Migration record check
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM _prisma_migrations
WHERE migration_name IN ('20261028170000_governance_rc_schema_fixes',
                         '20261028200000_side_effect_outbox',
                         '20261028210000_outbox_claim_and_notification_eventkey',
                         '20261028220000_notification_delivery_record')
ORDER BY migration_name;
-- Expected on an untouched production chain: 0 rows → plain `prisma migrate deploy`.
-- If 20261028170000 is present with checksum 4bdac9075494…  → apply
--   deploy/repair-20261028170000-old-version.sql FIRST, then re-baseline the
--   checksum as documented in that file.
-- If present with finished_at NULL / rolled_back_at set →
--   npx prisma migrate resolve --rolled-back 20261028170000_governance_rc_schema_fixes

-- P2. Baseline counts to RECORD before deploying (old-schema columns only)
SELECT
  (SELECT count(*) FROM "Repost")   AS reposts,
  (SELECT count(*) FROM "Post" WHERE "deletedAt" IS NULL) AS live_posts,
  (SELECT count(*) FROM "Notification" WHERE type::text = 'MENTION') AS mention_rows,
  -- Reposts with NO pure-repost post matching (author, quoted post, empty
  -- content) — predicts how many posts the backfill will synthesize:
  (SELECT count(*) FROM "Repost" r WHERE NOT EXISTS (
     SELECT 1 FROM "Post" p
     WHERE p."authorId" = r."userId" AND p."quotePostId" = r."postId" AND p.content = ''
  )) AS reposts_without_generated_post,
  -- Reposts matching MORE THAN one pure-repost post — the backfill links the
  -- earliest deterministically; the losers remain live unlinked posts:
  (SELECT count(*) FROM "Repost" r WHERE (
     SELECT count(*) FROM "Post" p
     WHERE p."authorId" = r."userId" AND p."quotePostId" = r."postId" AND p.content = ''
  ) > 1) AS multi_match_reposts;
```

```sql
-- M. Post-migration, on the NEW schema (run after deploy)

-- M1. Count reconciliation against the P2 baseline
SELECT
  (SELECT count(*) FROM "Repost")                              AS reposts,      -- must equal P2.reposts
  (SELECT count(*) FROM "Repost" WHERE "repostPostId" IS NULL) AS unlinked,     -- must be 0
  (SELECT count(*) FROM "Post" WHERE "deletedAt" IS NULL)      AS live_posts,   -- P2.live_posts
                                                                                                 --   + P2.reposts_without_generated_post
                                                                                                 --   (exact equality modulo other writes
                                                                                                 --   during the deploy window)
  (SELECT count(*) FROM "Notification" WHERE type::text = 'MENTION') AS mention_rows,          -- must be 0
  (SELECT count(*) FROM "SideEffectTask")                      AS outbox_rows,  -- 0 on a fresh deploy
  (SELECT count(*) FROM "Notification" WHERE "eventKey" IS NOT NULL) AS eventkey_rows;
-- M2. Contract spot-checks
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = '"Repost"'::regclass AND contype = 'f';
-- expect: Repost_repostPostId_fkey … ON DELETE CASCADE (not SET NULL)
SELECT attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
WHERE c.relname = 'Repost' AND a.attname = 'repostPostId';   -- expect true
SELECT indexdef FROM pg_indexes WHERE indexname = 'Notification_eventKey_key'; -- expect UNIQUE
```

## Gates

| Gate | Result |
|---|---|
| `npm test` (unit + API contract, real server + throwaway migrated DB) | **142/142 passed** (opt-in prod-HTTP suite excluded — run separately below) |
| `RUN_PROD_HTTP=1 npx vitest run tests/prod-sitemap.http.test.ts` (production build + `next start`) | **1/1 passed** — 0/beyond-range/`9007199254740991.xml` never 500 |
| `npm run lint` | 0 errors, 0 warnings |
| `npm run typecheck` | clean |
| `npm run build` | success — **45/45 static surfaces prerendered**, `/p/sitemap/[index]` dynamic |
| `prisma migrate status` (dev `cascool`) | "Database schema is up to date!" — **13 migrations**, chain through `20261028220000` |

Not pushed, not deployed, no PR opened. Production database: never connected by this work — acceptance status is limited to local dev + rehearsal databases.
