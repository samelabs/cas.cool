# CAS.cool Development Log

> Chemical discovery and sharing social network — Next.js 16 + Prisma 7 + PostgreSQL
> Live at **https://cas.cool** | PM2 process `cascool` | Port 3000

---

## Project Overview

CAS.cool is a Twitter/X-style social platform purpose-built for the global chemistry community. Users share CAS-numbered chemical discoveries, discuss synthesis and properties, and connect with fellow chemists through a CAS-number-centric content discovery system.

**Tech Stack:** Next.js 16.2.9 · React 19 · TypeScript 5 · Tailwind CSS 4 · Prisma 7.8 · PostgreSQL · PM2 · Nginx

**Scale:** ~123,000 users · ~149,500 posts · ~142,600 chemical records · ~113 tags

---

## v1.0 Release — 2026-06-19

### Security
- **Session DB validation**: `getSession()` now verifies the token still exists in the `Session` table and hasn't expired. Previously, only JWT signature was checked — a stolen token stayed valid for 30 days even after password change/logout. Password change invalidates all sessions; logout invalidates the current one.
- **Soft-delete filter**: API messages route now filters out conversations the current user has soft-deleted (`deletedBy1`/`deletedBy2`).

### Navigation & UX
- **Bookmarks entry**: Added Bookmarks to both Sidebar (desktop) and MobileNav (mobile bottom bar). The page + API already existed but had zero navigation entry points.
- **Desktop sidebar cleanup**: Removed redundant items — Compose CTA (reachable via timeline compose box), Sign in/Sign up buttons (reachable via landing page CTAs).
- **Auth page mobile nav**: Login/register pages now have a minimal bottom bar (Home, Explore) on mobile so users aren't stranded.
- **AutoResizeTextarea**: Shared textarea component replacing all 3 hardcoded `<textarea rows=N>` instances (ComposeBox, MobileReplyBar, MessageThread). Auto-adjusts height to content, eliminating internal scrollbars that caused cursor jump on mobile.

### Content Discovery
- **Tag pages**: Created `/tag/[slug]` route with SEO metadata, related tags, and post listing. PostCard hashtag links now point to `/tag/slug` instead of `/explore?q=`.
- **Spam protection**: Posts API caps at 8 tags + 10 mentions. `extractTags()` cap aligned to 8.
- **Explore infinite scroll**: Latest list replaced from `take:30` snapshot to SWR-based infinite scroll via `LatestPostList` client component.

### Notifications
- **Dedup**: LIKE and COMMENT notifications use check-then-bump — no more duplicate notifications from repeated like/unlike cycles.
- **Conditional read-marking**: Notifications page only runs `updateMany` when there are actually unread items.

### Direct Messages
- **Message timestamps**: Smart time separators in conversation view (sender change or >5min gap).
- **Soft-delete**: Schema added `deletedBy1`/`deletedBy2` to `Conversation`. One-sided delete hides the conversation locally; both-sided delete permanently purges. New messages reset the flags.

