# Contributing to cas.cool

Thank you for your interest in contributing. This document covers the essentials.

## Development Setup

### Prerequisites

- Node.js 22+
- PostgreSQL 16+

### Install & Run

```bash
git clone <repo-url>
cd cas.cool

npm install

# Database
createdb cascool
npx prisma migrate deploy
npx prisma generate

# Environment
cp .env.example .env
# Fill in DATABASE_URL and JWT_SECRET

# Run
npm run dev
```

## Architecture

```
src/
  app/              Next.js 16 App Router (RSC + Route Handlers)
  (auth)/           Login & register pages
  (shell)/          Main app shell (timeline, profile, etc.)
  api/              Route Handlers (REST API)
    posts/            Post CRUD, like/bookmark/repost
    auth/             Login, register, logout
    upload/           Image upload (multipart)
    me/               Profile, password
    account/          API keys, verification
    users/            Follow/unfollow
    messages/         DM
    admin/            Admin operations
    reports/          User reports
  components/       React components
  lib/              Shared utilities
    api-auth.ts       Unified identity resolution (API Key + Session + anonymous)
    rate-limit.ts     Token-bucket rate limiting (applied in route handlers)
    api-client.ts     Frontend fetch wrapper
    image.ts          Server-side image processing (sharp)
    serialize.ts      Post serialization (postInclude)
    services/         Domain services (post, user, message, notify, search, layout)
    permissions.ts    Feature gates (verification tiers)
  proxy.ts          Page-route auth redirect only (Next.js proxy) — NO rate
                    limiting here; API auth/rate-limiting lives in route
                    handlers via api-auth.ts / rate-limit.ts
prisma/
  schema.prisma     Database schema (source of truth)
  migrations/       Prisma migrations
```

### Key Decisions

- **Single Next.js process**: all API endpoints are Route Handlers. No separate API server process.
- **Auth**: unified identity resolution handles both API Key (header) and Cookie Session (web). See `src/lib/api-auth.ts`.
- **Repost**: creates a `Repost` row AND a `Post` (empty content + `quotePostId`).
- **Replies**: `Post.parentId` self-reference (no Comment model exists in the schema).
- **Chemical**: M2M model linking posts to CAS Registry Numbers. The former Tag model was removed in migration `20260710040000_remove_tag_system`.

## Code Standards

### Frontend

- **UI language is ALWAYS English.** No Chinese labels, toasts, or placeholders.
- **All text inputs ≥ 16px** — prevents iOS Safari focus-zoom.
- **Design tokens from `globals.css` `@theme`** — no hardcoded colors.
- **Icons**: `@/components/icons` is canonical.
- **FollowButton**: `@/components/profile/FollowButton` is canonical.
- **No raw `<img>` for user content** — all uploads go through `src/lib/image.ts` → `processAndStoreImage()`.

### API

- All mutations require auth (`requireAuth()` / `requireWrite()` from `src/lib/api-auth.ts`; server components use `getCurrentUser()`) and verify resource ownership.
- Rate limiting via `src/lib/rate-limit.ts` (token bucket, per identity: API key / user / IP) — applied inside route handlers.
- Parameterized Prisma queries only. No string-interpolated SQL.
- Full endpoint inventory, auth tiers, and compatibility constraints: [`docs/API-BASELINE.md`](docs/API-BASELINE.md).

### Database

- **Prisma schema is source of truth.** No `db push` in production — use migrations.
- `postInclude(userId)` returns the full Prisma include shape.

## Testing & Build

```bash
# Lint
npm run lint

# Type check
npm run typecheck

# Build (requires a reachable, migrated database — /sitemap.xml
# prerenders at build time and queries the DB)
npm run build
```

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for the full standard flow
(environment, install, migrations, deploy).

## Pull Request Process

1. **Branch** from `main` (`git checkout -b feature/your-feature`)
2. **Lint**: ensure `npm run lint` passes
3. **Build**: ensure `npm run build` succeeds
4. **Commit**: clear messages with type prefix (`feat:`, `fix:`, `refactor:`, `docs:`)
5. **PR**: describe what changed and why

### Commit Message Format

```
type: short description

Optional longer explanation.
```

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`.

## Reporting Security Issues

Do not open a public issue for security vulnerabilities. Email the maintainers directly.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
