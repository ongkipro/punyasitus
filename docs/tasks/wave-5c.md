# Wave 5 — CMS Admin Screens, 6 Themes + Style Variants/Store, Plugin Runtime, Public Site, Forms, Branches, Marketing & Moderation (M1, part 3 of 3)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

### TASK-091: Structured Business Profile, Schema.org Subtype Mapping & Auto-Derived Brand Assets
- **Milestone:** M1
- **Requirement:** REQ-091
- **Constraints:** REQ-010, REQ-022, REQ-044, REQ-054
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/business-profile/**`, `packages/core/src/business-profile/**`, `packages/core/src/schema-generator.ts`, `apps/web/src/pages/dashboard/[handle]/settings/identity/**`, `apps/web/src/pages/api/tenants/[tenantId]/identity/**`, `apps/web/src/worker/queues/media/**`, `docs/api/**`, `tests/task-091/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-091; PLAN.md sections 5.2, 7.3 and 19.5.
- **Accepted Invariants:** Business profile validates closed `business_category` values mapped to current Google-supported Schema.org subtypes (default `LocalBusiness`, never deprecated `ProfessionalService`), legal/brand name, address/service areas, hours, WA/phone/social and privacy contact; uploading a logo auto-derives `32x32`+`180x180` favicons and a `<=300 KiB` `1200x630` default OG image when unset.
- **Depends On:** TASK-007, TASK-015, TASK-041
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-091 pass: every `business_category` emits a valid Schema.org subtype with zero `ProfessionalService` output and optional Indonesian licence credentials (`NIB`, `SK Kemenag PPIU/PIHK`, `SIP/STR`, `Halal/PIRT`) render truthfully without fabricated badges; logo upload generates favicon and `1200x630` OG derivatives (`<=300 KiB`) without overwriting explicit tenant overrides.
- **Visual Contract:** DESIGN.md `Profil` & `Identitas` settings tabs at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Arbitrary custom JSON-LD text boxes.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-092: Blog Author Profiles, `content_modified_at` Discipline & Server-Rendered TOC
- **Milestone:** M1
- **Requirement:** REQ-092
- **Constraints:** REQ-009, REQ-015, REQ-022, REQ-045
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/posts/**`, `packages/core/src/posts/**`, `apps/web/src/pages/dashboard/[handle]/posts/**`, `apps/web/src/pages/api/tenants/[tenantId]/posts/**`, `apps/web/src/pages/blog/**`, `docs/api/**`, `tests/task-092/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-092; PLAN.md sections 5.2 and 19.5.
- **Accepted Invariants:** Each post supports a public author profile (`name`, `role_title`, `bio`, `avatar_media_id`) rendered as visible byline and `Article.author` JSON-LD, reading-time estimate, optional server-rendered heading TOC (`h2`/`h3`), primary category + categories (`<=3` depth) + tags, and strict `content_modified_at` bumping only on substantive published edits.
- **Depends On:** TASK-006, TASK-015, TASK-033, TASK-036, TASK-040
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-092 pass: draft autosaves, analytics ticks and unrelated settings changes never advance `content_modified_at` or sitemap `<lastmod>`, while substantive republish does; visible author byline matches `Article` JSON-LD; TOC renders anchor links server-side with zero client JS.
- **Visual Contract:** Blog post detail byline, reading time and TOC on mobile/desktop.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Public comment threads or multi-author guest-login portals.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-093: Six-Theme Platform Catalog (`compro`..`dealer`) & Guided Onboarding Checklist
- **Milestone:** M1
- **Requirement:** REQ-093
- **Constraints:** REQ-018, REQ-046, REQ-047
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/themes/compro/**`, `apps/web/src/themes/sales/**`, `apps/web/src/themes/travel/**`, `apps/web/src/themes/catalog/**`, `apps/web/src/themes/resto/**`, `apps/web/src/themes/dealer/**`, `packages/core/src/presets/**`, `apps/web/src/components/admin/onboarding/**`, `tests/task-093/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-018, REQ-093; PLAN.md sections 7.3, 19.5 and 19.8; DESIGN.md section 7; `punyasitus-docs/docs/research/cmspro/04-b2b-conversion-blueprints.md`.
- **Accepted Invariants:** Ships all 6 code-defined platform themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`) over the single shared section registry (`<=1` custom font per theme, `<=25 KiB` public JS), minimal 3-field onboarding applying the **7 Zero-Guesswork B2B Vertical Conversion Blueprints** (`b2b_corporate`, `sales_executive`, `personal_brand`, `regulated_professional`, `travel_umrah_agency`, `offline_multibranch`, `wa_catalog_showcase` — setting exact vertical section order, Indonesian field micro-prompts instead of *Lorem Ipsum*, contextual credential fields, `ProfilePage` schema for personal/sales profiles, `testimonials` off for regulated health/legal, `5 Pasti Umrah`/Permenpar 6/2025 fields for travel, `wa.me` template and starter form), adaptive sidebar offering menu showing only the vertical's primary offering type by default, and the dismissible 5-step dashboard checklist (`Profil & WhatsApp`, `Logo`, `Penawaran/Halaman`, `Tema`, `Publikasikan`).
- **Depends On:** TASK-012, TASK-013, TASK-042, TASK-043, TASK-080, TASK-091
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-093 pass: all 7 B2B blueprints seed their exact section sequence, vertical Title/Meta templates, semantic HTML `<table>`/`<dl>` AI Fact-Sheet blocks, 3 draft E-E-A-T blog outlines, dual Google Business Profile + Bing Places copy card, sidebar offering label, contextual credential prompts, `wa.me` message and starter form (`CONTOH` sample badge, zero fabricated reviews, `testimonials` & `AggregateRating` disabled on `regulated_professional`, `ProfilePage` JSON-LD linked to `BlogPosting.author` on `personal_brand`/`sales_executive`); switching across all 6 themes preserves every page section, offering and post with zero data loss and stays `<=25 KiB` gzipped JS; completing or dismissing each of the 5 checklist items persists accurately.
- **Visual Contract:** DESIGN.md section 6 theme showcase and Beranda 5-step onboarding checklist at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Tenant-uploaded theme templates or raw CSS/HTML injection.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-094: Public Abuse Reporting, Console Moderation Queue & Tenant Single-Lead Deletion / Activity Log
- **Milestone:** M1
- **Requirement:** REQ-094
- **Constraints:** REQ-032, REQ-039, REQ-049, REQ-051
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/abuse/**`, `packages/db/src/activity-log/**`, `apps/web/src/pages/api/abuse-report.ts`, `apps/web/src/pages/console/abuse/**`, `apps/web/src/pages/api/console/abuse/**`, `apps/web/src/pages/dashboard/[handle]/leads/**`, `apps/web/src/pages/dashboard/[handle]/settings/activity/**`, `apps/web/src/pages/api/tenants/[tenantId]/leads/**`, `apps/web/src/pages/api/tenants/[tenantId]/activity/**`, `docs/api/**`, `tests/task-094/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-094; PLAN.md section 19.5.
- **Accepted Invariants:** Public tenant footer link submits Turnstile- & rate-limited abuse reports (`POST /api/abuse-report`) to `console.punyasitus.com/abuse` where operators dismiss, unpublish or suspend with reason, audit and Resend notice; tenant `owner`/`admin` can permanently delete individual leads (with audit) and view their website's read-only activity log.
- **Depends On:** TASK-008, TASK-025, TASK-046, TASK-067, TASK-077, TASK-090
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-094 pass: rate-limited/Turnstile-verified abuse report lands in console queue; operator unpublish/suspend requires 2FA + reason, updates public visibility immediately and emails owner; tenant owner/admin permanent single-lead delete removes the row from `TenantStore` and exports while recording an audited entry in `tenant_activity_log`; editors and foreign tenants get 403/404.
- **Visual Contract:** Console abuse queue, public report modal/form and tenant activity log table at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Automated AI content takedowns without human operator review.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-096: Theme Style Variants & Commercial Theme Store (`included`, `paid_once`, `custom`)
- **Milestone:** M1
- **Requirement:** REQ-096
- **Constraints:** REQ-018, REQ-040, REQ-046, REQ-056, REQ-081, REQ-082
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/themes/store/**`, `packages/core/src/theme/variants.ts`, `apps/web/src/themes/compro/**`, `apps/web/src/themes/sales/**`, `apps/web/src/themes/travel/**`, `apps/web/src/themes/catalog/**`, `apps/web/src/themes/resto/**`, `apps/web/src/themes/dealer/**`, `apps/web/src/themes/premium/**`, `apps/web/src/pages/dashboard/[handle]/appearance/themes/**`, `apps/web/src/pages/api/tenants/[tenantId]/themes/**`, `apps/web/src/pages/console/custom-themes/**`, `apps/web/src/pages/api/console/custom-themes/**`, `docs/api/**`, `tests/task-096/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-096; ADR-0010; PLAN.md sections 11.4 and 19.7; DESIGN.md section 7.
- **Accepted Invariants:** Each of the 6 platform themes ships >=4 WCAG-AA-verified Style Variants (`<=1` custom font, 0% content loss on switch); `paid_once` premium themes allow draft preview (`no-store, noindex`) before purchase and unlock activation only after confirmed AutoLaris settlement (with coupons and numbered PDF receipt).
- **Depends On:** TASK-042, TASK-057, TASK-081, TASK-082, TASK-093
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-096 pass: all >=24 built-in style variants pass automated `>=4.5:1` WCAG AA contrast and preserve 100% of sections/offerings/posts on switch; unpurchased `paid_once` theme previews safely with `no-store, noindex` while direct activation returns 403 until settlement; confirmed settlement issues a PDF receipt and unlocks activation for that website only.
- **Visual Contract:** DESIGN.md section 7 Style Variant swatch picker and Theme Store (`Gratis` / `Premium` / `Kustom`) at 360/1440 px.
- **Reopen Conditions:** Contrast regression, content loss across variant/theme switch, or cross-tenant theme entitlement leak.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** User-uploaded `.zip` themes or arbitrary CSS/JS injection.
- **Escalation Conditions:** Destructive migration or required change exceeding declared path boundary.

### TASK-097: Frozen-Core Modular Plugin Runtime, `plg_*` `TenantStore` Isolation & Slot Dispatcher
- **Milestone:** M1
- **Requirement:** REQ-097
- **Constraints:** REQ-001, REQ-034, REQ-040, REQ-042, REQ-060
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/plugins/**`, `packages/core/src/plugins/**`, `packages/plugins/tsconfig.base.json`, `apps/web/src/core/plugin-registry.ts`, `apps/web/src/core/plugin-runtime.ts`, `apps/web/src/pages/dashboard/[handle]/plugins/**`, `apps/web/src/pages/api/tenants/[tenantId]/plugins/**`, `apps/web/src/pages/api/plugins/[pluginId]/webhook.ts`, `apps/web/src/worker/queues/plugins/**`, `apps/web/src/middleware/**`, `docs/api/**`, `tests/task-097/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-097; ADR-0010; PLAN.md section 19.7; `docs/plugins/PLUGIN-DEVELOPMENT.md`.
- **Accepted Invariants:** Core CMS remains frozen; plugins execute only for entitled active websites; plugin DDL is restricted to `plg_<id>__*` tables in `TenantStore` with pre-migration PITR bookmarks and never drops data on disable; Queue hooks are fault-isolated so plugin errors never fail core CMS writes; inactive plugins add zero SQL queries and zero bytes of public JS/CSS.
- **Depends On:** TASK-001, TASK-013, TASK-025, TASK-028, TASK-059
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-097 pass: synthetic test plugin proves all 5 slots (`plg_*` migration with PITR bookmark, public section/sub-route within `<=25 KiB` JS, `base-nova` admin page + RBAC API, fault-isolated Queue hook where a throwing hook still commits the lead/publish, and conditional MCP hook); DDL touching non-`plg_*` tables is rejected; a second unentitled tenant executes 0 plugin queries and gets 404/403 on plugin routes; `locked` blocks plugin mutations (`403 SUBSCRIPTION_LOCKED`) and `suspended` blocks access while preserving `plg_*` rows.
- **Visual Contract:** DESIGN.md section 7 `Plugin` admin shell frame and empty/installed state fixtures at 360/1440 px.
- **Reopen Conditions:** Plugin failure affecting core CMS transaction, cross-tenant `TenantStore` leak, or unentitled plugin route exposure.
- **Rollback/Migration State:** Keep schema changes additive; preserve `plg_*` data; revert only this task's compatible application changes after review.
- **Non-Scope:** Arbitrary third-party `.zip` code upload, `eval`, or 1-Worker-per-client deployment.
- **Escalation Conditions:** Destructive migration or required change exceeding declared path boundary.

### TASK-102: Official Free Zero-Config Plugin `seo-ai-autopilot` (One-Click Autopilot SEO, Sitemap/Robots & AI Indexing)
- **Milestone:** M1
- **Requirement:** REQ-102
- **Constraints:** REQ-022, REQ-023, REQ-024, REQ-052, REQ-053, REQ-066, REQ-093, REQ-095, REQ-097
- **Risk Level:** R2
- **Allowed Paths:** `packages/plugins/seo-ai-autopilot/**`, `apps/web/src/core/plugin-registry.ts`, `apps/web/src/components/SEOHead.astro`, `apps/web/src/pages/sitemap.xml.ts`, `apps/web/src/pages/robots.txt.ts`, `apps/web/src/pages/[indexnowKey].txt.ts`, `apps/web/src/pages/blog/feed.xml.ts`, `docs/api/**`, `tests/task-102/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-102; DECISIONS.md DEC-039; ADR-0010; PLAN.md sections 15.1, 15.7 and 19.7; DESIGN.md section 8.
- **Accepted Invariants:** Packages the entire SEO & AI Indexing suite (`sitemap.xml` + Image Sitemap, AI-aware `robots.txt`, programmatic Blueprint Meta Title/Description, `<300 KiB` WhatsApp OG, Schema.org `@graph`, `IndexNow`, GBP + Bing Places copy card, and collapsed optional manual overrides) into the official `public_free` plugin `packages/plugins/seo-ai-autopilot`; when uninstalled/disabled, editors show zero SEO form fields, `/sitemap.xml` & `/[indexnowKey].txt` return 404, and pages emit only minimal `<title>` + mandatory `trial`/`suspended` `noindex` safety headers; when installed (1 click), everything runs 100% automatically with zero required settings.
- **Depends On:** TASK-015, TASK-016, TASK-017, TASK-052, TASK-053, TASK-093, TASK-095, TASK-097
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-102 pass: a newly provisioned website has `seo-ai-autopilot` active without any owner action (DEC-042); on a tenant where the owner disabled `seo-ai-autopilot`, Page/Offering/Post editors render zero SEO controls, `/sitemap.xml` returns 404, JSON-LD `@graph` & `IndexNow` are inactive, while `trial`/`suspended` `noindex` and `308` canonicals remain intact; clicking 1-click `Pasang (Gratis)` immediately activates valid `/sitemap.xml`, AI-split `/robots.txt`, programmatic Blueprint Title/Meta/OG tags, JSON-LD `@graph` and `IndexNow` with **zero manual configuration**, while keeping editor overrides collapsed until clicked; disabling preserves saved overrides without deleting data.
- **Visual Contract:** DESIGN.md section 8 zero-clutter base editor vs installed `seo-ai-autopilot` collapsed override drawer & `/dashboard/[handle]/plugins/seo-ai-autopilot` screen at 360/1440 px.
- **Reopen Conditions:** Mandatory SEO form clutter appearing when plugin is disabled, broken `trial`/`suspended` `noindex` safety when disabled, or manual setup required after install.
- **Rollback/Migration State:** Additive `plg_seo_ai_autopilot__*` settings tables only; preserve saved overrides on disable.
- **Non-Scope:** Yoast-style traffic-light keyword scores or third-party SEO plugin uploads.
- **Escalation Conditions:** Required change breaking single `<head>` shell authority or leaking across tenants.

### TASK-103: Shared-Domain Protection: Publish Screening, Trust+ Watch, Takedown and Fallback Zone
- **Milestone:** M1
- **Requirement:** REQ-103
- **Constraints:** REQ-005, REQ-049, REQ-094, REQ-095
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/content-screening/**`, `packages/core/src/content-screening/**`, `apps/web/src/worker/cron/trust-watch.ts`, `apps/web/src/pages/console/abuse/**`, `apps/web/src/pages/api/console/abuse/**`, `docs/operations/trust-positif.md`, `infra/cloudflare/**`, `docs/api/**`, `tests/task-103/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-103; PLAN.md section 20.1; DECISIONS.md DEC-043.
- **Accepted Invariants:** Every publish path (dashboard and MCP) passes the same screening; a match never publishes; the Trust+ check reports unknown, never clean, when its inputs cannot be read; takedown is one audited operator action that uses the existing suspended state.
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-028, TASK-046, TASK-094
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-103 pass: seeded gambling keywords, a denylisted link host and a hidden ALT text each hold the item as draft with a review row, while clean content publishes; an operator release publishes it with audit; the daily check flags a fixture IP present in a fixture list, returns unknown on a list or DNS failure, and notifies at most once a day; "Turunkan situs" makes the next public request return the suspended page and is audited; `infra/cloudflare` documents the second tenant zone and `docs/operations/trust-positif.md` exists.
- **Visual Contract:** Console review queue and owner "Konten ditahan" notice at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Automated AI moderation, scanning visitor submissions, or automatic zone failover.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-104: Indonesian Help Center at `punyasitus.com/bantuan` with In-Dashboard Help Links
- **Milestone:** M1
- **Requirement:** REQ-104
- **Constraints:** REQ-040, REQ-087
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/marketing/bantuan/**`, `apps/web/src/content/bantuan/**`, `apps/web/src/components/admin/help/**`, `packages/core/src/help/**`, `tests/task-104/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-104; PLAN.md section 20.2.
- **Accepted Invariants:** Help articles are static Astro content on the marketing site, carry no tenant data, and every mapped dashboard help link resolves to an existing article.
- **Depends On:** TASK-032, TASK-087
- **Verification:** Done when `pnpm test:unit` and `pnpm test:e2e` including tests/task-104 pass: at least 20 articles cover signup, domain, first offering, WhatsApp, payment, receipts and leads; a build check fails when a dashboard `help_slug` points to a missing article; article pages render without JavaScript, are indexable and meet the marketing JS budget; open counts are recorded without personal data.
- **Visual Contract:** Help center index, article page and dashboard help icon at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Live chat widgets, community forums or third-party help-desk products.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-106: Platform Status Page, Incident Banner and Staged Releases
- **Milestone:** M1
- **Requirement:** REQ-106
- **Constraints:** REQ-041, REQ-042
- **Risk Level:** R3
- **Allowed Paths:** `apps/status/**`, `apps/web/src/components/admin/incident/**`, `apps/web/src/pages/console/incidents/**`, `apps/web/src/pages/api/console/incidents/**`, `packages/db/migrations/**`, `packages/db/src/incidents/**`, `docs/operations/release.md`, `.github/workflows/**`, `tests/task-106/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-106; PLAN.md section 20.3.
- **Accepted Invariants:** The status page does not depend on the platform Worker; incident banners come from one operator action; releases follow Cloudflare gradual deployments and the Durable Object migration rules.
- **Depends On:** TASK-023, TASK-037, TASK-048
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-106 pass: an operator declares and resolves an incident and the dashboard banner appears and disappears; the status page builds as a separate static project with no binding to the platform Worker; `docs/operations/release.md` records the `wrangler versions upload` and `versions deploy` procedure, the rule that a `TenantStore` migration is applied with `wrangler deploy`, and the rollback steps; a dry-run in CI uploads a version without deploying it.
- **Visual Contract:** Status page and dashboard incident banner at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Automatic uptime-based incident detection or third-party status-page vendors.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-107: Owner Full-Website Export Archive and Self-Service Deletion with Undo
- **Milestone:** M1
- **Requirement:** REQ-107
- **Constraints:** REQ-039, REQ-068, REQ-069
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/exports/**`, `packages/core/src/exports/**`, `apps/web/src/worker/queues/exports/**`, `apps/web/src/pages/dashboard/[handle]/settings/data/**`, `apps/web/src/pages/api/tenants/[tenantId]/exports/**`, `apps/web/src/pages/api/tenants/[tenantId]/deletion/**`, `docs/api/**`, `tests/task-107/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-107; PLAN.md section 20.4.
- **Accepted Invariants:** Only the owner can export or delete; the export link expires after 24 hours; deletion can be cancelled for 7 days and then uses the existing purge path; billing and audit records keep their own retention.
- **Depends On:** TASK-007, TASK-021, TASK-025, TASK-028, TASK-067, TASK-068
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-107 pass: the owner receives one ZIP holding pages, posts and offerings as JSON, leads as CSV and media files, written under the tenant R2 prefix; admins, editors and other tenants are refused; a second export on the same day is refused; the link stops working after 24 hours; deletion takes the site offline at once, can be cancelled within 7 days, and after the window runs the REQ-069 purge while billing rows remain.
- **Visual Contract:** Settings > Data screen with export and delete flows at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Import of an exported archive into another website or platform.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-108: Free QR Codes for Website, Pages and Offerings
- **Milestone:** M1
- **Requirement:** REQ-108
- **Constraints:** REQ-017, REQ-073
- **Risk Level:** R1
- **Allowed Paths:** `packages/core/src/qr/**`, `apps/web/src/components/admin/qr/**`, `apps/web/src/pages/api/tenants/[tenantId]/qr/**`, `tests/task-108/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-108; PLAN.md section 20.5.
- **Accepted Invariants:** QR codes encode only the canonical primary URL with an optional `utm_source=qr`; no external service; drafts have none.
- **Depends On:** TASK-009, TASK-030, TASK-036
- **Verification:** Done when `pnpm test:unit` and `pnpm test:e2e` including tests/task-108 pass: generated SVG and PNG decode to the canonical primary URL with and without the tag; switching the primary domain changes the encoded URL; drafts offer no QR code; visits with `utm_source=qr` are counted as QR scans in insights.
- **Visual Contract:** QR download dialog on website, page and offering screens at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Printable card or poster templates (possible later plugin).
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.
