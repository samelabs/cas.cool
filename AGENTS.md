# AI Development Rules — cas.cool (ChemHub)

> **Read this before writing any code.** This is the authoritative style guide for all AI agents and contributors.

## Project Identity

- **Product:** cas.cool — a Twitter/X-style social platform for the global chemical trade
- **Stack:** Next.js 16 + React 19 + Prisma 7 + PostgreSQL 16 + Tailwind CSS 4
- **Live:** https://cas.cool

## Golden Rules

### 1. UI language is ALWAYS English
The user communicates in Chinese, but the **application UI must be 100% English**. Never generate Chinese labels, toasts, placeholders, buttons, or metadata. No exceptions unless explicitly asked for i18n.

### 2. Don't patch — fix the system
> "不要打补丁修改，应该规范系统"

When fixing visual/structural issues: establish the system-level foundation first (design tokens, shared component patterns, consistent API shapes), then fix individual components against that system. Never do one-off regex find-replace as a migration strategy. When a batch change breaks something, redo the system, don't patch over it.

### 3. Reuse, don't replace
> "复用，不要替换"

When asked to extend a UI area, ADD functionality to the existing component. Never remove it and build a separate replacement.

### 4. Locate the root cause before coding
> "先定位准，再修复"

Trace the full data path (schema → query → serialization → component) and state the root cause before touching code. Never guess at a fix and hope.

### 5. Mobile-first, Twitter/X quality bar
The primary audience is mobile users. Every interaction must feel as smooth as Twitter/X: fast tap targets, smooth scrolling, no layout shift on focus, timely refresh after actions.

## Technical Conventions

### Architecture
- **Route groups:** `(auth)` for login/register, `(shell)` for the main app shell
- **Canonical paths:** `/u/[username]` is the profile route. `/[username]` redirects to it.
- **Icons:** `@/components/icons` (the single `src/components/icons.tsx` module) is the only icon source — import icons from there directly.
- **FollowButton:** `@/components/profile/FollowButton` is the one implementation (no shim copies exist).
- **Runtime identity:** `SiteConfig` row 1 owns origin, brand and new API-key prefix. Read through `src/lib/site.ts`; never add domain or brand fallbacks to application code.
- **Feed foundation:** timeline, interactions, identity and API must remain independent of the chemical product layer. CAS is the only structured compound tag; `@username` is a passive link without publish-time mention alerts.

### Database
- **Prisma schema is source of truth.** No `db push` in production — use migrations.
- `postInclude(userId)` is a **function** that returns the full Prisma include shape.
- **Repost = dual record:** creates a `Repost` row AND a `Post` (empty content + `quotePostId`).
- **Replies:** `Post.parentId` self-reference (no Comment model exists in the schema).
- **Chemical** is an M2M model linking posts to CAS numbers. The former **Tag** model was removed in migration `20260710040000_remove_tag_system`.

### Image Pipeline
- `/api/upload` processes every uploaded image through `src/lib/image.ts` → `processAndStoreImage(buffer, mimeType)`.
- Static images → WebP @ q80, max 2048px. GIF → passthrough.
- `/api/posts` never receives image bytes — it only accepts already-uploaded `/uploads/` URLs (max 4) and links them to the post.

### Frontend Rules
- **All text inputs ≥ 16px** — prevents iOS Safari focus-zoom that breaks fixed layouts.
- **No raw `<img>`** for post images going forward — use `next/image` with proper sizing. (Legacy `<img>` exists but new code must use `next/image`.)
- All new components use design tokens from `globals.css` `@theme`, not hardcoded colors.

### API
- All mutations require auth — route handlers use `requireAuth()` / `requireWrite()` / `requireAdmin()` from `src/lib/api-auth.ts` (server components use `getCurrentUser()`) — and verify resource ownership.
- Rate limiting lives in route handlers via `src/lib/rate-limit.ts` (token bucket, per identity: API key / user / IP). `src/proxy.ts` only redirects unauthenticated page traffic — it does no rate limiting.
- Use parameterized Prisma queries only. No string-interpolated SQL.
- Full endpoint inventory and contract: `docs/API-BASELINE.md`. Architecture boundaries: `docs/ARCHITECTURE.md`.
- API keys serve purely as unified identity credentials across REST and MCP. Capabilities are dynamically derived server-side based on account verification standing (`active` + current `verified` for write; unverified/restricted for read-only; suspended for 401). `requireWrite()` enforces dynamic write access. Invalid Bearer credentials never fall back to a session cookie; password changes require a browser session.
- Do not keep runtime compatibility branches for retired schema or API behavior. Migrate data and update the contract directly.

### Deployment
- Build with `npm run build`; production server manages the Next.js process behind a reverse proxy.
- Reverse proxy (e.g. Nginx) serves `/_next/static/` and `/uploads/` directly (not through Node.js).
- **Never commit `.env`, `public/uploads/`, `logs/`, or `node_modules/`.**

### Toolchain
- Node ≥ 22; install with `npm ci`; standard flow (env vars, migrations, checks) is in `DEVELOPMENT.md`. `npm run build` requires a reachable, migrated database (`/sitemap.xml` prerenders at build time).
- Tests: `npm test` (unit + API contract), `npm run test:unit` (no DB needed). API contract tests boot their own throwaway `cascool_test` database — never point them at a real one.

## Development Log (DEVLOG.md)

All changes must be logged in `DEVLOG.md` using this format:

```markdown
### YYYY-MM-DD — [Short Title]

**Context:** Why this change was needed.

**Changes:**
- Bullet list of what changed (files, schema, behavior)

**Pitfalls / Notes:**
- Anything tricky future devs should know
```

Append new entries at the bottom of the Milestone Log section. Do not rewrite history — the log is chronological.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
