# Development Workflow — Standard Flow

The canonical, verified way to set up and check this repository. Everything
below was executed end-to-end on 2026-10-27 on a clean checkout. If reality
drifts from this file, fix the file in the same change.

## Prerequisites

- **Node.js ^22.12.0, ^24.x, or ≥ 26** — the intersection of the ranges our
  toolchain actually supports (Prisma 7 requires `^20.19 || ^22.12 || >=24.0`;
  Vitest 5 requires `^22.12.0 || ^24.0.0 || >=26.0.0`). Declared in
  `package.json` `engines`; Node 22.0–22.11, 23 and 25 are NOT supported
  (25 falls outside Vitest 5's declared range).
- **npm** with the committed lockfile (`package-lock.json`)
- **PostgreSQL 16**

## Environment variables

```bash
cp .env.example .env
```

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. Must be present even for `prisma generate` — `prisma.config.ts` resolves it at config load |
| `JWT_SECRET` | yes | Random string (`openssl rand -base64 32`). Auth refuses to start without it |
| `DB_POOL_MAX` | no | Prisma pg pool size (default 10) |

`.env` is gitignored. Never commit credentials.

## Install

```bash
npm ci
```

- Always `npm ci` (lockfile-exact), not `npm install`, on fresh checkouts.
- **npm ≥ 11.6 blocks dependency install scripts** until approved. This repo
  pins its approvals in `package.json` (`allowScripts`: `sharp`,
  `unrs-resolver`), so a modern npm picks them up automatically. If your npm
  warns about pending scripts, run `npm approve-scripts --allow-scripts-pending`.
- **Lockfile URLs must stay on `registry.npmjs.org`.** Tarball URLs are
  baked into `resolved` fields; generating the lock while configured against
  a private mirror breaks installs for everyone else (this happened:
  33 `mirrors.tencentyun.com` URLs once lived in the lock). If you must touch
  the lock, verify `git diff package-lock.json` contains no mirror URLs.

## Database

```bash
npm run db:generate   # prisma generate (after clone and after schema edits)
npm run db:deploy     # prisma migrate deploy (apply committed migrations)
```

- Creating a migration (development only):
  `npx prisma migrate dev --name <change>` — writes the migration and
  applies it. **Never `prisma db push` against production**; production
  changes go through committed migrations only.
- Fresh-DB verification (2026-10-27): the committed chain
  applies cleanly to an empty PostgreSQL 16 database and produces a
  working schema. Migration `20261027130000_repair_schema_drift` is
  idempotent — it reconciles drift (User count columns, ApiKey table) that
  had once reached production outside the migration chain. Before deploying,
  inspect the live columns, table, indexes and foreign key: `IF NOT EXISTS`
  skips an existing object even if its definition differs from the schema.
- `SiteConfig` row 1 is seeded by migration. Change its `origin`, `name`,
  `shortName`, `description`, `tagline` and `keyPrefix` to rebrand a deployment.
  Identity surfaces (robots, manifest, llms.txt, sitemap, page metadata) are
  cached with a one-hour revalidation interval: a database-only change
  propagated at T+72 min under three-minute probes in the measured run
  (see docs/FEED-PERF.md). An idle site has no fixed propagation bound until
  requests resume. To switch immediately, update the row, build from a
  clean `.next` directory (a reused `.next/cache` can preserve the old
  identity even across a rebuild) and restart. Configure DNS, TLS and
  reverse proxy for the new host separately; keep both origins reachable
  through the propagation window on a database-only switch.

## Checks

```bash
npm run lint        # eslint — expect 0 errors, 0 warnings
npm run typecheck   # tsc --noEmit
npm run build       # next build
npm test            # vitest: unit (src/lib) + API contract (tests/)
npm run test:unit   # pure-logic tests only — no DB, no server
npm run test:api    # black-box API contract tests only
```

**`npm run build` requires a reachable database.** Site metadata and
`/sitemap.xml` read `SiteConfig`; the sitemap also queries content. With no
DB (or bad credentials) the build fails on that step. Locally: create a
database, run `npm run db:deploy`, then build. All other pages are
server-rendered on demand (no ISR).

**API contract tests** (`tests/`) drop and recreate a database named
`cascool_test` by default, migrate it, and boot `next dev` on port 3199.
`TEST_DB_NAME` may override the name but must end in `_test`;
`TEST_DATABASE_URL`, if supplied, must point to that exact name. Use a
dedicated local or CI database server, and do not keep data in that test
database. The database user needs CREATE/DROP privileges.

## Feed performance measurement

`scripts/perf/` re-creates the evidence in `docs/FEED-PERF.md`:

```bash
node scripts/perf/seed.mjs                                  # ~5 min, builds cascool_perf at production scale
DATABASE_URL=...cascool_perf... npm run build               # production build against it
DATABASE_URL=...cascool_perf... npx next start -p 3201 &    # production server
DATABASE_URL=...cascool_perf... KEY_LATEST=... KEY_FOLLOWING=... \
  KEY_FORYOU=... KEY_DETAIL=... KEY_EXTRA1=... KEY_WARM=... \
  node scripts/perf/measure.mjs --pid <pid>                # p50/p95 per scenario
```

Seeds 792k posts / 20k users / ~600k follows. The seed script only accepts
database names ending in `_perf` because it drops and recreates that database.
API keys are inserted with generated raw values (printed once) so runs don't
trip the 120/min rate buckets. SQL statement counts come from
`ALTER DATABASE cascool_perf SET log_statement='all'` plus the PostgreSQL
log; query plans from `EXPLAIN (ANALYZE, BUFFERS)` on the logged SQL.
Re-run both before changing ranking or dedup semantics.

## Local bootstrap (macOS / Homebrew example)

```bash
psql -d postgres -c "CREATE ROLE cascool LOGIN PASSWORD 'cascool' CREATEDB;"
psql -d postgres -c "CREATE DATABASE cascool OWNER cascool;"
cp .env.example .env   # set DATABASE_URL to the above, set JWT_SECRET
npm ci
npm run db:generate
npm run db:deploy
npm run dev            # http://localhost:3000
```

## Production deploy (server)

```bash
npm ci
npm run db:generate
npm run db:deploy      # if new migrations
npm run build
pm2 startOrReload ecosystem.config.cjs
```

> **1.2.0 note:** while migrations run, the still-serving old process may be
> incompatible with the new schema (the `ApiKey.access` drop breaks the old
> key-auth query). The migrate→build→reload order is NOT zero-interruption
> for such releases — follow `docs/RELEASE-1.2.0-ACCESS-RETIREMENT.md`
> (snapshot, window plan, rollback paths) for the 1.2.0 deploy.

PM2 runs the Next.js process from the application directory (`ecosystem.config.cjs` uses `__dirname` without hardcoded system paths). Nginx (reference templates and setup guide in `deploy/`) terminates TLS, forwards client IP headers (`X-Real-IP`, `X-Forwarded-For`), and serves `/_next/static/` and `/uploads/` directly. Dynamic `/llms.txt` proxies to Next.js. Logs live in `logs/` (gitignored).

## Never commit

`.env`, `public/uploads/`, `logs/`, `node_modules/` — all gitignored; keep
it that way.

## Documentation to keep in sync

When behavior or structure changes, update in the same batch: `README.md`,
`CONTRIBUTING.md`, `AGENTS.md`, `docs/API-BASELINE.md` (API behavior),
`src/app/llms.txt/route.ts` (agent-facing API guide), and append a `DEVLOG.md` entry.
`CHANGELOG.md` holds the released-version history.
