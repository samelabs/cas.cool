# AI Development Rules — cas.cool (ChemHub)

> **Read this before writing any code.** This is the authoritative style guide for all AI agents and contributors.

## Project Identity

- **Product:** cas.cool — a Twitter/X-style social platform for the global chemical trade
- **Stack:** Next.js 16 + React 19 + Prisma 7 + PostgreSQL 16 + Tailwind CSS 4
- **Live:** https://cas.cool · PM2 process `cascool` · Port 3000
- **Server:** 3.6GB RAM — every MB matters. No unnecessary dependencies.

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
- **Icons:** `@/components/icons` is canonical. `@/components/ui/icons` is a re-export shim.
- **FollowButton:** `@/components/profile/FollowButton` is canonical. `@/components/ui/FollowButton` is a re-export shim.

### Database
- **Prisma schema is source of truth.** No `db push` in production — use migrations.
- `postInclude(userId)` is a **function** that returns the full Prisma include shape.
- **Repost = dual record:** creates a `Repost` row AND a `Post` (empty content + `quotePostId`).
- **Replies:** `Post.parentId` self-reference (Comment table is unused, 0 rows).
- **Chemical & Tag** are independent M2M models, not flat fields on Post.

### Image Pipeline
- All uploads go through `src/lib/image.ts` → `processAndStoreImage(buffer, mimeType)`
- Static images → WebP @ q80, max 2048px. GIF → passthrough.
- Both `/api/upload` and `/api/posts` must use this shared module.

### Frontend Rules
- **All text inputs ≥ 16px** — prevents iOS Safari focus-zoom that breaks fixed layouts.
- **No raw `<img>`** for post images going forward — use `next/image` with proper sizing. (Legacy `<img>` exists but new code must use `next/image`.)
- All new components use design tokens from `globals.css` `@theme`, not hardcoded colors.

### API
- All mutations require auth (`getCurrentUser()`) and verify resource ownership.
- Rate limiting lives in `src/proxy.ts` (token bucket, per-user or per-IP).
- Use parameterized Prisma queries only. No string-interpolated SQL.

### Deployment
- `npm run build` → `pm2 restart cascool`
- Nginx serves `/_next/static/` and `/uploads/` directly (not through Node.js).
- **Never commit `.env`, `public/uploads/`, `logs/`, or `node_modules/`.**

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
