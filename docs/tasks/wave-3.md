# Wave 3 — Core CMS APIs, Cloudflare Images/Video Pipeline, Shared Theme Shell & SEO Foundations (M1)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

### TASK-004: Hierarchical Navigation Menu Builder API & Data Tree
- **Milestone:** M1
- **Requirement:** REQ-006
- **Constraints:** REQ-007, REQ-034
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/api/tenants/[tenantId]/menus/**`, `packages/core/src/menu-builder.ts`, `packages/db/src/menus/**`, `tests/task-004/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-006; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-024, TASK-025
- **Verification:** Done when `pnpm test:integration` including tests/task-004 executes successfully and demonstrates: Save and load preserve order; cyclic, cross-menu, cross-tenant and depth >3 parents fail; reject unsafe URLs.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-005: Static Pages Manager API with SEO Overrides
- **Milestone:** M1
- **Requirement:** REQ-008
- **Constraints:** REQ-034, REQ-036, REQ-061
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `apps/web/src/pages/api/tenants/[tenantId]/pages/**`, `packages/db/src/pages/**`, `packages/db/src/identifiers/**`, `packages/core/src/slug/**`, `packages/core/src/content/**`, `tests/task-005/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-008; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-027
- **Verification:** Done when `pnpm test:integration` including tests/task-005 executes successfully and demonstrates: CRUD, per-tenant sequential numbers allocated without reuse under concurrent creates, title-generated slugs (diacritics, -2 suffix, 80-character cap, fallback), manual-conflict 422, reserved slugs, tenant-local slug uniqueness including former slugs, SEO validation, `layout_mode` (`standard` vs `focused` Landing Page Focus Mode hiding top/footer nav menus), draft/private preview and publish/unpublish pass; stale update returns 409.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-006: Blog Articles Manager API with Rich Text & Categories
- **Milestone:** M1
- **Requirement:** REQ-009
- **Constraints:** REQ-034, REQ-036, REQ-061
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/api/tenants/[tenantId]/posts/**`, `apps/web/src/pages/api/tenants/[tenantId]/categories/**`, `apps/web/src/pages/api/tenants/[tenantId]/tags/**`, `packages/db/src/posts/**`, `packages/core/src/content/**`, `tests/task-006/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-009; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-005
- **Verification:** Done when `pnpm test:integration` including tests/task-006 executes successfully and demonstrates: Persist categories/tags and author; posts use shared number/slug rules; sanitize hostile rich text; calculate reading time; draft and cross-tenant associations remain inaccessible.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-007: Media Library Upload Pipeline & Automated WebP Conversion
- **Milestone:** M1
- **Requirement:** REQ-010
- **Constraints:** REQ-034, REQ-039, REQ-064
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `apps/web/src/pages/api/tenants/[tenantId]/media/**`, `apps/web/src/worker/queues/media/**`, `packages/db/src/media/**`, `packages/core/src/media/**`, `packages/db/src/storage-usage/**`, `tests/task-007/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-010; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-028
- **Verification:** Done when `pnpm test:integration` including tests/task-007 executes successfully and demonstrates: Uploads stream through the admin endpoint with a hard byte counter (no presigned browser PUT); valid JPG, PNG, WebP, HEIC/HEIF, GIF (first frame) and TIFF sources up to 5,000,000 bytes are eligible and 5,000,001-byte sources abort (browser island converts AVIF client-side before upload; SVG and BMP are rejected), including direct upload/finalize bypass attempts; derivative file names carry the slugified original name; reject zero-byte/corrupt input, MIME spoofing, oversized pixels, foreign object keys and expired uploads. Bounded jobs using the Cloudflare Images binding produce a <=2,000,000-byte normalized master plus image/webp responsive/thumbnail/OG derivatives with EXIF/location stripped and no public original fallback; failed/abandoned quarantine objects expire safely. Quota counts normalized stored bytes (`1 GB` paid/grace/locked and `100 MB` trial) pass at the exact limit and fail one byte over with STORAGE_QUOTA_EXCEEDED, parallel intents cannot exceed it, expired intents release reservations, trash counts until purge, and 50/hour or 200/day intents return 429. Retry is idempotent; deletion protects published references. Video input is rejected here and handled only by TASK-060.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-008: Site Identity & Brand Configuration API
- **Milestone:** M1
- **Requirement:** REQ-011
- **Constraints:** REQ-034, REQ-036
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/api/tenants/[tenantId]/identity/**`, `packages/db/src/identity/**`, `tests/task-008/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-011; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-027
- **Verification:** Done when `pnpm test:integration` including tests/task-008 executes successfully and demonstrates: Identity save validates owned logos, title and contacts; publish increments revision; editor permission and stale version tests fail safely.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-009: Typed Offerings (`service`, `product`, `tour`, `vehicle`) & Categories Management API
- **Milestone:** M1
- **Requirement:** REQ-012
- **Constraints:** REQ-013, REQ-016, REQ-034, REQ-061
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/api/tenants/[tenantId]/catalog/**`, `packages/db/src/catalog/**`, `packages/core/src/catalog/**`, `tests/task-009/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-012; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-027, TASK-010, TASK-011
- **Verification:** Done when `pnpm test:integration` including tests/task-009 executes successfully and demonstrates: Hybrid `offerings` table (`service` `/layanan`, `product` `/produk`, `tour` `/tour`, `vehicle` `/kendaraan`) persists `fixed`/`from`/`range` (`price_max >= price`)/`on_request` prices, `negotiable` flag, ordered gallery (`<=12` images), categories, badges and validated JSON `attributes`; action discriminator (`whatsapp`/`external_link`/`inquiry`/`book`) requires valid WA or HTTPS config; wrong-tenant media/category and invalid prices fail.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-012: Shared Theme Base Shell (`themes/default`) & Dynamic Token Injection
- **Milestone:** M1
- **Requirement:** REQ-018
- **Constraints:** REQ-020, REQ-040
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/themes/default/Layout.astro`, `apps/web/src/styles/site/**`, `apps/web/src/core/public-data.ts`, `tests/task-012/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-018; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-002, TASK-027, TASK-032
- **Verification:** Done when `pnpm test:e2e` including tests/task-012 executes successfully and demonstrates: Render published theme tokens and scoped public content without flash; malformed token values never become executable CSS; keyboard/mobile shell works.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-013: Modular Section Registry & Dynamic Page Assembly
- **Milestone:** M1
- **Requirement:** REQ-019
- **Constraints:** REQ-036, REQ-040
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/themes/default/sections/**`, `apps/web/src/core/section-registry.ts`, `packages/core/src/theme/**`, `tests/task-013/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-019; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-012, TASK-005, TASK-006, TASK-007, TASK-009
- **Verification:** Done when `pnpm test:e2e` including tests/task-013 executes successfully and demonstrates: Closed unified section registry renders on both `/` and `/{pageSlug}` across the 6 platform themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`) with lossless theme switching; order/toggle preview and published rendering agree; health-category testimonials default off with Permenkes warning; unknown or duplicate singleton config fails; no-JS content remains usable.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-014: Floating WhatsApp Widget
- **Milestone:** M1
- **Requirement:** REQ-014
- **Constraints:** REQ-019, REQ-040
- **Risk Level:** R1
- **Allowed Paths:** `apps/web/src/themes/default/components/FloatingWhatsApp.*`, `tests/task-014/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-014; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-010, TASK-012
- **Verification:** Done when `pnpm test:e2e` including tests/task-014 executes successfully and demonstrates: Widget opens valid chat without JS; optional greeting supports keyboard close and mobile viewport; configured hours do not imply live presence; measured bundle fits budget.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-015: Schema.org Structured Data Generator
- **Milestone:** M1
- **Requirement:** REQ-022
- **Constraints:** REQ-026
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/schema-generator.ts`, `tests/task-015/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-022; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-051
- **Verification:** Done when `pnpm test:unit` including tests/task-015 executes successfully and demonstrates: Parse emitted JSON-LD; verify visible facts, safe escaping and canonical URLs; inquiry/service items never invent Product offers; schema validity is not claimed rich-result eligibility.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-016: Open Graph & Social Share Metadata
- **Milestone:** M1
- **Requirement:** REQ-023
- **Constraints:** REQ-026
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/og-generator.ts`, `apps/web/src/components/SEOHead.astro`, `apps/web/src/worker/queues/media/og.ts`, `tests/task-016/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-023; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-005, TASK-007, TASK-012, TASK-051
- **Verification:** Done when `pnpm test:integration` including tests/task-016 executes successfully and demonstrates: Rendered head uses verified canonical host, escaped text, ready 1200x630 <=300KiB image or safe fallback; drafts emit noindex.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-017: Tenant-Scoped Sitemap and Robots Endpoints
- **Milestone:** M1
- **Requirement:** REQ-024
- **Constraints:** REQ-066, REQ-025, REQ-026
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/sitemap.xml.ts`, `apps/web/src/pages/robots.txt.ts`, `apps/web/src/pages/sitemaps/**`, `apps/web/src/pages/blog/feed.xml.ts`, `tests/task-017/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-024; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-002, TASK-051
- **Verification:** Done when `pnpm test:integration` including tests/task-017 executes successfully and demonstrates: XML parses, URLs and lastmod follow published snapshots/primary origin; unpublishing removes entries; sitemaps include image entries and exclude noindex content and former slugs; /blog/feed.xml lists the latest 20 published posts and is absent when the blog is disabled; unknown hosts never receive another tenant's sitemap.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-027: Draft/Publish Snapshots and Revisioned Cache
- **Milestone:** M1
- **Requirement:** REQ-036
- **Constraints:** REQ-001
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/src/publication/**`, `packages/core/src/content/**`, `packages/core/src/theme/**`, `apps/web/src/core/cache.ts`, `tests/task-027/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-036; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-024, TASK-025
- **Verification:** Done when `pnpm test:integration` including tests/task-027 executes successfully and demonstrates: Draft edits never leak; stale revision returns 409; publishing updates resource and tenant revision atomically; preview responses bypass cache; pooled two-tenant tests pass.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-050: In-Process Draft Preview and Admin Preview Shell
- **Milestone:** M1
- **Requirement:** REQ-036
- **Constraints:** REQ-001, REQ-034, REQ-039
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/preview/**`, `apps/web/src/pages/api/tenants/[tenantId]/preview/**`, `apps/web/src/core/preview/**`, `packages/core/src/preview/**`, `docs/api/**`, `tests/task-050/**`
- **Protected Paths:** `packages/auth/**`, `packages/db/migrations/**`, `infra/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`, `.github/workflows/**`
- **Canonical Contract Owners:** PLAN.md sections 13 and 14; PRD.md REQ-036.
- **Accepted Invariants:** Server-authorized scope, no public draft access, no secret exposure, atomic audited privilege changes.
- **Depends On:** TASK-012, TASK-025, TASK-027, TASK-032
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-050 passes: Authorized admin preview renders the same registered Astro theme components in-process from a bounded validated draft DTO, with no internal renderer endpoint. Wrong-tenant, wrong-role, stale-version and expired-session requests fail, scripts/forms/external navigation are inert, responses are no-store/noindex, public requests never access draft data, and expired sessions cannot refresh previews.
- **Visual Contract:** DESIGN.md preview states, responsive viewport controls and accessible error/retry; no production tracking.
- **Reopen Conditions:** Privilege bypass, draft leak, cross-tenant media reference or changed preview contract.
- **Rollback/Migration State:** No schema change; no public fallback on failure.
- **Non-Scope:** Production execution, real credentials, impersonation, public preview sharing, separate renderer services and duplicated rendering engines.
- **Escalation Conditions:** Expanded authorization, new infrastructure or incompatible runtime/security changes.

### TASK-051: Shared Published SEO Policy
- **Milestone:** M1
- **Requirement:** REQ-052
- **Constraints:** REQ-001, REQ-022, REQ-024, REQ-025, REQ-026, REQ-034, REQ-036, REQ-039, REQ-052, REQ-055
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/seo/**`, `tests/task-051/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-052; PLAN.md section 15; DESIGN.md section 9.
- **Accepted Invariants:** Published tenant-scoped facts only; noindex is not privacy; no ranking guarantee, arbitrary script or canonical injection.
- **Depends On:** TASK-002, TASK-024, TASK-027
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-051 pass: Exercise every section 15 status/canonical/indexability rule from typed published inputs, malicious origins, page/query normalization and two-tenant fixtures; return no invented canonical for private/error routes.
- **Visual Contract:** No new screen; typed policy reused by existing head/discovery consumers.
- **Reopen Conditions:** Draft leak, cross-tenant host/content, contradictory index policy, schema injection or changed upstream publication behavior.
- **Rollback/Migration State:** Additive fields/defaults; compatible rollback retains saved overrides and noindex intent.
- **Non-Scope:** Redirect engine, IndexNow, live DNS/submission, automatic content generation, paid SEO services and webmaster API integration.
- **Escalation Conditions:** New route/permission, destructive migration, live provider access or widening accepted SEO scope.

### TASK-089: Privacy-Preserving Click-to-Load YouTube Embeds
- **Milestone:** M1
- **Requirement:** REQ-089
- **Constraints:** REQ-021, REQ-039, REQ-040
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/media/youtube.ts`, `apps/web/src/themes/default/components/YouTubeFacade.astro`, `apps/web/src/components/admin/editor/blocks/youtube/**`, `apps/web/src/themes/default/sections/SectionGallery.astro`, `tests/task-089/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-089; PLAN.md section 7.3.
- **Accepted Invariants:** Accepts `youtube.com/watch?v=`, `youtu.be/` and `youtube.com/shorts/` URLs, extracts and stores only the validated 11-char video ID, caches/serves a local poster (or platform placeholder), makes **zero** network requests to YouTube/Google before visitor click, and mounts `youtube-nocookie.com` iframe only on click.
- **Depends On:** TASK-006, TASK-007, TASK-009, TASK-013
- **Verification:** Done when `pnpm test:unit` and `pnpm test:e2e` including tests/task-089 pass: malformed/playlist/javascript URLs fail; Playwright network listener proves zero requests to `youtube.com`/`ytimg.com`/`googlevideo.com` on initial page load across posts, offerings and gallery sections; keyboard/mouse activation swaps in `https://www.youtube-nocookie.com/embed/<id>` with accessible disclosure.
- **Visual Contract:** Accessible video facade card with play button and privacy notice at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Autoplay background YouTube videos or raw `<iframe>` HTML embeds.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.