### Code Quality
- Removed dead `email`/`username` fields from `JWTPayload` interface.
- `extractTags()` return cap aligned to 8 (was 10, inconsistent with API's MAX_TAGS=8).

---

## Milestone Log

### 2026-06-10 — Initial Build & Discuz Migration

- **Platform rebuilt** from legacy Discuz (PHP/MySQL) to Next.js 16 + Prisma + PostgreSQL
- **Data migrated:** 122,998 users + 149,495 posts from Discuz MySQL database
- **Auth system:** JWT-based with bcrypt password hashing, 30-day session tokens stored in DB
- **Core features shipped:**
  - User registration, login, profile pages (bio, avatar, banner, location, website)
  - Post creation (text + images), timeline feed (For You / Following tabs)
  - Reply system (Post.parentId self-referencing tree)
  - Like, Bookmark, Repost (quote post) actions
  - Follow / unfollow system
  - Direct messages (conversation-based, 1:1)
  - Notifications (like, comment, follow, repost, message, mention)
  - Search (posts + users + chemicals)
  - Mobile-responsive layout with bottom nav + desktop sidebar

### 2026-06-14 — Launch & Brand Identity

- **Site went live** at https://cas.cool
- **Nginx configured** as reverse proxy with SSL (Let's Encrypt, shared cert with huagongshe.com)
- **Upload system:** `/uploads/` served directly by Nginx (bypasses Next.js for performance)
- **PM2 configured** with `ecosystem.config.cjs` (fork mode, max_memory_restart: 512M)
- **Old Discuz Nginx config** backed up at `/root/cas.cool.discuz.bak`

### 2026-06-15 — Architecture: Chemical + Tag Independent Models

**Major schema refactor** — Chemical and Tag promoted to first-class Prisma models:

| Model | Purpose | Key Fields |
|-------|---------|------------|
| **Chemical** | CAS-numbered chemical entity | `casNumber` (unique), `name`, `formula`, `aliases[]`, `postCount` (denormalized) |
| **Tag** | General social hashtag | `name` (unique), `slug` (unique), `postCount` (denormalized) |

- **M2M relations:** `_ChemicalToPost` (A=Chemical.id, B=Post.id) + `_PostToTag` (A=Post.id, B=Tag.id)
- **Post model simplified:** Dropped flat `casNumber/chemicalName/formula/tags` String fields
- **Data migration:** 142,621 Chemical records + 113 Tags extracted from existing post content
- **Auto-detection:** `extractCASNumber()` + `extractChemicalName()` + `extractTags()` in utils.ts run on post creation
- **UI:** ComposeBox gets FlaskIcon button for manual CAS entry; PostCard renders chemicals as FlaskIcon chips + tags as # links
- **`postInclude()`** in serialize.ts refactored from a static object to a **function** (takes currentUserId) returning chemicals/tags/quotedPost M2M includes

### 2026-06-15 — UI/UX Polish Round 1

- **Full English UI** enforced (user corrected multiple Chinese text hallucinations — app UI must ALWAYS be English)
- **Multi-image support:** Twitter-style grid layouts (1/2/3/4 image layouts) with full-screen ImageModal viewer
- **Image limits:** Max 4 images per post, enforced at frontend + API
- **Mobile reply bar** (MobileReplyBar.tsx): floating bar above bottom nav with collapsed/expanded states
- **z-index layering** system established to fix floating overlay penetration issues
- **Repost mechanism** clarified: creates BOTH Repost record + Post entry (empty content + quotePostId) so reposts appear in timeline

### 2026-06-16 — Mobile Width Overflow Fixes

Systematic fix for recurring "input focus causes width blowout" pattern across multiple components:

| Component | Root Cause | Fix |
|-----------|-----------|-----|
| **MobileReplyBar** | `textarea` missing `min-w-0` → flex row overflow; `text-[15px]` < 16px → iOS auto-zoom; no max-width on `fixed` container | `min-w-0` + `text-base` (16px) + `mx-auto max-w-[600px]` + VisualViewport keyboard tracking |
| **PostActions** | z-index context issues | Layered z-index system |

**Design rule established:** All input fields MUST use ≥16px font (prevents iOS Safari focus zoom)

### 2026-06-17 — Image Pipeline Standardization

- **Created `src/lib/image.ts`** — single shared module `processAndStoreImage(buffer, mimeType)`
- **Static images** (jpg/png/webp): EXIF auto-rotate → resize longest edge to 2048px → re-encode WebP @ quality 80
- **GIF images:** passthrough unchanged (sharp would flatten animation to first frame)
- **Magic bytes validation** + MIME cross-check + decode-fail rejection
- **Both upload paths unified:** `/api/upload` (avatar/cover) and `/api/posts` (multipart) both call shared module
- **`sharp` promoted** from indirect to direct dependency
- **Verified results:** 9MB JPEG → 1.4MB WebP (-84%), 36MB PNG → 1.5MB (-96%)

### 2026-06-17 — ComposeBox Width System Fix

- **CAS input field** `text-sm`(14px) → `text-base`(16px) — prevents iOS focus zoom
- **ComposeBox container** unified padding model: `w-full overflow-hidden p-4` (border/bg delegated to parent)
- **compact mode** `p-3` → `px-4 py-3` — aligns with info bar padding
- **TimelineFeed:** Removed `isLoggedIn &&` gate on TimelineTopBar → unauthenticated users now see login prompt (FlaskIcon + "Sign in to post or comment" + Sign up button)
- **compose/page.tsx:** Wrapper `p-4` → `border-b border-line bg-brand-tint/30` (eliminates double padding)

### 2026-06-18 — Comprehensive Audit

Full-stack audit completed (see `AUDIT.md`). Key findings addressed:
- **PostgreSQL backup** — critical gap identified, backup cron established
- **Root error/404 pages** — added for unbranded fallback prevention
- **robots.txt + sitemap.xml** — SEO infrastructure added
- **Security headers** — Nginx hardening
- **PM2 dump** — refreshed after process changes

### 2026-06-20 — Hotfix: proxy cookie deletion broke login

**Context:** Commit 8291fc8 (stale-cookie fix) deleted the `cas_session` cookie unconditionally for any `/login` or `/register` request that carried one. This over-corrected: after a successful login, the client calls `router.push('/')` then `router.refresh()`. If the refresh fired an RSC request to `/login` before navigation completed, the proxy deleted the just-set valid cookie — losing the login state. The original intent (help users trapped by a dead cookie after password change/restart) was correct, but the implementation nuked valid cookies too.

**Changes:**
- Added `hasValidJwt(req)` helper in `proxy.ts` — checks JWT signature + expiry without DB lookup (proxy already uses `jose.jwtVerify` for rate-limit identity)
- `/login` + `/register` auth gate now branches: valid JWT → redirect home (standard, no deletion); invalid/expired → clear stale cookie + allow; no cookie → allow
- Restored the standard "logged-in users bounce off auth pages" behavior while preserving the stale-cookie escape hatch

**Pitfalls / Notes:**
- The `router state header could not be parsed` errors in the log are NOT caused by this — they pair with `Failed to find Server Action` errors and appear after every `build + pm2 restart` (stale client-side RSC state). They clear on page refresh.
- Proxy-level JWT check is optimistic only; `getCurrentUser()` in server components still validates against the DB. Don't add DB calls to the proxy (cold-start / latency).

### 2026-07-21 — Production Repository and Listener Cleanup

**Context:** The production server contained the current site icons as uncommitted files, and the Next.js process used the CLI default `0.0.0.0` listener even though Nginx is the only public entry point.

**Changes:**
- Adopted the deployed Apple touch icon and favicon as the versioned source of truth.
- Bound `next start` explicitly to `127.0.0.1:3000` in the PM2 ecosystem configuration.
- Added the active Nginx reverse-proxy configuration under `deploy/` and aligned HTTPS listeners.
- Removed the obsolete Hermes API implementation plan; it described `prisma db push`, which conflicts with the current migrations-only production rule.
- Re-established the local, GitHub, and production working trees on the same `main` history.

**Pitfalls / Notes:**
- Keep `public/uploads`, `.env`, logs, `.next`, and `node_modules` outside Git.
- Nginx remains the only public listener; do not remove the explicit loopback hostname from PM2.

### 2026-07-21 — Public API Runtime Separation

**Context:** The externally consumed `/api/v1` routes were compiled into the same Next.js process as the website. That coupled API availability and resource controls to frontend deployment and left no process-level boundary between the public contract and browser BFF routes.

**Changes:**
- Added a dependency-light public API service with a dedicated Prisma pool on `127.0.0.1:8001`.
- Preserved the existing `/api/v1` URLs, API-token authentication, response shapes, and mutation semantics.
- Added bounded JSON bodies, pre-authentication and per-token rate limits, structured request logs, health checks, timeouts, and graceful shutdown.
- Added a second PM2 application and explicit Nginx routing for `/api/v1/` while keeping both Node listeners private.
- Replaced stale Tencent npm tarball URLs in the lockfile with the canonical npm registry so clean builds are reproducible.
- Removed the duplicate Next.js `/api/v1` handlers after production traffic
  passed direct response-equivalence checks and switched to the API process.
- Reduced the web-side API-key module to key generation only; token validation
  now exists in one place, inside the public API runtime.
- Added an application-level Web guard returning JSON 404 for direct `/api/v1`
  requests, preventing the generic page-not-found redirect from crossing the
  process boundary.

**Pitfalls / Notes:**
- Deploy the API alongside the old Next routes, validate it on port 8001, and only then switch Nginx; remove the duplicate Next handlers after the live cutover succeeds.
- `/healthz` is loopback-only and must not be proxied publicly.
- The API entry point loads the project `.env` itself; PM2 does not provide an
  `env_file` application option. Next.js continues to load `.env` natively.
- Keep browser/session routes in the web BFF namespace; do not add new public API handlers under `src/app/api/v1`.

---

### 2026-07-26 — Agent Discovery Layer (llms.txt + API self-description)

**Context:** cas.cool's public API had 12 endpoints but zero discoverability. An agent given an API key had to guess paths or read source code — there was no `GET /api/v1/` index, no `whoami`, no machine-readable capability manifest. The user framed this as a critical capability gap: "cas.cool 首页原生缺少对 agent 来访的接待表达."

**Changes:**
- **`services/public-api/src/manifest.ts`** (new): Single source of truth for the API surface. A structured `Manifest` object listing every endpoint with method, path, summary, description, auth requirement, and typed params. Consumed by `GET /api/v1/`.
- **`services/public-api/src/server.ts`**: Intercept `/api/v1` and `/api/v1/` before authentication → return the manifest JSON. This is the agent entry point — no key required to discover what's available.
- **`services/public-api/src/routes.ts`**: Added `GET /api/v1/me` — returns the authenticated user's identity (username, displayName, verificationStatus, role) + API key metadata (name, prefix, createdAt, lastUsedAt, expiresAt). Solves the "who am I acting as?" question.
- **`public/llms.txt`** (new): Site-level agent landing page following the llms.txt convention. Describes the platform, quick-start flow (discover → identify → act), auth scheme, rate limits, pagination, error format, and a capability table with endpoint mappings.
- **`services/public-api/test/routing.test.mjs`**: Added `/api/v1/me` to the route matching test.
- **Nginx (`sites-available/cas.cool.conf`)**:
  - `location = /api/v1 { return 301 /api/v1/; }` — trailing-slash normalization for the discovery index.
  - `location = /llms.txt { alias .../public/llms.txt; }` — serves llms.txt directly from nginx, bypassing the Next.js `/[username]` dynamic route which was catching `/llms.txt` as a username and 307-redirecting to `/u/llms.txt`.

**Pitfalls / Notes:**
- **`/[username]` route swallows top-level files**: Next.js dynamic routes take precedence over `public/` static files for single-segment paths. `/llms.txt` was intercepted by `/[username]` → redirected to `/u/llms.txt`. Fix: serve via nginx `location =` exact match. Any future top-level static file (e.g. `/ai.txt`) will hit the same issue unless explicitly handled in nginx.
- **File permissions**: `write_file` creates files with mode 600 (owner-only). nginx workers run as `www-data` and got 403. Must `chmod 644` any file under `public/` meant to be served directly.
- **manifest.ts is not just documentation — it's the contract.** When new endpoints are added to routes.ts, the corresponding entry must be added to manifest.ts. The discovery index is only as good as its accuracy.

## Architecture Decisions

### ADR-001: Post.parentId Self-Referencing for Replies
Replies use `Post.parentId` self-reference (not a separate Comment table). The `Comment` model exists in schema but is unused (0 rows). This was chosen for simplicity — replies are just posts with a parentId.

### ADR-002: Repost = Dual Record
Reposts create both a `Repost` record AND a `Post` entry (empty content + `quotePostId`). This ensures reposts appear naturally in the timeline feed without a separate query union.

### ADR-003: Chemical & Tag as Independent M2M Models
Chemicals and Tags are independent Prisma models with M2M relations to Post. This enables: trending by chemical, dedicated CAS pages, tag-based discovery, and multi-chemical per post support.

### ADR-004: Image Processing Pipeline
All uploads flow through one shared module. Static → WebP. GIF → passthrough. This prevents code duplication and ensures consistent compression.

### ADR-005: 16px Minimum Font for Inputs
All text inputs use ≥16px to prevent iOS Safari's auto-zoom-on-focus behavior that breaks `position: fixed` element widths on mobile.

### ADR-006: Public API Runtime Isolation
The externally consumed `/api/v1/*` contract runs as a dedicated Node.js process on `127.0.0.1:8001`. Next.js remains the web/BFF process on `127.0.0.1:3000`. Nginx is the only public listener and routes the versioned API namespace explicitly. Public API authentication, rate limiting, request-size limits, logging, database pooling, and lifecycle management belong to the API process rather than the web proxy.

---

## Key Files

| Path | Purpose |
|------|---------|
| `prisma/schema.prisma` | Full database schema (13 models) |
| `src/lib/auth.ts` | JWT session management |
| `src/lib/db.ts` | Prisma client (pg adapter) |
| `src/lib/serialize.ts` | Post serialization with M2M includes |
| `src/lib/image.ts` | Unified image processing pipeline |
| `src/lib/utils.ts` | CAS/tag extraction utilities |
| `src/proxy.ts` | Next.js proxy + rate limiting |
| `ecosystem.config.cjs` | PM2 configuration |
| `next.config.ts` | Next.js configuration |
