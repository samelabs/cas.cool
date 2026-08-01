# Changelog

All notable changes to CAS.cool are documented here.
The open-source release is v1.0.0. The production site runs an iterative
version (1.1.x) where x increments with each deploy.

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
