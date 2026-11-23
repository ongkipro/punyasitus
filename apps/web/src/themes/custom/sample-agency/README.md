# Sample Agency Custom Theme (`custom-sample-agency`)

Reference bespoke agency custom theme built strictly following [`docs/themes/THEME-DEVELOPMENT.md`](../../../../../../docs/themes/THEME-DEVELOPMENT.md).

## Identity

- **Theme ID:** `custom-sample-agency`
- **Tier:** `custom` (`private_client` agency distribution)
- **Version:** `1.0.0` (`schemaVersion: 1`)
- **Base Platform Theme:** `compro`
- **Registered In:** `apps/web/src/core/theme-registry.ts` (explicit build-time static import)

## Design Decisions

- **Palette (WCAG 2.2 AA >= 4.5:1 verified):**
  - Surface: Warm Editorial Alabaster (`#fbf9f5`) / Warm Linen (`#f2ede4`)
  - Primary: Deep Architectural Navy (`#1c2d4a`)
  - Secondary: Burnt Terracotta (`#9c3d1a`)
  - Ink: Charcoal (`#171a1f`) / Slate (`#4a515d`)
- **Typography:** Zero-download system font stack (`fontFamily: "system"`) by default, respecting `REQ-020` / `DEC-035 C14`.
- **Geometry:** Sharp `2px` architectural corners with hairline `1px` borders and `3px` editorial top accents.
- **JS Budget:** `0 KiB` custom theme JavaScript (pure HTML/CSS progressive enhancement; all interactive navigation/consent/disclosure primitives come from the shared platform shell).

## Boundaries & Compliance

- Zero direct imports of `@punyasitus/db`, `@punyasitus/auth`, `cloudflare:workers`, `node:*`, `drizzle-orm`, `@radix-ui/*`, `@base-ui/react`, or admin UI components.
- Renders all 7 public routes (`home`, `page`, `blog_index`, `blog_post`, `catalog_index`, `catalog_detail`, `not_found`) strictly wrapped inside the shared security, `<SEOHead.astro>`, Schema.org, and `<Consent.astro>` shell.
- Delegates all closed section types (`REQ-019`) to the shared `SectionRenderer.astro` so theme switching is 100% lossless.
- Zero cart, checkout, visitor account, or payment UI (`DEC-008`).

## Changelog

- `1.0.0` — Initial reference custom agency theme implemented for `TASK-018`.
