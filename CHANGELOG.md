# Changelog

All notable changes to CAS.cool are documented here.
The open-source release is v1.0.0. The production site runs an iterative
version (1.1.x) where x increments with each deploy.

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
