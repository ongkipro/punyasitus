# Wave 5 — CMS Admin Screens, 6 Themes + Style Variants/Store, Plugin Runtime, Public Site, Forms, Branches, Marketing & Moderation (M1, part 2 of 3)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

### TASK-047: Superadmin Domain and Job Recovery Queues
- **Milestone:** M1
- **Requirement:** REQ-050
- **Constraints:** REQ-004, REQ-034, REQ-042, REQ-051, REQ-065
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/console/domains/**`, `apps/web/src/pages/console/jobs/**`, `apps/web/src/pages/api/console/domains/**`, `apps/web/src/pages/api/console/jobs/**`, `packages/db/src/platform/**`, `apps/web/src/worker/queues/recovery/**`, `docs/api/**`, `tests/task-047/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-050; PLAN.md section 13; DESIGN.md.
- **Accepted Invariants:** Platform grants are independent of tenant roles; no impersonation or blanket content/PII access; mutations require audit.
- **Depends On:** TASK-003, TASK-028, TASK-032, TASK-039, TASK-046, TASK-067
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-047 pass: Operator domain change removes locked hostnames and connects a new domain with reason, confirmation and audit while tenant users cannot; render scoped exceptions and safe errors; recheck/retry requires reason and idempotency. Reject live leases/completed jobs, tenant users and forged IDs; provider timeout remains pending and never bypasses verification or service suspension.
- **Visual Contract:** DESIGN.md platform screens, explicit platform/tenant context, keyboard and 360/768/1440px states.
- **Reopen Conditions:** Platform access bypass, stale grants, unaudited effect or missing provider failure state.
- **Rollback/Migration State:** Additive schema; retain audit data and compatible application rollback.
- **Non-Scope:** Payment processing, mass deletion, shell/SQL console, live deployment and support impersonation.
- **Escalation Conditions:** New privileged action, destructive migration, live provider mutation or access to customer content/PII outside authorization.

### TASK-052: SEO Editor Controls and Verification Settings
- **Milestone:** M1
- **Requirement:** REQ-053
- **Constraints:** REQ-066, REQ-001, REQ-022, REQ-024, REQ-025, REQ-026, REQ-034, REQ-036, REQ-039, REQ-052, REQ-055
- **Risk Level:** R3
- **Allowed Paths:** `packages/plugins/seo-ai-autopilot/**`, `apps/web/src/components/admin/seo/**`, `apps/web/src/pages/dashboard/[handle]/plugins/**`, `apps/web/src/pages/dashboard/[handle]/pages/**`, `apps/web/src/pages/dashboard/[handle]/posts/**`, `apps/web/src/pages/dashboard/[handle]/catalog/**`, `apps/web/src/pages/api/tenants/[tenantId]/plugins/**`, `apps/web/src/pages/api/tenants/[tenantId]/seo/**`, `packages/core/src/seo/**`, `packages/db/src/seo/**`, `packages/db/migrations/**`, `docs/api/**`, `tests/task-052/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-053; PLAN.md section 15; DESIGN.md section 9.
- **Accepted Invariants:** Published tenant-scoped facts only; noindex is not privacy; no ranking guarantee, arbitrary script or canonical injection.
- **Depends On:** TASK-033, TASK-040, TASK-041, TASK-051
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-052 pass: Verify search appearance templates with the fixed token set (unknown tokens rejected), the **collapsed-by-default** General/Social/Schema/Advanced override drawer (hidden completely when `seo-ai-autopilot` is disabled), allowed schema types per kind, nofollow, focus keyphrase checklist results that never block publishing, effective defaults, overrides, noindex inheritance, taxonomy opt-in, ownership/role/stale-write denial, slug warnings, safe provider verification tokens, draft privacy and configured-vs-externally-verified distinction. Invalid data blocks save; advisory SEO guidance does not.
- **Visual Contract:** DESIGN.md section 9 at 360/768/1440px; keyboard errors, helper text and advisory notices.
- **Reopen Conditions:** Draft leak, cross-tenant host/content, contradictory index policy, schema injection or changed upstream publication behavior.
- **Rollback/Migration State:** Additive fields/defaults; compatible rollback retains saved overrides and noindex intent.
- **Non-Scope:** Redirect engine, IndexNow, live DNS/submission, automatic content generation, paid SEO services and webmaster API integration.
- **Escalation Conditions:** New route/permission, destructive migration, live provider access or widening accepted SEO scope.

### TASK-053: Local Entity Schema and Crawlable Content Integration
- **Milestone:** M1
- **Requirement:** REQ-054
- **Constraints:** REQ-066, REQ-001, REQ-022, REQ-024, REQ-025, REQ-026, REQ-034, REQ-036, REQ-039, REQ-052, REQ-055
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/schema-generator.ts`, `packages/core/src/seo/**`, `apps/web/src/components/seo/**`, `apps/web/src/themes/default/**`, `apps/web/src/pages/[...slug].astro`, `apps/web/src/pages/blog/**`, `apps/web/src/pages/layanan/**`, `apps/web/src/pages/produk/**`, `apps/web/src/pages/tour/**`, `apps/web/src/pages/kendaraan/**`, `packages/db/src/authors/**`, `packages/db/src/seo/**`, `docs/api/**`, `tests/task-053/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-054; PLAN.md section 15; DESIGN.md section 9.
- **Accepted Invariants:** Published tenant-scoped facts only; noindex is not privacy; no ranking guarantee, arbitrary script or canonical injection.
- **Depends On:** TASK-015, TASK-036, TASK-041, TASK-051, TASK-052
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-053 pass: Parse rendered company-profile, article and taxonomy HTML and JSON-LD (M1; travel, outlet and service-vertical schema/crawl assertions live in the tests of TASK-020, TASK-019 and TASK-035 and are rerun by TASK-038); check visible factual entities, no fabricated offers/reviews/private addresses, escaped script payloads, published tenant-local links, breadcrumbs, pagination and no-JS primary content. Verify author box/Person data, optional server-rendered table of contents, default robots directives and no second head/schema authority.
- **Visual Contract:** Accepted public DESIGN.md; mobile contact, non-lazy hero, semantic headings, real links and consent-safe map fallback.
- **Reopen Conditions:** Draft leak, cross-tenant host/content, contradictory index policy, schema injection or changed upstream publication behavior.
- **Rollback/Migration State:** Additive fields/defaults; compatible rollback retains saved overrides and noindex intent.
- **Non-Scope:** Redirect engine, IndexNow, live DNS/submission, automatic content generation, paid SEO services and webmaster API integration.
- **Escalation Conditions:** New route/permission, destructive migration, live provider access or widening accepted SEO scope.

### TASK-054: SEO Crawl Regression and Webmaster Launch Runbook
- **Milestone:** M1
- **Requirement:** REQ-055
- **Constraints:** REQ-001, REQ-022, REQ-024, REQ-025, REQ-026, REQ-034, REQ-036, REQ-039, REQ-052, REQ-055
- **Risk Level:** R2
- **Allowed Paths:** `tests/task-054/**`, `docs/operations/seo-launch.md`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-055; PLAN.md section 15; DESIGN.md section 9.
- **Accepted Invariants:** Published tenant-scoped facts only; noindex is not privacy; no ranking guarantee, arbitrary script or canonical injection.
- **Depends On:** TASK-017, TASK-039, TASK-051, TASK-052, TASK-053
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-054 pass: Crawl two synthetic tenants through actual HTTP; parse head/XML/schema and enforce PLAN section 15 including sitemap limits, revision changes, taxonomy, custom themes, noindex, domain switch, suspended warm cache, broken links and 404. Document manual GSC/Bing verification/submission and launch measurements; external outcomes remain UNVERIFIED until executed.
- **Visual Contract:** Reuse rendered content acceptance; no new analytics dashboard or provider UI.
- **Reopen Conditions:** Draft leak, cross-tenant host/content, contradictory index policy, schema injection or changed upstream publication behavior.
- **Rollback/Migration State:** Additive fields/defaults; compatible rollback retains saved overrides and noindex intent.
- **Non-Scope:** Redirect engine, IndexNow, live DNS/submission, automatic content generation, paid SEO services and webmaster API integration.
- **Escalation Conditions:** New route/permission, destructive migration, live provider access or widening accepted SEO scope.

### TASK-060: Short Video Upload, Validation and Delivery
- **Milestone:** M1
- **Requirement:** REQ-062
- **Constraints:** REQ-010, REQ-034, REQ-039, REQ-040, REQ-060, REQ-064
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `apps/web/src/pages/api/tenants/[tenantId]/media/**`, `apps/web/src/worker/queues/media/video/**`, `packages/db/src/media/**`, `packages/core/src/media/**`, `apps/web/src/themes/default/components/Video.astro`, `apps/web/src/components/admin/media/**`, `apps/web/src/components/admin/editor/blocks/video/**`, `apps/web/src/themes/default/sections/SectionPortfolio.*`, `docs/api/**`, `tests/task-060/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-062; PLAN.md section 7 short-video contract.
- **Accepted Invariants:** Same quarantine/finalize boundary as images; no re-encoding or transcoding vendor; no public source before processing succeeds; tenant scope on every lookup.
- **Depends On:** TASK-007, TASK-013, TASK-059
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-060 execute successfully and demonstrate: 10,000,000-byte MP4/MOV/WebM passes and 10,000,001 bytes fails including direct upload/finalize bypass; videos consume normalized storage quota; a website with 20 videos gets 422 for the 21st, parallel intents cannot exceed 20, and permanent deletion frees a slot; spoofed MIME, over 1920x1080 or 60 fps, corrupt and foreign-key uploads fail; already-compliant H.264/AAC MP4 runs a pure-JS fast-start/metadata-strip box rewrite in the Worker while MOV/WebM invokes the bounded scale-to-zero `VideoTranscoder` Cloudflare Container (`ffmpeg`, no upscaling, metadata stripped, poster extracted); poster is image/webp from a client-captured frame or the default; rendered markup has controls, preload="none", playsinline, poster and dimensions with no autoplay; hero placement is rejected; optional WebVTT is validated; locked and cross-tenant requests fail; validation stays inside the Worker CPU and memory limits.
- **Visual Contract:** DESIGN.md media picker states for video size/format errors, processing, failure/retry and caption upload at 360/768/1440px.
- **Reopen Conditions:** A listed acceptance case fails, the 20-video/10 MB caps change, the pinned MP4 box library changes behavior, or the owner moves video processing to Cloudflare Containers or Stream.
- **Rollback/Migration State:** Keep schema changes additive; preserve uploaded objects; disable the video intent endpoint if processing is unsafe.
- **Non-Scope:** Transcoding, adaptive streaming, live video, external video hosting integrations, hero video and autoplay.
- **Escalation Conditions:** Need for re-encoding, new vendor or resource use beyond the Worker CPU and memory limits.

### TASK-061: Custom Theme Service Page, Packages and Requests
- **Milestone:** M1
- **Requirement:** REQ-063
- **Constraints:** REQ-034, REQ-037, REQ-046, REQ-060, REQ-061
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `apps/web/src/pages/dashboard/[handle]/appearance/themes/custom/**`, `apps/web/src/pages/api/tenants/[tenantId]/custom-theme-requests/**`, `apps/web/src/pages/api/tenants/[tenantId]/custom-theme-packages/**`, `apps/web/src/pages/console/custom-themes/**`, `apps/web/src/pages/api/console/custom-themes/**`, `apps/web/src/components/admin/custom-theme/**`, `packages/db/src/custom-themes/**`, `packages/core/src/custom-themes/**`, `packages/core/src/email/**`, `apps/web/src/worker/queues/dispatch/**`, `docs/api/**`, `tests/task-061/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`, `.github/workflows/**`
- **Canonical Contract Owners:** PLAN.md sections 4, 5, 11.4 and 13; PRD.md REQ-063; DESIGN.md Appearance.
- **Accepted Invariants:** Packages and prices only from superadmin-managed data; no checkout or payment collection for custom work; requests tenant-scoped; operator actions audited.
- **Depends On:** TASK-024, TASK-032, TASK-042, TASK-048, TASK-049
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-061 execute successfully and demonstrate: owner/admin see default plus granted themes and the service card; editors and other tenants are denied; only active packages render in sort order with starting price or quote-only label; empty package list shows contact-only state; request validation, 5-URL cap, HTTPS-only URLs, idempotent retry and 3-per-day limit hold; URLs are never fetched; WA link encodes handle/request/package once; operators create/edit/deactivate packages and change status with reason and audit; delivered requires an existing theme grant and the theme then becomes activatable; locked tenants cannot open the page.
- **Visual Contract:** DESIGN.md Appearance service page, package cards, form errors, request status list and WhatsApp CTA at 360/768/1440px with keyboard access.
- **Reopen Conditions:** A listed acceptance case fails, pricing presentation policy changes, or custom work payment moves into the system.
- **Rollback/Migration State:** Keep schema changes additive; deactivate packages instead of deleting referenced ones; preserve requests.
- **Non-Scope:** Checkout, deposits or AutoLaris charges for custom work, theme file upload, automated theme building and quote document generation.
- **Escalation Conditions:** Request to collect custom-work payment in the system, new vendor, or permission change beyond the RBAC table.

### TASK-065: Analytics Hardening: Event Dedup (M1)
- **Milestone:** M1
- **Requirement:** REQ-027
- **Constraints:** REQ-017, REQ-039
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/analytics/**`, `apps/web/src/pages/api/events.ts`, `packages/core/src/analytics/**`, `apps/web/src/components/AnalyticsHead.astro`, `tests/task-065/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PLAN.md sections 5, 7.3 and 18.1; PRD.md REQ-017 and REQ-027.
- **Accepted Invariants:** No tags before consent; one event ID per logical action; the GTM contract in TASK-076 is unchanged.
- **Depends On:** TASK-022, TASK-030, TASK-076
- **Verification:** Done when `pnpm test:e2e` including tests/task-065 executes successfully and demonstrates: per-event dedup by tenant/event ID with 24h expiry across direct tags and the GTM dataLayer; no double dispatch for a vendor; CTAs work under tracking failure.
- **Visual Contract:** No new screens; dashboard counts unchanged in layout.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Server-side CAPI and automatic ad-platform integrations.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-068: Locked-Tenant Retention, Leads Export and Offboarding
- **Milestone:** M1
- **Requirement:** REQ-069
- **Constraints:** REQ-001, REQ-039, REQ-042, REQ-060, REQ-065
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/offboarding/**`, `packages/db/src/leads/**`, `apps/web/src/worker/queues/offboarding/**`, `apps/web/src/worker/queues/retention/**`, `apps/web/src/worker/queues/dispatch/**`, `packages/auth/src/entitlements/**`, `packages/db/src/billing/**`, `packages/core/src/billing/**`, `apps/web/src/worker/queues/billing/**`, `apps/web/src/middleware/**`, `apps/web/src/components/admin/service-access/**`, `apps/web/src/pages/api/tenants/[tenantId]/leads/export.ts`, `packages/core/src/email/**`, `docs/operations/privacy.md`, `docs/api/**`, `tests/task-068/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-069; PLAN.md section 17.4; DECISIONS.md DEC-022.
- **Accepted Invariants:** Nothing is deleted before `deletion_due_at`; operator holds and pending/review settlements block deletion; billing and audit records survive; deletion is tenant-scoped, idempotent and audited.
- **Depends On:** TASK-021, TASK-028, TASK-031, TASK-039, TASK-059
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-068 pass: frozen-time tests prove `deletion_due_at` for a never-paid trial (`trial_ends_at + 30 days`, warnings `-7d/-3d/-1d`), a no-trial unpaid site (`provisioning + 30 days`) and a previously paid website (`paid_through + 45 days` = `H+45`, warnings `H+38/H+42/H+44`) regardless of scheduler delay, purging custom hostnames, R2 `t/<tenantId>/` objects and `TenantStore` (`deleteAll()`) while converting unsettled charges to de-identified residual records; nothing is deleted one second before it and everything (content, media objects, leads, custom hostnames via provider mock) is deleted after it; reminders send once each on the listed days and skip after payment; payment before the deadline restores access to retained data; a lead past its own retention is still purged while locked; an operator hold pauses the clock and its release resumes it with at least 14 days left; offboarding takes the entitlement lock and writes `offboarding_started_at` before side effects; payment attempts in creating/creation_unknown/pending/review block deletion; concurrent payment, settlement and hold against offboarding never produce a deleted-but-paid or held-but-deleted tenant; after the claim, new payment attempts are rejected and late settlements go to review; owner-only leads CSV export works while locked or suspended, passes the lockout allowlist while the leads inbox and other lead APIs stay locked, is rate-limited, audited and denied to other roles and tenants; a delayed job sends only the latest missed reminder; billing/audit rows remain; an interrupted job resumes without duplicate side effects; a backup-restore fixture replays the tombstone and deletes the tenant again; the released handle stays unavailable for 30 days.
- **Visual Contract:** DESIGN.md section 11 payment-only page shows the deletion date and the leads export at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, DEC-022 changes, or the privacy review changes retention duties.
- **Rollback/Migration State:** Keep schema changes additive; the offboarding job can be disabled without data loss; deleted data is not recoverable by design.
- **Non-Scope:** Bulk export of content, automatic mass deletion, deleting operator-suspended tenants and legal conclusions.
- **Escalation Conditions:** The privacy/tax review requires different periods; a request to delete billing/audit records; destructive migration beyond this task.

### TASK-069: Terima Beres Setup Service Packages and Requests
- **Milestone:** M1
- **Requirement:** REQ-070
- **Constraints:** REQ-034, REQ-035, REQ-063, REQ-065
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/custom-themes/**`, `packages/core/src/custom-themes/**`, `apps/web/src/pages/dashboard/[handle]/setup-service/**`, `apps/web/src/pages/api/tenants/[tenantId]/service-requests/**`, `apps/web/src/pages/console/custom-themes/**`, `apps/web/src/pages/api/console/custom-themes/**`, `apps/web/src/components/admin/custom-theme/**`, `packages/auth/src/invitations/**`, `packages/db/src/provisioning/**`, `apps/web/src/layouts/DashboardLayout.astro`, `docs/api/**`, `tests/task-069/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-070; PLAN.md sections 11.4 and 18.2; DECISIONS.md DEC-026.
- **Accepted Invariants:** One package/request model with `service_kind`; prices only from superadmin data; no payment in the system; staff delivery uses a normal audited membership, never impersonation.
- **Depends On:** TASK-061, TASK-026
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-069 pass: owner/admin see active setup packages and submit an idempotent, rate-limited request; editors and other tenants are denied; operators change status with reason; after owner approval a staff editor joins a free seat with audit; the membership is removed on delivered, declined and cancelled (idempotent); a setup request is delivered without any theme grant; a request waits with an explanation when no seat is free; locked tenants are denied; custom-theme requests keep working unchanged.
- **Visual Contract:** DESIGN.md Appearance/service page pattern reused for the setup service at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Payment collection, automated content migration and impersonation.
- **Escalation Conditions:** Request to collect payment in the system or to bypass the member limit.

### TASK-070: Domain and Business Email Guide
- **Milestone:** M1
- **Requirement:** REQ-071
- **Constraints:** REQ-043, REQ-044
- **Risk Level:** R1
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/settings/domains/**`, `apps/web/src/components/admin/domain-guide/**`, `tests/task-070/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-071; PLAN.md section 18.2.
- **Accepted Invariants:** Informational only: no credentials requested, no provider API calls, no claim that the platform provides mailboxes.
- **Depends On:** TASK-039
- **Verification:** Done when `pnpm test:e2e` including tests/task-070 passes: owner and admin can open the guide (editors cannot, matching Settings > Domains) and it is linked from the Domains page; the guide renders the three DNS paths, links only to official provider pages, states the Cloudflare DNS requirement for Email Routing, links to the connect-domain flow, contains no credential inputs and is keyboard accessible.
- **Visual Contract:** DESIGN.md settings layout at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Registrar or mailbox integrations and buying domains for customers.
- **Escalation Conditions:** A request to store registrar or email credentials.

### TASK-076: Easy Google Tag Manager Setup
- **Milestone:** M1
- **Requirement:** REQ-027
- **Constraints:** REQ-017, REQ-033, REQ-039, REQ-040
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/components/AnalyticsHead.astro`, `packages/core/src/analytics/**`, `apps/web/src/scripts/analytics.ts`, `apps/web/src/pages/dashboard/[handle]/settings/analytics/**`, `apps/web/src/pages/api/tenants/[tenantId]/analytics/**`, `packages/db/src/analytics-settings/**`, `packages/db/migrations/**`, `apps/web/src/pages/console/tenants/**`, `apps/web/src/pages/api/console/tenants/**`, `apps/web/src/middleware/**`, `docs/gtm/**`, `docs/api/**`, `packages/core/src/email/**`, `apps/web/src/worker/queues/dispatch/**`, `tests/task-076/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-027; PLAN.md section 18.1; DECISIONS.md DEC-027.
- **Accepted Invariants:** No tags before consent; each vendor direct or via GTM, never both; dataLayer carries no personal data; GTM never loads on admin, preview, maintenance or error pages; operator kill switch audited.
- **Depends On:** TASK-022, TASK-031, TASK-046, TASK-049, TASK-067
- **Verification:** Done when `pnpm test:e2e` including tests/task-076 passes: invalid container IDs fail; switching GTM on requires the owner's audited risk acknowledgement (admins may enter IDs, editors are denied); the snippet and the relaxed CSP profile with nonce appear only after consent on public pages of GTM-enabled tenants, while other tenants, admin, preview and maintenance responses keep the strict CSP and the template's GA4/Meta/TikTok tags are not blocked; Consent Mode defaults are denied before load and update on consent; the four `ps_*` events push with the documented fields and no personal data; a vendor cannot be both direct and via GTM; the operator kill switch removes GTM with reason and notifies the owner; the committed container template in docs/gtm passes a JSON structure test in CI, and its import into a test GTM account with events visible in Tag Assistant is recorded as staging evidence; CTAs work when GTM fails to load.
- **Visual Contract:** DESIGN.md tracking settings and guide at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Server-side GTM, platform review of container contents and automatic ad-platform integrations.
- **Escalation Conditions:** A request to inject arbitrary scripts outside GTM.

### TASK-080: Tenant-Defined Custom Forms, Vertical Templates & WhatsApp After-Submit
- **Milestone:** M1
- **Requirement:** REQ-080
- **Constraints:** REQ-001, REQ-031, REQ-032, REQ-039, REQ-040
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/forms/**`, `packages/core/src/forms/**`, `apps/web/src/pages/dashboard/[handle]/forms/**`, `apps/web/src/pages/api/tenants/[tenantId]/forms/**`, `apps/web/src/pages/api/leads.ts`, `apps/web/src/themes/default/sections/SectionCustomForm.astro`, `docs/api/**`, `tests/task-080/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-080; PLAN.md section 19.2; DESIGN.md section 8.
- **Accepted Invariants:** Max 10 forms per website and 12 closed-type fields per form (no file upload, no drag-and-drop); 6 vertical templates; 1-level `field == value` visibility; publishing requires non-empty `privacy_contact`; submissions snapshot field labels/types into `leads` before PII-free email notice and support `wa.me` prefilled summary.
- **Depends On:** TASK-008, TASK-013, TASK-024, TASK-025, TASK-032, TASK-090, TASK-091
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-080 pass: 11th form and 13th field fail; publishing without `privacy_contact` fails and health categories show the UU PDP warning; 1-level conditional required fields validate consistently server-side; editing a form after submission leaves historical lead snapshots intact; WhatsApp after-submit encodes submitted summary accurately; Turnstile/rate-limit/cross-tenant checks hold.
- **Visual Contract:** DESIGN.md vertical form builder and public accessible form at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** File-upload fields, multi-step branching logic or external webhook integrations.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-087: Platform Marketing Surface (`punyasitus.com`), Demo Tenants & Funnel Analytics
- **Milestone:** M1
- **Requirement:** REQ-087
- **Constraints:** REQ-021, REQ-040, REQ-051
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/marketing/**`, `apps/web/src/components/marketing/**`, `apps/web/src/pages/console/funnel/**`, `packages/db/migrations/**`, `packages/db/src/marketing/**`, `packages/core/src/marketing/**`, `tests/task-087/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-087; PLAN.md section 19.5; DESIGN.md section 2.
- **Accepted Invariants:** `punyasitus.com` (`www` -> 308 apex) renders live monthly/yearly pricing from `PLATFORM_DB`, 6 read-only `noindex` synthetic demo sites, legal pages (Terms, Privacy, AUP, Refund), WhatsApp CTA and cookieless first-party funnel counts (`visit` -> `first_payment`) viewable on `console.punyasitus.com/funnel`.
- **Depends On:** TASK-002, TASK-013, TASK-048, TASK-058
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-087 pass: updating price in `platform_settings` updates `punyasitus.com` immediately with zero deploy; `www.punyasitus.com` 308s to apex; all 6 demo sites carry `noindex` and block mutations; cookieless funnel events increment without setting third-party cookies and render on console funnel view; JS stays `<=25 KiB` gzipped.
- **Visual Contract:** Public marketing landing, pricing, demo showcase and legal pages at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Third-party ad trackers on `punyasitus.com` without consent.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-088: Multi-Branch Locations (`branches`) & Unified Schema.org `@graph`
- **Milestone:** M1
- **Requirement:** REQ-088
- **Constraints:** REQ-001, REQ-022, REQ-054, REQ-091
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/branches/**`, `packages/core/src/branches/**`, `packages/core/src/schema-generator.ts`, `apps/web/src/pages/dashboard/[handle]/settings/branches/**`, `apps/web/src/pages/api/tenants/[tenantId]/branches/**`, `apps/web/src/themes/default/sections/SectionBranches.astro`, `docs/api/**`, `tests/task-088/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-088; PLAN.md section 19.5.
- **Accepted Invariants:** Each website supports up to 10 branches beside head office (`name`, `address`, `phone`, `whatsapp`, Maps URL/coords, weekday/holiday hours, timezone, sort order), rendered in `branches` / contact sections and emitted as linked `LocalBusiness` nodes in one Schema.org `@graph` matching visible text.
- **Depends On:** TASK-001, TASK-013, TASK-015, TASK-024, TASK-025, TASK-032, TASK-091
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-088 pass: CRUD for up to 10 branches works and the 11th returns 422; branch WA/Maps/call links render without JS; JSON-LD `@graph` links parent business and visible branches with exact address/hours parity and zero fabricated ratings.
- **Visual Contract:** DESIGN.md branch editor and public branch cards at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Interactive third-party map SDKs loaded before visitor consent (TASK-019 covers rich M2 outlet directory filtering).
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.
