# Release 1.2.0 — `ApiKey.access` retirement: deployment & rollback notes

Status: **plan + local rehearsal only.** No production system was touched.
This document replaces the previous "migrate → build → reload" description
of the deploy flow with one that is honest about the compatibility window
this migration creates. It is written for the 1.2.0 deploy and rehearsed
against local throwaway databases only (evidence at the bottom).

## 1. What changes

Migration `20261029140000_retire_api_key_access` executes two instant,
**destructive** DDL statements:

```sql
ALTER TABLE "ApiKey" DROP COLUMN "access";
DROP TYPE "ApiKeyAccess";
```

There is no backfill and no data preservation: the per-key access value is
deleted. From that moment, authorization is computed dynamically per
request from the owning account's standing (`active` + current
verification → write; otherwise read-only; suspended → 401). The old
binary's key-auth query explicitly selected `access`, so it cannot serve
authenticated API/MCP traffic after the migration lands.

## 2. Compatibility matrix

What is factually established this round comes **only from local rehearsal
on throwaway databases** (§6). The live production binary version was NOT
verified — no production access — so each row states a conditional
compatibility, not an observed production state.

| Process serving | DB schema | Compatibility |
| --- | --- | --- |
| binary that selects `access` | pre-migration | works by design (if production still runs such a binary, this is its only compatible pairing) |
| binary that selects `access` | **migrated** | **broken** — every API-key-authenticated request errors `42703 column "access" does not exist` (rehearsed locally below) |
| new binary (1.2.0) | migrated | supported target (rehearsed: fresh build boots, key auth works) |
| new binary (1.2.0) | pre-migration | **not a supported pairing** — not rehearsed and not claimed; the migration is a hard prerequisite of the release |

Consequences:

- The old order in `DEVELOPMENT.md` (`npm run db:deploy` while the old
  process keeps serving, then build, then `pm2 startOrReload`) has a
  window — from migration to process reload — in which the still-running
  old process fails all key-authenticated requests. **"Migrate → build →
  restart" is therefore NOT a zero-interruption sequence for this
  release and must not be described as one.**
- Rolling back *only the binary* to the old version after the migration
  has run does not restore service: the old code needs a column that no
  longer exists. Rollback requires the database to go back too (§4).

## 3. Deploy sequence (rehearsable order)

1. **Freeze writes window.** Announce a brief maintenance window for
   authenticated API/MCP traffic. Browser sessions of the *old* process
   are unaffected by the column drop (they never read `access`), but the
   process is about to be replaced anyway — treat the window as
   full-service brief interruption for planning honesty.
2. **Snapshot the database** (or verify the latest PITR/backup point is
   seconds old). This snapshot is the only real rollback anchor (§4).
3. **Apply the migration**: `npm run db:deploy`. Instant DDL. From this
   moment the OLD process can no longer authenticate API keys — the
   window has started; its length is steps 3→6.
4. **Build against the migrated database**: `npm run build` (the build
   needs a reachable, migrated DB — `/sitemap.xml` prerenders at build
   time). Building a pre-verified artifact earlier and only migrating at
   cutover does not remove the window: the window is caused by the old
   process, not by build time.
5. **Switch the process**: `pm2 startOrReload ecosystem.config.cjs` with
   the new build. The new binary is the only one that works on the
   migrated schema.
6. **Health verification — new version (1.2.0) checks.** The new binary is
   the only one that works on the migrated schema, and it is the version
   that owns MCP, so these checks may assert 1.2.0-specific endpoints:
   - anonymous `GET /api/posts` → 200
   - key-authenticated `GET /api/account/api-keys` → 200 with a valid key
   - `POST /mcp` initialize with Bearer key → serverInfo `version`
     `1.2.0`, expected tool list for that key's standing
   - one browser session request (post create/edit smoke) → 2xx

   **Old-version rollback checks are a DIFFERENT baseline.** The old
   baseline (pre-1.2.0) has no `/mcp` endpoint and no 1.2.0 serverInfo —
   after a rollback (§4) verify only what that baseline actually serves:
   - anonymous `GET /api/posts` → 200
   - key-authenticated `GET /api/account/api-keys` → 200 with a
     pre-existing key (valid after the snapshot restore)
   - one browser session request (post create/edit smoke) → 2xx
   - explicitly: do NOT probe `/mcp` or any 1.2.0-only endpoint here; its
     absence is correct behavior for the old baseline, not a failure.

If the window must be minimized beyond this, the honest options are
(a) a pre-staged blue/green pair where the NEW process is built and
warmed on a staging copy of the migrated schema and traffic flips at the
proxy — this shortens the broken-old window to the proxy switch but does
NOT remove it (the old process is already broken the moment the
production DB is migrated), or (b) accepting a full outage by stopping
the old process before step 3, which turns "intermittent 500s on
key-auth" into a clean maintenance page. Choose per operational
preference; neither is "zero downtime".

