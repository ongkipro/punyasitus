# Local Entity Schema & Crawlable Content Integration (`TASK-053`, `REQ-054`)

> Additive contract documentation complementing `docs/api/openapi.json` (do not edit `openapi.json` directly outside TASK-024).

## Overview

`TASK-053` integrates published tenant facts across the public SSR shell so company-profile, article, offering, and taxonomy routes emit honest, zero-JS-crawlable HTML and a single authoritative Schema.org `@graph` JSON-LD payload (`PLAN §15.4`, `§15.7`, `REQ-054`).

---

## 1. Single `<head>` & Schema.org Authority

- **Component:** `apps/web/src/components/seo/PublicSeoHead.astro` paired with `<Layout managedHead={true}>` (`apps/web/src/themes/default/Layout.astro`) across ALL public tenant routes including tenant homepage `/` (`apps/web/src/pages/index.astro`), static pages (`[...slug].astro`), blog, offerings, and taxonomy archives.
- **Composer:** `composePublicSeoHead()` in `packages/core/src/seo/local-entity.ts` wraps:
  - `renderSeoHeadHtml()` (`packages/core/src/og-generator.ts`, `TASK-016`)
  - `renderVerificationMetaTags()` (`packages/core/src/seo/editor.ts`, `TASK-052`)
  - `generateSchemaGraph()` (`packages/core/src/schema-generator.ts`, `TASK-015`)
- **Invariants:**
  - Exactly ONE `<title>`, at most ONE `<meta name="description">`, ONE `<meta name="robots">` (even under `siteVisibility === "noindex"` or `isPreview`), at most ONE `<link rel="canonical">`, and at most ONE `<script type="application/ld+json">` (`@graph`) per response.
  - Default robots directives for indexable published pages: `index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1`.
  - When `seo-ai-autopilot` is disabled (`enabled = 0`) OR when `loadPublicSeoCtxSafe()` encounters a `TenantStore` DB error (fail-closed `FAIL_CLOSED_PUBLIC_SEO_CONTEXT`), `composePublicSeoHead()` emits minimal `<title>` + mandatory `trial`/`noindex`/`error` robots safety rules without plugin verification tags or OG/schema bloat (`DEC-039`).
  - RSS 2.0 discovery `<link rel="alternate" type="application/rss+xml" href="https://<primaryOrigin>/blog/feed.xml" />` is emitted ONLY when `blogEnabled === true` on verified serving routes (`PLAN §15.7`).
  - Published webmaster verification meta tags (`google-site-verification`, `msvalidate.01`, `yandex-verification`) read strictly from `published_json` — NEVER `draft_json`.

---

## 2. Honest Visible-Fact Schema.org `@graph` Parity

- **Single Engine:** `generateSchemaGraph()` in `packages/core/src/schema-generator.ts` (zero second schema engine).
- **Publish-Safe Type Gating (`resolvePublishSafeSchemaType`):**
  - Pages: `FAQPage` is emitted ONLY when visible structured `config.items` FAQ Q&A entries exist (matching `SectionFaq.astro` 1:1 — never scraped from unrendered `bodyHtml`); otherwise safely downgrades to `WebPage`. `ProfilePage` + `Person` is preserved for `personal_brand` and `sales_executive` homepages.
  - Posts: `BlogPosting` (default), `Article`, or `NewsArticle`.
  - Offerings: `Service` NEVER becomes `Product` or invents `Offer`; explicit `Product` override requires visible `fixed`/`from` price; explicit `TouristTrip` override requires visible itinerary/destination facts.
- **Zero Fabrication:**
  - Zero fabricated `AggregateRating`, `review`, `shippingDetails`, `hasMerchantReturnPolicy`, `checkout`, private addresses for service-area businesses, or deprecated `ProfessionalService`.
  - Safe JSON-LD script escaping via `safeJsonLdStringify` (`<` -> `\u003c`, neutralizing `</script>` breakouts).

---

## 3. Multi-Branch Storefront & `@graph` Parity (`TASK-088` Handoff Completed)

- `SectionRenderer.astro` mounts `SectionBranches.astro` for `branches` sections using published active branches (`listActiveBranchesForPublic()`, max 10).
- Standard homepages with active branches and no explicit `branches` section render `<SectionBranches>` automatically, and `buildEnrichedSchemaBusinessProfile()` emits branch `LocalBusiness` nodes into `@graph` strictly when branches are visibly rendered on the page (`subOrganization` / `parentOrganization`, `telephone` strictly from visible `branch.phone`).
- Zero third-party map `<iframe>` embeds before visitor consent; static HTTPS Maps links and `tel:` / `wa.me` links work with JavaScript disabled.

---

## 4. Public Author Profiles & Server-Rendered TOC (`PLAN §15.7`)

- **Repository:** `packages/db/src/authors/index.ts` over existing `authors` table (`0001_initial_tenant.sql`, zero new migrations).
  - Fields: display `name`, `bio` (max 300 chars), verified ready tenant `avatar` (`media_items.kind = 'image' AND status = 'ready' AND deleted_at IS NULL`), and up to `5` validated public HTTPS `sameAs` URLs stored in `social_url`.
  - No public author archive route in v1 (`PLAN §15.7`).
- **Article Rendering (`apps/web/src/pages/blog/[slug].astro`):**
  - Renders visible Author Box (`data-testid="blog-author-box"`) with avatar (or initials fallback), display name, bio, and `sameAs` links matching the Article's `Person` node (`name`, `description`, `image`, `sameAs`).
  - `injectTocHeadingAnchors()` guarantees deterministic `id="..."` attributes on every `<h2>`/`<h3>` in sanitized post HTML matching the server-rendered `<nav aria-label="Daftar isi">` anchor links 1:1 with zero JavaScript.

---

## 5. Crawlable Published Tenant-Local Internal Links

- `sanitizeTenantLocalHref()`, `sanitizeHtmlInternalLinks()`, and `auditRenderedPublicPageSeo()` (`packages/core/src/seo/local-entity.ts`) + `loadPublishedTenantInternalLinkTargets()` (`packages/db/src/seo/index.ts`) enforce:
  - `loadPublishedTenantInternalLinkTargets()` includes `/kebijakan-privasi` ONLY if a published `kebijakan-privasi` page exists, `/blog` & blog archives ONLY when `blogEnabled === true`, catalog base paths (`/layanan`, `/produk`, `/tour`, `/kendaraan`) ONLY when `catalogEnabled === true` and matching published offerings exist, and taxonomy archives ONLY when enabled and `>= 1` published item references them.
  - Real `<a href>` anchors on breadcrumbs, pagination (`rel="prev"` / `rel="next"`), verified clickable category/tag chips (falling back to plain non-link badges when archive is disabled/empty), related posts/offerings, and published service/catalog CTAs.
  - Unrendered/draft/unpublished internal paths, cross-tenant SaaS subdomain links, admin/preview/API links, numeric-ID URL segments, and `javascript:`/`data:` schemes are unwrapped to plain text; tracking parameters (`utm_*`, `fbclid`, `gclid`) are stripped.