## 4. Rollback

- **Primary recovery is roll-forward**: redeploy a known-good 1.2.0
  artifact. The migration itself is trivial (two DDL statements) and the
  new code path is exercised by the migration-compatibility test suite.
- **Binary-only rollback (old process on migrated DB) is not a recovery
  path** — it re-creates the `42703` failure mode (rehearsed below).
- **Database rollback** = restore the pre-migration snapshot from step 2
  (or PITR to just before `db:deploy`) and point the OLD binary at it.
  This loses every write accepted after the snapshot; the
  `_prisma_migrations` bookkeeping row is restored with the snapshot, so
  the old state is consistent. Because the dropped column held data with
  no backfill source, `ALTER TABLE ADD COLUMN` re-creation cannot
  reconstruct the old values — snapshot restore is the only faithful DB
  rollback.
- Sequence for DB rollback: stop new process → restore snapshot → start
  old process → verify the **old-version rollback checks in §3.6** against
  the old binary (never the 1.2.0/MCP checks).

## 5. Explicit non-goals

- No runtime compatibility branch for the retired `access` column will
  be added to mask the sequencing problem (per AGENTS.md: no runtime
  compat for retired schema).
- This document makes no claim about the live production binary
  version; whether production runs the `access`-selecting query was not
  verified this round (no production access). The matrix in §2 is
  conditional; confirm which pairing applies during the actual window with
  the matching §3.6 health checks.

## 6. Rehearsal evidence (local throwaway databases, 2026-10-29)

- Fresh isolated DB, `prisma migrate deploy` re-run for this document:
  engine reports **"14 migrations found in prisma/migrations"** and
  **"All migrations have been successfully applied."** Cross-checked
  item-by-item: `_prisma_migrations` holds exactly 14 finished records
  (each `finished_at` set), one per `migration.sql` in the migration
  directory — 14 directory files vs 14 database records, zero missing,
  zero extra:
  `20260628120000_init`, `20260710020000_user_createdat_idx`,
  `20260710030000_trgm_search_indexes`, `20260710040000_remove_tag_system`,
  `20261027130000_repair_schema_drift`, `20261027160000_api_key_access`,
  `20261027170000_site_config`, `20261027180000_site_key_prefix`,
  `20261027200000_post_feed_rank_covering_index`,
  `20261028170000_governance_rc_schema_fixes`,
  `20261028200000_side_effect_outbox`,
  `20261028210000_outbox_claim_and_notification_eventkey`,
  `20261028220000_notification_delivery_record`,
  `20261029140000_retire_api_key_access`.
- Legacy key query on the migrated schema:
  `SELECT "access" FROM "ApiKey" LIMIT 1` →
  **SQLSTATE 42703, `column "access" does not exist`**; the post-deploy
  `ApiKey` column list contains no `access` (`id, userId, name, keyHash,
  prefix, lastUsedAt, expiresAt, revokedAt, createdAt`).
- New-binary path against the retired schema:
  `tests/migration-compatibility.test.ts` (restores the legacy column,
  rehearses old read/read_write keys, applies the migration, asserts the
  unified semantics) — green in the full suite.
- Production-build boot against a fresh migrated DB, official MCP client
  initialize/`tools/list`/read/write, and the HTTP smoke matrix were
  verified during the 1.2.0 audit (isolated copy, 46/46 build) and are
  re-run as part of this closeout's acceptance gates.

## 7. Production release preflight (2026-10-29)

The release preflight subsequently inspected the actual production checkout:
`955d7e0`, product 1.1.7, with four finished migrations through
`20260710040000_remove_tag_system`. All four checksums match the release
files; ten migrations remain pending. Unlike the intermediate local
baseline described in the matrix, this older binary reads `ApiKey.scopes`.
The pending chain removes `scopes`, adds `access`, then retires `access`,
so this binary also requires the maintenance-and-cutover procedure. This
observation does not change application code or migration semantics.

Read-only baseline counts: 134 reposts, 785,129 live posts, three MENTION
notifications and six API keys. Rehearsal must check existing-object
definitions as well as migration records; `IF NOT EXISTS` alone does not
prove production schema compatibility. Native server installation, a
restored-snapshot migration rehearsal, and a build precede production
mutation. The final recovery snapshot is taken after writes are stopped.

The production reverse proxy still has a static `/llms.txt` alias. Release
configuration must forward that exact path to Next.js and retain direct
static/upload serving. Subsequent execution and health-check evidence is
kept in the deployment record; this section is preflight evidence only.
