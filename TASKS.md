# Tasks: PunyaSitus Implementation

> Revision: 2026-11-18 (Merged PunyaSitus + CMSPRO under DEC-035; 100% Cloudflare D1 + `TenantStore` DO + Containers + `base-nova` UI under ADR-0009 & DEC-036). All tasks are pending; this is a planning queue, not a completion report.
> Preserves TASK-001 through TASK-022; missing foundations append from TASK-023.
> Read AGENTS.md, PRD.md, PLAN.md and DESIGN.md before execution. Numeric order is not dependency order.

## Execution contract

- Specifications are promoted into this repository (2026-09-26). Work only after explicit development authorization. No implicit commit, push, deployment, DNS mutation or paid provisioning.
- Resolve PLAN section 1 gates for the affected task. New architecture proposals are not accepted human decisions.
- Shared requirements: REQ-001 applies to every tenant-owned surface; REQ-034 to admin operations; REQ-039 to personal data; REQ-040 to browser-visible work.
- Every task allows its own tests at tests/task-NNN/**, plus evidence-only updates to the repository STATUS.md, BUILD-LOG.md and existing .delivery/ contract. Every task that adds or changes an HTTP contract may also edit its own schema files under `packages/core/src/schemas/**` and the generated `docs/api/**`, and must leave the TASK-024 drift check green. Admin navigation links for a task's own screens may be added in `apps/web/src/components/admin/nav/**`. Feature source paths are listed below. Follow repository boundary tooling when present.
- A path listed in both Allowed and Protected Paths is in scope but always requires independent review at protected risk R3 (typically `packages/db/migrations/**`, `packages/auth/**`, `.github/workflows/**`).
- Every task has one primary requirement. Constraints do not replace the primary outcome.
- Verification commands below are future script contracts created by TASK-023. Run a targeted test folder as well as relevant integration/build checks; never report a command as passed before the project exists.
- R3 tasks require an independent review pass of tenant, identity, migrations or operational boundaries plus executed negative tests. For repositories using .delivery, the reviewer must be a separate actual agent, with truthful provenance and a review bound to the latest surface digest, as required by ~/dotfiles/docs/task-change-boundary.md. Self-review is not independent approval.
- Complete a bounded change per session. TASK-033 is a grouped delivery outcome; implement its named sub-sessions separately and mark the parent complete only after every journey passes.
- Task states and evidence belong in STATUS.md, BUILD-LOG.md and .delivery/; every task stays pending until its checks pass. Product/UX gates cannot be satisfied by fabricated approvals.

## Milestones

- Goal (DEC-030, DEC-035): full product development; every v1 task ships in the first production release, gated by TASK-038 (only TASK-062 Redirect Manager is deferred to release 1.1 per DEC-035 C16). M1 and M2 are build phases in dependency order.
- M1 (phase 1, core CMS, 6 themes, billing/receipts/coupons, marketing, forms, branches, YouTube, Google auth, AI/search visibility & abuse queue): every task marked `Milestone: M1` (incl. TASK-080..082, TASK-087..097, and TASK-102 `seo-ai-autopilot` free plugin), checkpointed by TASK-063.
- M2 (phase 2, vertical modules, agency & affiliate channels, AI writing, MCP & security assurance): TASK-019 outlets, TASK-020 travel/Umrah, TASK-035 professional services, TASK-064 revision history, TASK-066 vertical presets, TASK-071 schedule fields, TASK-072 insights, TASK-073 Google review link, TASK-074 AI writing, TASK-075 MCP server, TASK-078 security assurance, TASK-079 vehicle showroom & credit table, TASK-083 agency portal, TASK-084..086 affiliate engine, TASK-098 plugin store & add-on billing, and TASK-099..101 official Frozen-Core plugins (`bio-links`, `wa-cs-rotator`, `wp-importer`, `lead-notifier`). TASK-038 is the production release gate over both phases.
- Per-task browser evidence uses Chromium at 360 and 1440 px plus keyboard checks; 768 px, Firefox/WebKit and the full performance lab run in the release gates (TASK-063, TASK-038). Visual Contract widths in individual tasks are satisfied by this rule.

## Dependency entry points

After explicit development authorization, start TASK-023, then TASK-001 and TASK-024; TASK-032 establishes the reviewed design and isolated shell fixtures, TASK-025 establishes authentication, and TASK-049 establishes operator grants before provisioning. The routing decision is accepted (DEC-029). Follow the dependency graph thereafter; TASK-038 is the final automated integration gate. Provider credentials are not required for local mocks. Production rollout remains a separate authorized operation.

## Ordered Development Waves (Topological Execution Plan)

Task blocks below preserve stable IDs (`TASK-001`..`TASK-110`). Execute development strictly along these DAG waves (109 v1 tasks + 1 Release 1.1 deferred task):

| Wave | Phase | Focus | Tasks (runnable once their own `Depends On` complete) |
|---|---|---|---|
| **Wave 0** | M1 | Monorepo & Cloudflare `workerd` Bootstrap | `TASK-023` |
| **Wave 1** | M1 | Core Schemas (`PLATFORM_DB` + `TenantStore`), OpenAPI, URL Helpers & `base-nova` UI Shell | `TASK-001`, `TASK-010`, `TASK-011`, `TASK-024`, `TASK-032` |
| **Wave 2** | M1 | Host Routing, Queues/Cron, Rate Limits, Privacy, Email & Better Auth + Google/2FA | `TASK-002`, `TASK-028`, `TASK-029`, `TASK-031`, `TASK-077`, `TASK-025`, `TASK-030`, `TASK-037`, `TASK-045`, `TASK-049`, `TASK-067`, `TASK-090` |
| **Wave 3** | M1 | Core CMS APIs, Cloudflare Images/Video Pipeline, Shared Theme Shell & SEO Foundations | `TASK-004`, `TASK-007`, `TASK-027`, `TASK-005`, `TASK-006`, `TASK-008`, `TASK-009`, `TASK-012`, `TASK-051`, `TASK-013`, `TASK-014`, `TASK-015`, `TASK-016`, `TASK-017`, `TASK-050`, `TASK-089` |
| **Wave 4** | M1 | Console Foundations, Custom Domains, AutoLaris Billing, Lifecycle, Receipts & Coupons | `TASK-026`, `TASK-048`, `TASK-055`, `TASK-059`, `TASK-003`, `TASK-056`, `TASK-058`, `TASK-057`, `TASK-081`, `TASK-082`, `TASK-095` |
| **Wave 5** | M1 | CMS Admin Screens, 6 Themes + Style Variants/Store, Plugin Runtime, Public Site, Forms, Branches, Marketing & Moderation | `TASK-033`, `TASK-018`, `TASK-021`, `TASK-034`, `TASK-036`, `TASK-044`, `TASK-060`, `TASK-087`, `TASK-097`, `TASK-022`, `TASK-039`, `TASK-040`, `TASK-041`, `TASK-042`, `TASK-043`, `TASK-046`, `TASK-052`, `TASK-061`, `TASK-068`, `TASK-070`, `TASK-091`, `TASK-092`, `TASK-047`, `TASK-053`, `TASK-069`, `TASK-076`, `TASK-080`, `TASK-088`, `TASK-093`, `TASK-094`, `TASK-096`, `TASK-054`, `TASK-065`, `TASK-102`, `TASK-103`, `TASK-104`, `TASK-106`, `TASK-107`, `TASK-108` |
| **Wave 6** | **M1 Gate** | Phase 1 Integration Checkpoint (53 direct M1 leaf dependencies) | **`TASK-063`** |
| **Wave 7** | M2 | Vertical Modules, Agency Portal, Affiliates, Plugin Store (`private_client`/`free`/`paid`), Seed Plugins, AI & MCP | `TASK-019`, `TASK-020`, `TASK-035`, `TASK-064`, `TASK-075`, `TASK-079`, `TASK-071`, `TASK-066`, `TASK-073`, `TASK-074`, `TASK-083`, `TASK-084`, `TASK-072`, `TASK-085`, `TASK-086`, `TASK-098`, `TASK-099`, `TASK-100`, `TASK-101`, `TASK-105`, `TASK-109`, `TASK-110` |
| **Wave 8** | **M2 Gate** | Pre-Launch Security Assurance (`ASVS L2` + `ZAP` + BOLA) & Full Production Release Gate | **`TASK-078`** -> **`TASK-038`** |
| *Deferred* | *Release 1.1* | Owner Redirect Manager & 404 Monitor (`DEC-035 C16`) | *`TASK-062`* |

## Pending Tasks

### TASK-001: Multi-Tenant Database Schema & Drizzle Migrations
- **Milestone:** M1
- **Requirement:** REQ-001
- **Constraints:** REQ-034
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/**`, `tests/task-001/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-001; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:integration` including tests/task-001 executes successfully and demonstrates: Fresh and upgrade Drizzle SQLite migrations succeed on local `workerd` `PLATFORM_DB` (D1) and per-tenant `TenantStore` (SQLite Durable Object); the `D1Database`-compatible `TenantStore` RPC adapter preserves `changes`/`last_row_id` and atomic `transactionSync` batches; Worker migration orchestration records a PITR bookmark in `PLATFORM_DB.migration_bookmarks` before migrating a tenant DO and marks failed tenants `recovery` (503); two concurrent tenants are physically isolated in separate `TenantStore` instances and `PLATFORM_DB` repositories reject cross-tenant queries.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-002: Host-Based Tenant Resolution & Tenant Context Middleware
- **Milestone:** M1
- **Requirement:** REQ-002
- **Constraints:** REQ-003, REQ-005
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/middleware/**`, `apps/web/src/core/tenant.ts`, `packages/db/src/routing/**`, `tests/task-002/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-002; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-024
- **Verification:** Done when `pnpm test:integration` including tests/task-002 executes successfully and demonstrates: Step 0 passes `/.well-known/pki-validation/*` and `/.well-known/acme-challenge/*` through untouched; valid fixture host resolves from `PLATFORM_DB` (`tenant_hosts JOIN tenants`, <=5s active-only isolate cache, 60s moved-host quarantine); `punyasitus.com`, `app.punyasitus.com` and `console.punyasitus.com` isolate their respective routes; unknown/unverified/purged host returns 404; suspended/recovery tenant returns 503 even with warm `caches.default` synthetic key; spoofed `X-Forwarded-Host`/`X-Tenant-ID` headers never change scope.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-003: Custom Domain Verification & Cloudflare for SaaS Integration
- **Milestone:** M1
- **Requirement:** REQ-004
- **Constraints:** REQ-034, REQ-042
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/api/tenants/[tenantId]/domains/**`, `packages/core/src/domains/**`, `apps/web/src/worker/queues/domains/**`, `packages/db/src/domains/**`, `tests/task-003/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-004; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-002, TASK-025, TASK-026, TASK-028
- **Verification:** Done when `pnpm test:integration` including tests/task-003 executes successfully and demonstrates: Trial websites and hostnames >64 chars are rejected; mocked Cloudflare Custom Hostname create-before-CNAME (O2O safe), ownership, SSL, target CNAME and HTTPS tenant-marker probe each gate primary promotion; DCV/CAA/Blocked remedies render clearly; 7-day stale-hostname reaper deletes abandoned pending/moved hostnames; duplicate claims and unauthorized calls fail; provider timeout remains pending and retries reconcile existing records; the three connect modes (new domain, zero-downtime migration, O2O) produce the exact record sets of PLAN section 3.2 from mocked provider values only, the migration mode keeps the CNAME step locked until `status` and `ssl.status` are both `active`, a conflicting `_acme-challenge` TXT is detected and reported, DCV token re-fetch and rate-limited recheck work, and the renewal-watch Cron notifies the owner when the CNAME or delegation record disappears; token age is shown with a warning at day 5 (Let's Encrypt tokens expire after 7 days, Google Trust Services and SSL.com after 14), expired tokens are re-fetched, and "Periksa sekarang" sends the documented custom-hostname `PATCH` with the current `ssl` settings; a test fails if any response on a tenant host sets a cookie with a `Domain` attribute, the consent cookie lacks the `__Host-` prefix, or tenant-host code reads any other cookie.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

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

### TASK-010: WhatsApp Dynamic CTA URL Generator & E.164 Validation
- **Milestone:** M1
- **Requirement:** REQ-014
- **Constraints:** REQ-013, REQ-016
- **Risk Level:** R1
- **Allowed Paths:** `packages/core/src/wa-dispatcher.ts`, `tests/task-010/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-014; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:unit` including tests/task-010 executes successfully and demonstrates: Normalize valid 08/+628/628 formats; reject letters, bad prefixes and excessive length; expand page_url once, preserve literal dollar signs, Unicode and line breaks; reject unknown tokens.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-011: External Link-Out Validation
- **Milestone:** M1
- **Requirement:** REQ-015
- **Constraints:** None
- **Risk Level:** R1
- **Allowed Paths:** `packages/core/src/link-sanitizer.ts`, `tests/task-011/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-015; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:unit` including tests/task-011 executes successfully and demonstrates: Accept HTTPS marketplace URL; reject HTTP, javascript, credentials, localhost/IP-private URLs and malformed values; no silent hash-link fallback; output required rel/target.
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

### TASK-018: Custom Theme Registry & Agency Routing
- **Milestone:** M1
- **Requirement:** REQ-021
- **Constraints:** REQ-001, REQ-040, REQ-063, REQ-066
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/themes/custom/**`, `docs/themes/**`, `apps/web/src/core/theme-registry.ts`, `tests/task-018/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-021; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-012, TASK-015, TASK-016, TASK-017
- **Verification:** Done when `pnpm test:e2e` including tests/task-018 executes successfully and demonstrates: A sample custom theme built by following docs/themes/THEME-DEVELOPMENT.md registers by explicit build-time import and renders every public route inside the shared security/SEO/consent shell; unknown ID falls back safely; static import guard forbids database/auth access; two-tenant tests remain isolated.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-019: Offline Gerai Multi-Outlet Directory & Maps
- **Milestone:** M2
- **Requirement:** REQ-029
- **Constraints:** REQ-034, REQ-039
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/api/tenants/[tenantId]/outlets/**`, `apps/web/src/pages/dashboard/[handle]/outlets/**`, `packages/db/src/outlets/**`, `apps/web/src/themes/default/sections/SectionOutlets.astro`, `packages/core/src/schema-generator.ts`, `apps/web/src/core/public-data.ts`, `tests/task-019/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-029; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-025, TASK-013, TASK-031, TASK-015, TASK-036
- **Verification:** Done when `pnpm test:e2e` including tests/task-019 executes successfully and demonstrates: Authorized CRUD persists weekly/holiday hours and coordinates; directory gives valid directions; external map embeds load only after consent; cross-tenant update fails; rendered LocalBusiness data matches visible branch facts (REQ-054).
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-020: Travel & Umrah Itinerary & Departure Module (Umrah gated by `SK PPIU` check, DEC-042)
- **Milestone:** M2
- **Requirement:** REQ-028
- **Constraints:** REQ-037
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/catalog/travel.ts`, `apps/web/src/pages/dashboard/[handle]/catalog/travel/**`, `apps/web/src/themes/default/sections/SectionTravelItinerary.astro`, `apps/web/src/pages/layanan/**`, `apps/web/src/pages/produk/**`, `apps/web/src/pages/tour/**`, `apps/web/src/pages/kendaraan/**`, `packages/core/src/schema-generator.ts`, `tests/task-020/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-028; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-009, TASK-013, TASK-015, TASK-036
- **Verification:** Done when `pnpm test:e2e` including tests/task-020 executes successfully and demonstrates: Admin saves bounded itinerary, dates, flight/hotel fields; date-only values do not shift with timezone; catalog detail renders accessible itinerary and WA inquiry; rendered JSON-LD matches visible facts with no invented Offer or availability (REQ-022, REQ-054).
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-021: Native Lead Capture API & Inbox
- **Milestone:** M1
- **Requirement:** REQ-031
- **Constraints:** REQ-032, REQ-038, REQ-039
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/api/leads.ts`, `apps/web/src/themes/default/sections/SectionContactForm.astro`, `apps/web/src/pages/api/tenants/[tenantId]/leads/**`, `apps/web/src/pages/dashboard/[handle]/leads/**`, `packages/db/src/leads/**`, `tests/task-021/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-031; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-013, TASK-024, TASK-025, TASK-029, TASK-031, TASK-077
- **Verification:** Done when `pnpm test:e2e` including tests/task-021 executes successfully and demonstrates: Form and no-JS POST persist once, show durable success and appear in authorized inbox; the owner receives one PII-free new-lead email per lead (switchable off, no visitor data in the mail) and a failed send never blocks persistence; status transitions and WA follow-up work; replay, wrong tenant, rate limit and storage outage preserve correct failure states.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-022: Consent-Aware Analytics Signal Dispatcher
- **Milestone:** M1
- **Requirement:** REQ-027
- **Constraints:** REQ-017, REQ-033, REQ-039
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/components/AnalyticsHead.astro`, `packages/core/src/analytics/**`, `apps/web/src/scripts/analytics.ts`, `apps/web/src/pages/dashboard/[handle]/settings/analytics/**`, `apps/web/src/pages/api/tenants/[tenantId]/analytics/**`, `packages/db/src/analytics-settings/**`, `tests/task-022/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-027; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-010, TASK-021, TASK-030, TASK-031
- **Verification:** Done when `pnpm test:e2e` including tests/task-022 executes successfully and demonstrates: Mock vendor network proves zero tags before consent, direct GA4/Meta/TikTok only (tenant GTM setup is TASK-076), one lead signal after persistence and functional CTA under tracking failure; document provider-specific mappings.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-023: Workspace Bootstrap & Runtime Compatibility Spike
- **Milestone:** M1
- **Requirement:** REQ-041
- **Constraints:** None
- **Risk Level:** R3
- **Allowed Paths:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `apps/web/package.json`, `apps/web/astro.config.*`, `apps/web/wrangler.jsonc`, `apps/web/tsconfig.json`, `apps/web/src/pages/index.astro`, `apps/web/src/worker/**`, `.github/workflows/ci.yml`, `packages/*/package.json`, `packages/*/tsconfig.json`, `packages/db/src/connections/**`, `packages/*/src/index.ts`, `scripts/dev/**`, `tests/setup/**`, `tests/fixtures/**`, `ARCHITECTURE.md`, `tests/task-023/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-041; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** None
- **Verification:** Done when `pnpm build` and the compatibility probes executes successfully and demonstrates: Pin compatible supported versions of pnpm, Astro (`output: "server"`, `session: false`), `@astrojs/cloudflare`, Wrangler, Better Auth (`provider: "sqlite"`, `joins: true`), Drizzle SQLite, `@base-ui/react` (`shadcn/ui` `base-nova`, zero `@radix-ui/*`), Tailwind v4 and `pdf-lib`; enable strict TypeScript and `noUncheckedIndexedAccess` across apps/packages with Astro template checks; define PLAN section 9 scripts; run the single Astro Worker (`punyasitus.com`, `app.punyasitus.com`, `console.punyasitus.com` and `*.situsku.click` surfaces) in `workerd` through `astro dev` and `wrangler dev`; validate `PLATFORM_DB` D1 and `TenantStore` SQLite Durable Object queries with synthetic fixtures; prove a Queue producer/consumer, DO `alarm()` and Cron handler run locally; Wrangler dry-run reports bundle size under 64 MiB and startup under 1 s; add a CI workflow running lint, typecheck, unit and `workerd` integration tests from a frozen lockfile on every push, plus `scripts/check-spec.py`; ARCHITECTURE.md records the workspace layout and pinned versions.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-024: HTTP Schemas and Authorization Contract
- **Milestone:** M1
- **Requirement:** REQ-034
- **Constraints:** REQ-038
- **Risk Level:** R3
- **Allowed Paths:** `docs/api/**`, `packages/core/src/schemas/**`, `packages/auth/src/permissions.ts`, `tests/task-024/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-034; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:unit` including tests/task-024 executes successfully and demonstrates: OpenAPI is generated from the shared packages/core schemas, committed under docs/api and fails CI on drift; it validates and covers PLAN route families, public DTO components for headless readiness, input/error schemas, roles and host-scoped anonymous endpoints; unknown fields and cross-tenant selectors are rejected by executable schema tests.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-025: Better Auth Organization Sessions & RBAC
- **Milestone:** M1
- **Requirement:** REQ-034
- **Constraints:** REQ-001
- **Risk Level:** R3
- **Allowed Paths:** `packages/auth/**`, `apps/web/src/pages/api/auth/**`, `apps/web/src/pages/auth/login/**`, `apps/web/src/pages/auth/reset-password/**`, `apps/web/src/pages/account/**`, `apps/web/src/middleware/**`, `tests/task-025/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-034; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-024, TASK-032, TASK-077
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-025 executes successfully and demonstrates: Generated auth schema matches pinned adapter; login/logout/reset and organization switch pass; own-account profile, email change, password change and active-session list/revoke work and require reauthentication for email and password changes and session revocation (PLAN section 11.2); revoked membership, forged org selector, CSRF and each forbidden role action fail server-side; admin cookies use the __Host- prefix; cookie-authenticated state-changing requests without JSON content type or with a non-admin Origin (including a tenant subdomain origin) are rejected, and session cookies are never accepted as MCP/OAuth bearer credentials; the Better Auth handler returns 404 on tenant hosts; dashboard URLs with a handle the user is not a member of return 404.
- **Visual Contract:** DESIGN.md login/reset forms: keyboard, validation, expired links, session expiry and 360/1440px browser journeys.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-026: Operator Provisioning, Invitations & Service State
- **Milestone:** M1
- **Requirement:** REQ-035
- **Constraints:** REQ-005, REQ-034, REQ-065
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/console/**`, `apps/web/src/pages/api/console/**`, `apps/web/src/pages/dashboard/[handle]/settings/members/**`, `apps/web/src/pages/dashboard/[handle]/service-status/**`, `packages/auth/src/invitations/**`, `packages/db/src/provisioning/**`, `tests/task-026/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-035; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-025, TASK-002, TASK-032, TASK-049, TASK-067
- **Verification:** Done when `pnpm test:e2e` including tests/task-026 executes successfully and demonstrates: Atomic bootstrap creates one organization/tenant/defaults; replay does not duplicate; a 6th member or pending invitation returns MEMBER_LIMIT_REACHED, including concurrent invites; invite is identity-bound/expiring/single-use with an explicitly configured expiry (Better Auth defaults to 48 hours; record the chosen value); final owner remains; owner transfer to an existing member requires reauthentication, is atomic under concurrent transfers and moves owner-only billing access; state transition is audited and revoked access takes effect.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
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

### TASK-028: Durable Jobs on Cloudflare Queues and Safe Retry Infrastructure
- **Milestone:** M1
- **Requirement:** REQ-042
- **Constraints:** REQ-001, REQ-039
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/worker/queues/**`, `apps/web/src/worker/cron/**`, `apps/web/wrangler.jsonc`, `packages/db/src/jobs/**`, `packages/core/src/jobs/**`, `tests/task-028/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-042; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001
- **Verification:** Done when `pnpm test:integration` including tests/task-028 executes successfully and demonstrates: Duplicate Queue deliveries execute the side effect once through the database ledger (idempotency key), expired leases recover, retries are capped with a dead-letter queue and a failed-job view row, and Cron-triggered schedules enqueue exactly one job per period; tenant context survives retries; uncertain provider effects reconcile rather than duplicate; logs contain no sensitive payload.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-029: Anonymous Request Limits and Idempotency
- **Milestone:** M1
- **Requirement:** REQ-038
- **Constraints:** REQ-001
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/src/rate-limits/**`, `packages/db/src/lead-dedup/**`, `apps/web/src/core/public-input.ts`, `tests/task-029/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-038; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-002, TASK-024
- **Verification:** Done when `pnpm test:integration` including tests/task-029 executes successfully and demonstrates: Parallel requests respect atomic limits; matching retries persist once, conflicting keys return 409; forged tenant, cross-origin, literal null Origin, missing-Origin non-form request, missing-Origin form POST with Sec-Fetch-Site cross-site/same-site/none (rejected) versus absent or same-origin (accepted), oversized body and datastore outage reject with no false success.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-030: First-Party Click Counters and Admin Metrics
- **Milestone:** M1
- **Requirement:** REQ-017
- **Constraints:** REQ-033, REQ-039
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/api/events.ts`, `packages/db/src/analytics/**`, `apps/web/src/pages/dashboard/[handle]/index.astro`, `tests/task-030/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-017; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-002, TASK-024, TASK-029, TASK-031, TASK-032
- **Verification:** Done when `pnpm test:e2e` including tests/task-030 executes successfully and demonstrates: Rate-limited daily counters (per-event dedup is TASK-065) distinguish WA/external clicks and accepted forms; fabricated resource IDs and PII fields fail; dashboard calls clicks interest, never confirmed purchases.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-031: Consent, Retention and Privacy Controls
- **Milestone:** M1
- **Requirement:** REQ-039
- **Constraints:** REQ-038
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/components/Consent.*`, `apps/web/src/core/privacy.ts`, `apps/web/src/worker/queues/retention/**`, `packages/db/src/privacy/**`, `docs/operations/privacy.md`, `tests/task-031/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-039; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-001, TASK-028, TASK-032
- **Verification:** Done when `pnpm test:e2e` including tests/task-031 executes successfully and demonstrates: Accept/reject/withdraw flows control vendor and map requests; expiry deletes seeded records/objects; operator access/correction/deletion/withdrawal procedure with a 72-hour target, request log and tenant routing, the breach-notification runbook (platform-to-tenant escalation for processor data, 3 x 24-hour notices for platform-controlled data), the subprocessor and data-location register, and backup tombstone replay are documented; unresolved legal choices block production launch, not local fixtures.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-032: UX Direction and Accessible Admin Foundation
- **Milestone:** M1
- **Requirement:** REQ-037
- **Constraints:** REQ-040
- **Risk Level:** R2
- **Allowed Paths:** `DESIGN.md`, `apps/web/components.json`, `apps/web/src/lib/utils.ts`, `apps/web/src/layouts/ConsoleLayout.astro`, `apps/web/src/layouts/DashboardLayout.astro`, `apps/web/src/components/ui/**`, `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/src/components/admin/**`, `apps/web/src/styles/admin/**`, `apps/web/src/dev/design-fixtures/**`, `tests/task-032/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-037; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:e2e` including tests/task-032 executes successfully and demonstrates: Lock `apps/web/components.json` to `shadcn/ui` v4 preset `base-nova` (`@base-ui/react`, `rsc: false`, Lucide, `render` prop composition, CI check rejecting `@radix-ui/*` and `asChild`); map Tailwind v4 semantic tokens from DESIGN.md; render isolated synthetic desktop sidebar + `<768px` 5-slot mobile web-app bottom-bar shells for tenant dashboard, agency portal, affiliate portal and `console.punyasitus.com` plus permission/loading/empty/error and `trial`/`grace`/`locked`/`suspended` fixtures at 360/768/1440px; keyboard and 200% zoom checks pass before dependent screens. Exclude fixture routes from production builds.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-033: CMS Admin Screens and Media Workflows
- **Milestone:** M1
- **Requirement:** REQ-037
- **Constraints:** REQ-006, REQ-008, REQ-009, REQ-010, REQ-012, REQ-034, REQ-036
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/pages/**`, `apps/web/src/pages/dashboard/[handle]/posts/**`, `apps/web/src/pages/dashboard/[handle]/catalog/**`, `apps/web/src/pages/dashboard/[handle]/menus/**`, `apps/web/src/pages/dashboard/[handle]/media/**`, `apps/web/src/pages/dashboard/[handle]/settings/identity/**`, `apps/web/src/components/admin/media/**`, `apps/web/src/components/admin/editor/**`, `tests/task-033/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-037; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-032, TASK-004, TASK-005, TASK-006, TASK-007, TASK-008, TASK-009
- **Verification:** Done when `pnpm test:e2e` including tests/task-033 executes successfully and demonstrates: Implement in bounded sub-sessions: pages/posts, catalog, menus, media/identity; the rich text editor is a client-only island on editor routes whose chosen library, license and JSON document version are recorded; each complete journey handles save/preview/publish, validation, destructive confirmation, permission and stale-write recovery. TipTap MIT core is locked to the restricted JSON schema (`DEC-035 C13`); the media upload island converts AVIF to PNG/WebP and downscales large phone photos client-side (longest edge <=2560 px) before upload, while server validation stays authoritative.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-034: Theme Customizer Screens
- **Milestone:** M1
- **Requirement:** REQ-037
- **Constraints:** REQ-019, REQ-020, REQ-036
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/appearance/**`, `apps/web/src/pages/api/tenants/[tenantId]/theme/**`, `apps/web/src/pages/dashboard/[handle]/preview/**`, `tests/task-034/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-037; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-032, TASK-013, TASK-027, TASK-050
- **Verification:** Done when `pnpm test:e2e` including tests/task-034 executes successfully and demonstrates: Theme reorder/toggle/token editing previews drafts and publishes atomically; keyboard alternatives work. The domain screen is owned by TASK-039.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-035: Professional Services Pricing & Consultation Module
- **Milestone:** M2
- **Requirement:** REQ-030
- **Constraints:** REQ-014, REQ-016
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/catalog/service.ts`, `apps/web/src/pages/dashboard/[handle]/catalog/services/**`, `apps/web/src/themes/default/sections/SectionServiceProcess.astro`, `apps/web/src/pages/layanan/**`, `apps/web/src/pages/produk/**`, `apps/web/src/pages/tour/**`, `apps/web/src/pages/kendaraan/**`, `packages/core/src/schema-generator.ts`, `tests/task-035/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-030; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-009, TASK-013, TASK-033, TASK-015, TASK-036
- **Verification:** Done when `pnpm test:e2e` including tests/task-035 executes successfully and demonstrates: Editor configures from/fixed/inquiry tiers and bounded process steps; detail page renders accurate price, steps and one specialist WA override with no cart; rendered JSON-LD matches visible facts with no invented Offer (REQ-022, REQ-054).
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-036: Public Routes, Listing and Content Detail Journeys
- **Milestone:** M1
- **Requirement:** REQ-018
- **Constraints:** REQ-008, REQ-009, REQ-012, REQ-026, REQ-061
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/pages/[...slug].astro`, `apps/web/src/pages/blog/**`, `apps/web/src/pages/layanan/**`, `apps/web/src/pages/produk/**`, `apps/web/src/pages/tour/**`, `apps/web/src/pages/kendaraan/**`, `apps/web/src/core/public-routes.ts`, `tests/task-036/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-018; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-013, TASK-015, TASK-016, TASK-017
- **Verification:** Done when `pnpm test:e2e` including tests/task-036 executes successfully and demonstrates: Homepage, `/{pageSlug}`, `/blog` and typed offering listings/details (`/layanan`, `/produk`, `/tour`, `/kendaraan`) render published data with pagination, empty/404 states and canonical links; former slugs of published resources return one 308 to the current URL and 404 after unpublish/trash; the homepage page slug 308s to /; public URLs contain no IDs; no-JS CTA and keyboard journeys pass for both tenants.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-037: Telemetry, Backups and Release Procedures
- **Milestone:** M1
- **Requirement:** REQ-042
- **Constraints:** REQ-039
- **Risk Level:** R3
- **Allowed Paths:** `packages/core/src/telemetry/**`, `docs/operations/**`, `scripts/backup-restore/**`, `apps/web/src/pages/api/health/**`, `OBSERVABILITY.md`, `tests/task-037/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-042; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-028, TASK-031
- **Verification:** Done when `pnpm test:integration` including tests/task-037 executes successfully and demonstrates: Redaction tests, retry/alert fixtures and a daily Cron logical `PLATFORM_DB` D1 export lands in isolated R2 bucket `punyasitus-backup` (`expire-30-days`) alongside D1 30-day Time Travel and `TenantStore` DO SQLite PITR bookmarks (`restore(bookmark)`), and one executed isolated restore recovers coherent media/`PLATFORM_DB`/`TenantStore` data; an external uptime probe on the admin host and one tenant host alerts the operator; document RPO/RTO measurements, compatible rollback and tombstone replay; OBSERVABILITY.md lists executable probes (admin host, tenant host, database, worker heartbeat, backup freshness, AutoLaris Advice freshness) replacing every TBD; no production actions.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-038: Full Production Release Gate (M1 + M2)
- **Milestone:** M2
- **Requirement:** REQ-041
- **Constraints:** REQ-040, REQ-042
- **Risk Level:** R3
- **Allowed Paths:** `.github/workflows/**`, `tests/e2e-gate/**`, `tests/performance/**`, `scripts/verify/**`, `docs/operations/release-checklist.md`, `RELEASE.md`, `ARCHITECTURE.md`, `tests/task-038/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-041; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-063, TASK-019, TASK-020, TASK-035, TASK-064, TASK-065, TASK-066, TASK-071, TASK-072, TASK-073, TASK-074, TASK-075, TASK-078, TASK-079, TASK-083, TASK-084, TASK-085, TASK-086, TASK-098, TASK-099, TASK-100, TASK-101, TASK-105, TASK-109, TASK-110
- **Verification:** Done when `pnpm test:e2e` including tests/task-038 executes successfully and demonstrates: Re-run the TASK-063 checks including every M2 task on staging, plus the full Chromium/Firefox/WebKit matrix at 360/768/1440, the PLAN section 9 performance lab and an executed backup restore: clean checkout passes lint/typecheck/unit/integration/e2e/performance/build; run all PLAN negative cases including the TASK-053 schema/crawl suite extended with M2 vertical routes, Chromium/Firefox/WebKit no-JS public journeys and measured budgets; RELEASE.md records release ID, base, declared risk, a first-release rollback plan (no previous app version exists: rollback means disabling public routing and restoring the pre-launch backup) and backup proof, and `production-gate` passes; unverified provider/legal/launch gates remain explicit.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-039: Custom Domain Connect, Primary Switch and Safe Removal
- **Milestone:** M1
- **Requirement:** REQ-043
- **Constraints:** REQ-002, REQ-003, REQ-004, REQ-026, REQ-034, REQ-065
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/settings/domains/**`, `apps/web/src/pages/api/tenants/[tenantId]/domains/**`, `apps/web/src/worker/queues/domains/**`, `packages/db/src/domains/**`, `packages/core/src/domains/**`, `tests/task-039/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-043; PLAN.md custom-domain delivery details.
- **Accepted Invariants:** No unverified routing; one tenant per hostname; primary switch preserves a verified fallback; no implicit DNS writes.
- **Depends On:** TASK-048, TASK-003, TASK-034
- **Verification:** Done when `pnpm test:e2e` and `pnpm test:integration` including tests/task-039 demonstrate the 2-hostname counterpart rule, owner removal only before activation, locked state with contact-admin notice after activation, counterpart add and primary switch while locked, hostname entry, exact DNS instructions, independent ownership/TLS status, pending/error/retry, active primary switch, verified alias redirect, fallback on removal and idempotent cleanup. Mock unsupported apex capability and two-tenant claim races; record live TLS as unverified until an authorized disposable-domain test succeeds; the mode picker, the two-step migration screen (records first, CNAME only after both states are active), the Cloudflare-nameserver hint and the post-activation cleanup guidance (ownership TXT removable, delegation CNAME must stay) are covered in Chromium at 360 and 1440 px.
- **Visual Contract:** Accessible domain setup/status/retry/confirmation flows at 360/768/1440px; copyable record values; no false success while DNS or certificate is pending.
- **Reopen Conditions:** Provider capabilities change or stale/removed/unverified hostname can serve a tenant.
- **Rollback/Migration State:** Disable routing before provider cleanup; retain hostname claim until deletion reconciles; never silently re-enable a removed domain.
- **Non-Scope:** Purchasing domains, registrar integration, automatic DNS zone edits, wildcard customer hostnames and forced nameserver changes.
- **Escalation Conditions:** Unsupported paid apex feature, missing DNS authority, live provider/DNS mutation or a change to the accepted routing boundary.

### TASK-040: Grouped Admin Settings and Public Defaults
- **Milestone:** M1
- **Requirement:** REQ-044
- **Constraints:** REQ-011, REQ-026, REQ-034, REQ-036, REQ-039
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/settings/**`, `apps/web/src/pages/api/tenants/[tenantId]/settings/**`, `packages/core/src/settings/**`, `packages/db/src/settings/**`, `packages/db/migrations/**`, `apps/web/src/core/settings.ts`, `tests/task-040/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-044; PLAN.md sections 11 and 12.
- **Accepted Invariants:** Tenant boundaries, role guards, published/draft separation and existing content survive every operation.
- **Depends On:** TASK-008, TASK-024, TASK-025, TASK-027, TASK-032, TASK-034
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-040 execute successfully and demonstrate: Owner/admin saves general, business/contact, reading/homepage and SEO defaults; forbidden editor writes fail. Persist drafts without changing live output, then publish atomically. Prove disabled blog/catalog and site noindex affect routes/navigation/sitemap; timezone changes preserve UTC/date-only semantics. Tests include reload, 422, 409 and cross-tenant attempts.
- **Visual Contract:** PLAN.md section 11 behavior and accepted DESIGN.md; keyboard and 360/768/1440px layouts with loading/empty/error/conflict/permission states.
- **Reopen Conditions:** Missing lifecycle case, dependency contract change, stale evidence or unauthorized cross-tenant data exposure.
- **Rollback/Migration State:** Additive migrations; retain compatible app rollback; never undo a live user's edits or discard published data.
- **Non-Scope:** WordPress/PHP/plugin compatibility, unlisted features, automatic Git actions and live deployment.
- **Escalation Conditions:** Destructive migration, unapproved paid service, blocked origin TLS or behavior outside the requested business CMS.

### TASK-041: Blog Categories, Tags and Catalog Taxonomy Screens
- **Milestone:** M1
- **Requirement:** REQ-045
- **Constraints:** REQ-009, REQ-012, REQ-034, REQ-036, REQ-061
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/posts/categories/**`, `apps/web/src/pages/dashboard/[handle]/posts/tags/**`, `apps/web/src/pages/dashboard/[handle]/catalog/categories/**`, `apps/web/src/pages/api/tenants/[tenantId]/categories/**`, `apps/web/src/pages/api/tenants/[tenantId]/tags/**`, `packages/db/src/taxonomy/**`, `packages/db/migrations/**`, `packages/core/src/taxonomy/**`, `apps/web/src/pages/blog/category/**`, `apps/web/src/pages/blog/tag/**`, `apps/web/src/pages/layanan/category/**`, `apps/web/src/pages/produk/category/**`, `apps/web/src/pages/tour/category/**`, `apps/web/src/pages/kendaraan/category/**`, `tests/task-041/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-045; PLAN.md sections 11 and 12.
- **Accepted Invariants:** Tenant boundaries, role guards, published/draft separation and existing content survive every operation.
- **Depends On:** TASK-006, TASK-009, TASK-024, TASK-032, TASK-033, TASK-036
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-041 execute successfully and demonstrate: Create/edit scoped categories/tags, assign posts, reject cycles/depth violations and cross-tenant associations. Deletion requires reassignment/detach without article loss. Public archives/counts exclude draft assignments and trash; pagination and empty/nonexistent states match PLAN. Editor can manage taxonomy but cannot change tenant settings.
- **Visual Contract:** PLAN.md section 11 behavior and accepted DESIGN.md; keyboard and 360/768/1440px layouts with loading/empty/error/conflict/permission states.
- **Reopen Conditions:** Missing lifecycle case, dependency contract change, stale evidence or unauthorized cross-tenant data exposure.
- **Rollback/Migration State:** Additive migrations; retain compatible app rollback; never undo a live user's edits or discard published data.
- **Non-Scope:** WordPress/PHP/plugin compatibility, unlisted features, automatic Git actions and live deployment.
- **Escalation Conditions:** Destructive migration, unapproved paid service, blocked origin TLS or behavior outside the requested business CMS.

### TASK-042: Theme Library, Compatibility Preview and Activation
- **Milestone:** M1
- **Requirement:** REQ-046
- **Constraints:** REQ-018, REQ-021, REQ-034, REQ-036
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/appearance/themes/**`, `apps/web/src/pages/api/tenants/[tenantId]/themes/**`, `packages/core/src/theme/**`, `packages/db/src/themes/**`, `packages/db/migrations/**`, `apps/web/src/core/theme-registry.ts`, `tests/task-042/**`
- **Protected Paths:** `apps/web/src/pages/dashboard/[handle]/appearance/themes/custom/**`, `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-046; PLAN.md sections 11 and 12.
- **Accepted Invariants:** Tenant boundaries, role guards, published/draft separation and existing content survive every operation.
- **Depends On:** TASK-018, TASK-024, TASK-025, TASK-032, TASK-034
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-042 execute successfully and demonstrate: List only granted themes, preview draft with public content, reject incompatible/ungranted activation, then atomically switch theme/config and revision. Confirm previous theme config remains recoverable, content unchanged, and direct API bypass by an editor or another tenant fails.
- **Visual Contract:** PLAN.md section 11 behavior and accepted DESIGN.md; keyboard and 360/768/1440px layouts with loading/empty/error/conflict/permission states.
- **Reopen Conditions:** Missing lifecycle case, dependency contract change, stale evidence or unauthorized cross-tenant data exposure.
- **Rollback/Migration State:** Additive migrations; retain compatible app rollback; never undo a live user's edits or discard published data.
- **Non-Scope:** WordPress/PHP/plugin compatibility, unlisted features, automatic Git actions and live deployment.
- **Escalation Conditions:** Destructive migration, unapproved paid service, blocked origin TLS or behavior outside the requested business CMS.

### TASK-043: Company-Profile Starter Preset (M1)
- **Milestone:** M1
- **Requirement:** REQ-047
- **Constraints:** REQ-019, REQ-028, REQ-029, REQ-030, REQ-034, REQ-036
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/onboarding/**`, `apps/web/src/pages/dashboard/[handle]/appearance/presets/**`, `apps/web/src/pages/api/tenants/[tenantId]/presets/**`, `packages/core/src/presets/**`, `packages/db/src/presets/**`, `packages/db/migrations/**`, `tests/task-043/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-047; PLAN.md sections 11 and 12.
- **Accepted Invariants:** Tenant boundaries, role guards, published/draft separation and existing content survive every operation.
- **Depends On:** TASK-013, TASK-025, TASK-032, TASK-040, TASK-042
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-043 execute successfully and demonstrate: The company-profile preset (M1; other vertical presets are TASK-066) creates only draft starter composition/checklist. Retried setup is idempotent; reapplying on a populated tenant never deletes content. Unsupported/invalid sections fail safely; sample claims remain unpublished, and setup can publish only validated selected sections.
- **Visual Contract:** PLAN.md section 11 behavior and accepted DESIGN.md; keyboard and 360/768/1440px layouts with loading/empty/error/conflict/permission states.
- **Reopen Conditions:** Missing lifecycle case, dependency contract change, stale evidence or unauthorized cross-tenant data exposure.
- **Rollback/Migration State:** Additive migrations; retain compatible app rollback; never undo a live user's edits or discard published data.
- **Non-Scope:** WordPress/PHP/plugin compatibility, unlisted features, automatic Git actions and live deployment.
- **Escalation Conditions:** Destructive migration, unapproved paid service, blocked origin TLS or behavior outside the requested business CMS.

### TASK-044: Content Trash and Recovery (M1)
- **Milestone:** M1
- **Requirement:** REQ-048
- **Constraints:** REQ-008, REQ-009, REQ-012, REQ-034, REQ-036, REQ-039
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/pages/**`, `apps/web/src/pages/dashboard/[handle]/posts/**`, `apps/web/src/pages/dashboard/[handle]/catalog/**`, `apps/web/src/pages/api/tenants/[tenantId]/pages/**`, `apps/web/src/pages/api/tenants/[tenantId]/posts/**`, `apps/web/src/pages/api/tenants/[tenantId]/catalog/**`, `packages/db/src/trash/**`, `packages/db/migrations/**`, `apps/web/src/worker/queues/content-purge/**`, `tests/task-044/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-048; PLAN.md sections 11 and 12.
- **Accepted Invariants:** Tenant boundaries, role guards, published/draft separation and existing content survive every operation.
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-024, TASK-027, TASK-028, TASK-033
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-044 execute successfully and demonstrate: Trash (M1; the 20-revision history is TASK-064) unpublishes and removes sitemap/archive visibility atomically. Restore checks 409 slug/version conflicts and media references; 30-day purge clears joins (and revisions once TASK-064 exists), preserves shared media and reports protected-reference failures. Test owner/editor authorization and tenant isolation.
- **Visual Contract:** PLAN.md section 11 behavior and accepted DESIGN.md; keyboard and 360/768/1440px layouts with loading/empty/error/conflict/permission states.
- **Reopen Conditions:** Missing lifecycle case, dependency contract change, stale evidence or unauthorized cross-tenant data exposure.
- **Rollback/Migration State:** Additive migrations; retain compatible app rollback; never undo a live user's edits or discard published data.
- **Non-Scope:** WordPress/PHP/plugin compatibility, unlisted features, automatic Git actions and live deployment.
- **Escalation Conditions:** Destructive migration, unapproved paid service, blocked origin TLS or behavior outside the requested business CMS.

### TASK-045: Cloudflare for SaaS Fallback-Origin Worker Topology and Route Contract
- **Milestone:** M1
- **Requirement:** REQ-041
- **Constraints:** REQ-001, REQ-002, REQ-004, REQ-034, REQ-042
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/wrangler.jsonc`, `infra/cloudflare/**`, `docs/operations/hosting.md`, `scripts/verify/routes.*`, `tests/task-045/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-041; PLAN.md sections 2, 3 and 12; ADR-0009.
- **Accepted Invariants:** Tenant boundaries, role guards, published/draft separation and existing content survive every operation.
- **Depends On:** TASK-023, TASK-002, TASK-025, TASK-028
- **Verification:** Done when `pnpm test:integration` and `pnpm build` including tests/task-045 execute successfully and demonstrate: in `workerd` (local) the Worker classifies hosts first; customer-host routing works; spoofed `X-Forwarded-Host`/`X-Tenant-ID` headers are ignored; host-isolated `/dashboard`, `/agency`, `/affiliate`, `/console`, `/auth` and admin/console API prefixes; the PLAN 3.3 routing order holds (certificate paths first, host normalized from the request URL only, SaaS-zone apex and `www` moved to the platform, one `301` primary-host redirect that never moves `/api/*` or `/.well-known/*`, identical neutral 404 for every unknown host, state pages with JSON for API paths) return 404 on tenant hosts and public-site routes return 404 on the admin host; `workers.dev` and preview hostnames answer 404 for every surface; staging uses its own SaaS zone and fallback origin (the fallback origin is a per-zone setting); an O2O fixture request carrying `cf-connecting-o2o: 1` follows the same routing and `301` primary redirect. `infra/cloudflare` documents, as reviewable configuration, the SaaS zone, originless fallback-origin record, route `*/*`, the explicit CNAME-target route for customers proxied through their own Cloudflare zone, free `Markdown for Agents` enabled and Free Bot Fight Mode kept off so verified AI search/user fetchers are never JS-challenged (`REQ-095`), WAF and rate-limiting rules within the zone plan, and Turnstile site keys by name only. A reproducible authorized staging test proves one platform subdomain and one custom hostname reach the Worker with their original Host and `CF-Connecting-IP`. No provider mutation occurs in this task.
- **Visual Contract:** No new tenant screen; independent infrastructure evidence required.
- **Reopen Conditions:** Missing lifecycle case, dependency contract change, stale evidence or unauthorized cross-tenant data exposure.
- **Rollback/Migration State:** Additive migrations; retain compatible app rollback; never undo a live user's edits or discard published data.
- **Non-Scope:** WordPress/PHP/plugin compatibility, unlisted features, automatic Git actions and live deployment.
- **Escalation Conditions:** Destructive migration, unapproved paid service or plan upgrade, a needed Enterprise-only feature (wildcard custom hostnames, custom metadata, apex proxying) or behavior outside the requested business CMS.

### TASK-046: Superadmin Tenant Directory and Scoped Operations
- **Milestone:** M1
- **Requirement:** REQ-049
- **Constraints:** REQ-034, REQ-035, REQ-046, REQ-051
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/console/tenants/**`, `apps/web/src/pages/api/console/tenants/**`, `packages/auth/src/platform/**`, `packages/db/src/platform/**`, `packages/db/migrations/**`, `docs/api/**`, `tests/task-046/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-049; PLAN.md section 13; DESIGN.md.
- **Accepted Invariants:** Platform grants are independent of tenant roles; no impersonation or blanket content/PII access; mutations require audit.
- **Depends On:** TASK-026, TASK-032, TASK-042, TASK-048, TASK-067
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-046 pass: Provision/list tenants; enforce allowed state transitions, reason/reauthentication/version/idempotency; grant only registered themes and block revoking active theme. Test tenant-owner denial, revoked operators, audit rollback and unchanged tenant content.
- **Visual Contract:** DESIGN.md platform screens, explicit platform/tenant context, keyboard and 360/768/1440px states.
- **Reopen Conditions:** Platform access bypass, stale grants, unaudited effect or missing provider failure state.
- **Rollback/Migration State:** Additive schema; retain audit data and compatible application rollback.
- **Non-Scope:** Payment processing, mass deletion, shell/SQL console, live deployment and support impersonation.
- **Escalation Conditions:** New privileged action, destructive migration, live provider mutation or access to customer content/PII outside authorization.

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

### TASK-048: Platform Operators, Audit and Health Views
- **Milestone:** M1
- **Requirement:** REQ-051
- **Constraints:** REQ-034, REQ-039, REQ-042
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/console/index.astro`, `apps/web/src/pages/console/operators/**`, `apps/web/src/pages/console/audit/**`, `apps/web/src/pages/console/health/**`, `apps/web/src/pages/console/settings/**`, `apps/web/src/pages/api/console/settings/**`, `apps/web/src/pages/api/console/operators/**`, `apps/web/src/pages/api/console/audit/**`, `apps/web/src/pages/api/console/health/**`, `packages/auth/src/platform/**`, `packages/db/src/platform/**`, `packages/db/migrations/**`, `scripts/platform-operator.*`, `docs/operations/platform-access.md`, `docs/api/**`, `tests/task-048/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-051; PLAN.md section 13; DESIGN.md.
- **Accepted Invariants:** Platform grants are independent of tenant roles; no impersonation or blanket content/PII access; mutations require audit.
- **Depends On:** TASK-025, TASK-028, TASK-032, TASK-037, TASK-049, TASK-067
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-048 pass: platform_settings (sales WhatsApp, support email, terms/privacy URLs) are validated, audited and editable only by operators; explicit bootstrap is idempotent and cannot be invoked anonymously; grants/revocations require reauthentication; concurrent removal preserves final operator. Audit rejects edits and redacts sensitive data; health distinguishes unknown/stale. Revocation affects subsequent requests; audit failure prevents mutation.
- **Visual Contract:** DESIGN.md platform screens, explicit platform/tenant context, keyboard and 360/768/1440px states.
- **Reopen Conditions:** Platform access bypass, stale grants, unaudited effect or missing provider failure state.
- **Rollback/Migration State:** Additive schema; retain audit data and compatible application rollback.
- **Non-Scope:** Payment processing, mass deletion, shell/SQL console, live deployment and support impersonation.
- **Escalation Conditions:** New privileged action, destructive migration, live provider mutation or access to customer content/PII outside authorization.

### TASK-049: Platform Grant, Bootstrap and Audit Foundation
- **Milestone:** M1
- **Requirement:** REQ-051
- **Constraints:** REQ-001, REQ-034, REQ-039
- **Risk Level:** R3
- **Allowed Paths:** `packages/auth/src/platform/**`, `packages/db/src/platform/**`, `packages/db/migrations/**`, `scripts/platform-operator.*`, `docs/operations/platform-access.md`, `tests/task-049/**`
- **Protected Paths:** `packages/auth/**`, `packages/db/migrations/**`, `infra/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`, `.github/workflows/**`
- **Canonical Contract Owners:** PLAN.md sections 13 and 14; PRD.md REQ-051.
- **Accepted Invariants:** Server-authorized scope, no public draft access, no secret exposure, atomic audited privilege changes.
- **Depends On:** TASK-025, TASK-028
- **Verification:** Done when `pnpm test:integration` including tests/task-049 passes: Local synthetic bootstrap, current grant checks and append-only audit execute before provisioning APIs. Deny tenant-role escalation and revoked sessions; concurrent revocation preserves final operator; audit persistence failure prevents state change. TASK-048 consumes these services and adds views; it does not recreate their authority.
- **Visual Contract:** No rendered screen; TASK-048 owns platform operator views.
- **Reopen Conditions:** Privilege bypass, draft leak, replay, missing audit or changed integration contract.
- **Rollback/Migration State:** Additive migrations; no destructive rollback or public fallback on failure.
- **Non-Scope:** Production execution, real credentials, impersonation, public preview sharing and duplicated rendering engines.
- **Escalation Conditions:** Expanded authorization, new infrastructure or incompatible runtime/security changes.

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

### TASK-055: Subscription Obligations and AutoLaris Instruction Creation
- **Milestone:** M1
- **Requirement:** REQ-056
- **Constraints:** REQ-001, REQ-005, REQ-034, REQ-035, REQ-039, REQ-042, REQ-056, REQ-057, REQ-058, REQ-059, REQ-060
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/src/billing/**`, `packages/db/migrations/**`, `packages/core/src/billing/**`, `packages/integrations/src/autolaris/**`, `apps/web/src/pages/api/tenants/[tenantId]/billing/**`, `docs/api/**`, `tests/task-055/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-056; PLAN.md sections 16-17; DESIGN.md sections 10-11.
- **Accepted Invariants:** Server-owned tenant/price/time/entitlement; no payment or trial replay; no live execution or fabricated provider settlement; no automatic operator unsuspension.
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-028, TASK-049
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and relevant `pnpm test:e2e` including tests/task-055 pass: Integration and unit tests with synthetic AutoLaris static-IP relay responses prove immutable snapshots (`Rp 179.000` monthly / `Rp 1.790.000` yearly calendar-period math with month-end clamp), exact IDR money, account-scoped unique references/provider IDs, runtime **QRIS and Virtual Account only** channel validation (rejecting COD, retail and e-wallet redirects) and one creation per obligation. Concurrent requests, mismatched keys, invalid fees/payloads and timeout/crash before provider-ID persistence cannot duplicate charges; no create_payment or shipping calls. Cross-tenant/non-owner access fails with no side effect.
- **Visual Contract:** No new rendered view; TASK-057 consumes typed responses. Final tariff/fees/provider profile are gates for real provider enablement.
- **Reopen Conditions:** Changed fee/period/provider rules, authorization bypass, duplicate charge/grant/trial, late lock or destructive recovery.
- **Rollback/Migration State:** Additive schema; preserve payment references, consumed trials and entitlement history; never reset them on rollback. Reconcile unknown provider effects before retry.
- **Non-Scope:** Automatic debit, visitor checkout, shipment, tax invoices, refund API, live DNS/transactions and video uploads (TASK-060).
- **Escalation Conditions:** A change in refund, storage or tax policy, missing account contract, credentials/live provider operation, new permission or path outside the task; independent R3 review required before completion.

### TASK-056: Advice Reconciliation and Exactly-Once Entitlement Grants
- **Milestone:** M1
- **Requirement:** REQ-057
- **Constraints:** REQ-001, REQ-005, REQ-034, REQ-035, REQ-039, REQ-042, REQ-056, REQ-057, REQ-058, REQ-059, REQ-060
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/worker/queues/billing/**`, `packages/db/src/billing/**`, `packages/core/src/billing/**`, `packages/integrations/src/autolaris/**`, `apps/web/src/pages/api/console/billing/**`, `docs/api/**`, `docs/operations/billing.md`, `tests/task-056/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-057; PLAN.md sections 16-17; DESIGN.md sections 10-11.
- **Accepted Invariants:** Server-owned tenant/price/time/entitlement; no payment or trial replay; no live execution or fabricated provider settlement; no automatic operator unsuspension.
- **Depends On:** TASK-055, TASK-059
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and relevant `pnpm test:e2e` including tests/task-056 pass: Integration tests use an explicit mock-only settlement policy: Advice uses provider transaction_id; generic rc00/SUCCESS/DELIVERED cannot grant access; confirmed mapping, duplicate/late/out-of-order status and expiry/recheck races yield at most one grant per obligation. Unknown IDs, amount evidence, network failure or provider-ID-less creation go to safe reconciliation; manual holds survive payment. Test leases, bounds, redaction, operator authorization and audit rollback. Real settlement mapping remains UNVERIFIED until authorized provider evidence exists.
- **Visual Contract:** No new screen; TASK-057 owns recovery presentation. Gate production on confirmed provider mapping; test vectors use the accepted section 17.2 renewal anchors.
- **Reopen Conditions:** Changed fee/period/provider rules, authorization bypass, duplicate charge/grant/trial, late lock or destructive recovery.
- **Rollback/Migration State:** Additive schema; preserve payment references, consumed trials and entitlement history; never reset them on rollback. Reconcile unknown provider effects before retry.
- **Non-Scope:** Automatic debit, visitor checkout, shipment, tax invoices, refund API, live DNS/transactions and video uploads (TASK-060).
- **Escalation Conditions:** A change in refund, storage or tax policy, missing account contract, credentials/live provider operation, new permission or path outside the task; independent R3 review required before completion.

### TASK-057: Owner Payment Recovery and Scoped Operator Billing Views
- **Milestone:** M1
- **Requirement:** REQ-058
- **Constraints:** REQ-001, REQ-005, REQ-034, REQ-035, REQ-039, REQ-042, REQ-056, REQ-057, REQ-058, REQ-059, REQ-060
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/dashboard/[handle]/billing/**`, `apps/web/src/pages/dashboard/[handle]/service-status/**`, `apps/web/src/components/admin/billing/**`, `apps/web/src/pages/console/billing/**`, `tests/task-057/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-058; PLAN.md sections 16-17; DESIGN.md sections 10-11.
- **Accepted Invariants:** Server-owned tenant/price/time/entitlement; no payment or trial replay; no live execution or fabricated provider settlement; no automatic operator unsuspension.
- **Depends On:** TASK-032, TASK-048, TASK-055, TASK-056, TASK-059
- **Verification:** Done when the payment screen shows the no-refund policy (manual superadmin refund for duplicate/mistaken payment only) and non-PKP *"belum termasuk PPN"* notice before an attempt is created and `pnpm test:unit`, `pnpm test:integration` and relevant `pnpm test:e2e` including tests/task-057 pass: Integration and browser tests exercise owner-only channels, exact total/period disclosure, existing VA/QR/approved redirect, pending/unknown/expired/paid/review and provider outage. Refresh/back/double-click cannot create a second charge. Locked owner sees payment only; member sees owner-contact notice; another tenant remains isolated. Payment-return claims never activate service. Operator on `console.punyasitus.com/billing` sees scoped redacted metadata, audited Advice recheck, and audited duplicate/mistaken refund recording (triggering affiliate reversal if applicable), with no arbitrary paid toggle.
- **Visual Contract:** DESIGN sections 10-11 at 360/768/1440px, keyboard/zoom/status announcements, readable QR alternatives, no locked CMS flash and safe return after verified activation.
- **Reopen Conditions:** Changed fee/period/provider rules, authorization bypass, duplicate charge/grant/trial, late lock or destructive recovery.
- **Rollback/Migration State:** Additive schema; preserve payment references, consumed trials and entitlement history; never reset them on rollback. Reconcile unknown provider effects before retry.
- **Non-Scope:** Automatic debit, visitor checkout, shipment, tax invoices, refund API, live DNS/transactions and video uploads (TASK-060).
- **Escalation Conditions:** A change in refund, storage or tax policy, missing account contract, credentials/live provider operation, new permission or path outside the task; independent R3 review required before completion.

### TASK-058: Verified Signup and Unique Trial Website Provisioning
- **Milestone:** M1
- **Requirement:** REQ-059
- **Constraints:** REQ-001, REQ-005, REQ-034, REQ-035, REQ-039, REQ-042, REQ-056, REQ-057, REQ-058, REQ-059, REQ-060
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/auth/register/**`, `apps/web/src/pages/auth/verify-email/**`, `apps/web/src/pages/auth/onboarding/**`, `apps/web/src/pages/api/onboarding/**`, `packages/auth/src/onboarding/**`, `packages/db/src/provisioning/**`, `packages/db/migrations/**`, `packages/core/src/onboarding/**`, `apps/web/src/worker/queues/onboarding/**`, `docs/api/**`, `tests/task-058/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-059; PLAN.md sections 16-17; DESIGN.md sections 10-11.
- **Accepted Invariants:** Server-owned tenant/price/time/entitlement; no payment or trial replay; no live execution or fabricated provider settlement; no automatic operator unsuspension.
- **Depends On:** TASK-025, TASK-026, TASK-032, TASK-059
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and relevant `pnpm test:e2e` including tests/task-058 pass: Integration and browser tests verify identity before idempotent self-service creation, atomic organization/member/tenant/domain/defaults, server-owned 7-day trial of exactly 604,800 seconds, handle normalization/reservations/races and no public platform authority. Replayed verification, interrupted signup, duplicate handles, forged deadlines/roles and repeated trials fail safely without duplicate tenant or renewed free time. An already-verified owner can create a second website under a distinct handle without a new free trial: it starts payment-only, becomes active after settlement and stays isolated from the first site. Tenant mappings use local fixture hostnames until situsku.click ownership/TLS gates pass.
- **Visual Contract:** DESIGN section 11 signup/verify/onboarding, fixed domain suffix, inline handle errors, recovery for expired links, email outage and partial provisioning. Apply the accepted one-trial-per-verified-owner rule (PLAN section 17.3).
- **Reopen Conditions:** Changed fee/period/provider rules, authorization bypass, duplicate charge/grant/trial, late lock or destructive recovery.
- **Rollback/Migration State:** Additive schema; preserve payment references, consumed trials and entitlement history; never reset them on rollback. Reconcile unknown provider effects before retry.
- **Non-Scope:** Automatic debit, visitor checkout, shipment, tax invoices, refund API, live DNS/transactions and video uploads (TASK-060).
- **Escalation Conditions:** A change in refund, storage or tax policy, missing account contract, credentials/live provider operation, new permission or path outside the task; independent R3 review required before completion.

### TASK-059: Timed Entitlement Gate, Lockout and Maintenance States
- **Milestone:** M1
- **Requirement:** REQ-060
- **Constraints:** REQ-001, REQ-005, REQ-034, REQ-035, REQ-039, REQ-042, REQ-056, REQ-057, REQ-058, REQ-059, REQ-060
- **Risk Level:** R3
- **Allowed Paths:** `packages/core/src/billing/**`, `packages/db/src/billing/**`, `packages/auth/src/permissions.ts`, `packages/auth/src/entitlements/**`, `apps/web/src/layouts/DashboardLayout.astro`, `apps/web/src/middleware/**`, `apps/web/src/components/admin/service-access/**`, `apps/web/src/core/**`, `apps/web/src/components/Maintenance.astro`, `apps/web/src/worker/queues/billing/**`, `apps/web/src/worker/queues/dispatch/**`, `packages/core/src/email/**`, `docs/api/**`, `tests/task-059/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-060; PLAN.md sections 16-17; DESIGN.md sections 10-11.
- **Accepted Invariants:** Server-owned tenant/price/time/entitlement; no payment or trial replay; no live execution or fabricated provider settlement; no automatic operator unsuspension.
- **Depends On:** TASK-002, TASK-025, TASK-028, TASK-032, TASK-055, TASK-077
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and relevant `pnpm test:e2e` including tests/task-059 pass: Unit/integration/browser tests freeze time across 7-day `trial` (`noindex, nofollow`), `active`, `grace` (`H+1..H+3`, site live + CMS editable), `locked` (`H+4..H+7`, **public site still live & indexable**, CMS read/export/pay/sign-out only with writes returning `403 SUBSCRIPTION_LOCKED`), and `suspended` (`H+8+` or unpaid trial expiry, public `503` *"Situs dalam perbaikan"* + `no-store` + `noindex`, payment/leads-CSV shell). H-3, H-1 and H0 reminders carry single-use grace-expiring one-click renewal pay links (`DEC-035 C17`). Concurrent expiry/payment/hold cannot lose or duplicate entitlement; email failure never controls access. Test cross-tenant switching, no data deletion and no restoration of draft publication.
- **Visual Contract:** DESIGN section 11 trial/grace banners, payment-only shell and native maintenance page. Test vectors match the accepted section 17.2 renewal anchors and one-trial-per-account rule.
- **Reopen Conditions:** Changed fee/period/provider rules, authorization bypass, duplicate charge/grant/trial, late lock or destructive recovery.
- **Rollback/Migration State:** Additive schema; preserve payment references, consumed trials and entitlement history; never reset them on rollback. Reconcile unknown provider effects before retry.
- **Non-Scope:** Automatic debit, visitor checkout, shipment, tax invoices, refund API, live DNS/transactions and video uploads (TASK-060).
- **Escalation Conditions:** A change in refund, storage or tax policy, missing account contract, credentials/live provider operation, new permission or path outside the task; independent R3 review required before completion.

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

### TASK-062: SEO Redirects and 404 Monitor
- **Milestone:** Release 1.1 (deferred per DEC-035 C16; excluded from TASK-063 and TASK-038)
- **Requirement:** REQ-067
- **Constraints:** REQ-001, REQ-034, REQ-052, REQ-061
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `apps/web/src/pages/dashboard/[handle]/seo/redirects/**`, `apps/web/src/pages/dashboard/[handle]/seo/not-found/**`, `apps/web/src/pages/api/tenants/[tenantId]/redirects/**`, `apps/web/src/pages/api/tenants/[tenantId]/not-found/**`, `apps/web/src/core/redirects.ts`, `packages/db/src/redirects/**`, `packages/core/src/redirects/**`, `docs/api/**`, `tests/task-062/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`, `.github/workflows/**`
- **Canonical Contract Owners:** PLAN.md section 15.7; PRD.md REQ-067.
- **Accepted Invariants:** Same-host exact-path sources only; internal targets only; one hop; live routes win; tenant-scoped and audited; 404 monitor stores no query, IP or user agent.
- **Depends On:** TASK-024, TASK-027, TASK-032, TASK-036, TASK-051
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-062 pass: owner/admin create, edit, delete and CSV-import redirects with preview; editors and other tenants are denied; regex, wildcard, external and query sources/targets are rejected; loops are rejected and chains flatten to one hop; a source matching a live route is rejected; the 501st redirect fails; 301/308 responses precede 404 and respect the service gate and cache revision; former-slug redirects list read-only; 404 monitor aggregates normalized paths per day, ignores asset extensions, caps at 200 paths for 30 days and offers "Buat redirect".
- **Visual Contract:** DESIGN.md SEO area: redirect list, form, CSV preview and 404 list at 360/768/1440px with keyboard access.
- **Reopen Conditions:** A listed acceptance case fails or the redirect bounds change.
- **Rollback/Migration State:** Keep schema changes additive; disabling redirects falls back to normal 404 behavior without data loss.
- **Non-Scope:** Regex/wildcard rules, external redirects, cross-domain rules, analytics on visitors and Search Console integration.
- **Escalation Conditions:** Request for regex/external redirects or storing visitor identifiers.

### TASK-063: Phase 1 Integration Checkpoint (M1)
- **Milestone:** M1
- **Requirement:** REQ-041
- **Constraints:** REQ-040, REQ-042
- **Risk Level:** R3
- **Allowed Paths:** `.github/workflows/**`, `tests/e2e-gate/**`, `tests/performance/**`, `scripts/verify/**`, `docs/operations/release-checklist.md`, `tests/task-063/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-041; PLAN.md sections 8 and 9; TASKS.md milestones.
- **Accepted Invariants:** Checkpoint scope is exactly the M1 list; it is not a production release (DEC-030); unverified provider/legal gates remain explicit; no production action without authorization.
- **Depends On:** TASK-014, TASK-018, TASK-022, TASK-026, TASK-033, TASK-034, TASK-036, TASK-037, TASK-039, TASK-040, TASK-041, TASK-042, TASK-043, TASK-044, TASK-045, TASK-046, TASK-047, TASK-048, TASK-049, TASK-050, TASK-051, TASK-052, TASK-053, TASK-054, TASK-055, TASK-056, TASK-057, TASK-058, TASK-059, TASK-060, TASK-061, TASK-065, TASK-067, TASK-068, TASK-069, TASK-070, TASK-076, TASK-077, TASK-080, TASK-081, TASK-082, TASK-087, TASK-088, TASK-089, TASK-090, TASK-091, TASK-092, TASK-093, TASK-094, TASK-095, TASK-096, TASK-097, TASK-102, TASK-103, TASK-104, TASK-106, TASK-107, TASK-108
- **Verification:** Done when `pnpm test:e2e` including tests/task-063 executes successfully and demonstrates: clean checkout passes lint/typecheck/unit/integration/e2e/build in CI; all M1 negative cases pass in Chromium at 360/1440 on the production-like local compose topology (staging once it exists); unverified provider/legal/launch gates listed. The full browser matrix, performance lab and restore rehearsal run once, in TASK-038.
- **Visual Contract:** PLAN.md section 8 full browser matrix, run once at the phase 1 checkpoint.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** M2 tasks (TASK-019, TASK-020, TASK-035, TASK-064, TASK-066, TASK-071, TASK-072, TASK-073, TASK-074, TASK-075), live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-064: Content Revision History (M2)
- **Milestone:** M2
- **Requirement:** REQ-048
- **Constraints:** REQ-034, REQ-036
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/revisions/**`, `apps/web/src/pages/api/tenants/[tenantId]/revisions/**`, `apps/web/src/components/admin/revisions/**`, `packages/db/src/pages/**`, `packages/db/src/posts/**`, `packages/db/src/catalog/**`, `apps/web/src/pages/dashboard/[handle]/pages/**`, `apps/web/src/pages/dashboard/[handle]/posts/**`, `apps/web/src/pages/dashboard/[handle]/catalog/**`, `docs/api/**`, `tests/task-064/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PLAN.md sections 5 and 11.5; PRD.md REQ-048.
- **Accepted Invariants:** Restores create drafts only; no public change until Publish; tenant-scoped.
- **Depends On:** TASK-044, TASK-033
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-064 pass: saving keeps the latest 20 revisions per page/post/catalog item; restoring validates schema/references, rejects stale versions and creates a new draft only; purge removes revisions; cross-tenant restores fail.
- **Visual Contract:** DESIGN.md revision list and restore confirmation at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Diff viewer, autosave and scheduled publishing.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

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

### TASK-066: Additional Vertical Starter Presets (M2)
- **Milestone:** M2
- **Requirement:** REQ-047
- **Constraints:** REQ-028, REQ-029, REQ-030
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/presets/**`, `packages/db/src/presets/**`, `apps/web/src/pages/dashboard/[handle]/onboarding/**`, `tests/task-066/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PLAN.md section 11.4; PRD.md REQ-047.
- **Accepted Invariants:** Presets create drafts only; no fabricated claims; idempotent by setup key.
- **Depends On:** TASK-043, TASK-019, TASK-020, TASK-035
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-066 pass: services, travel/Umrah and outlet presets create draft compositions and checklists using their vertical modules; retries are idempotent and populated tenants keep content.
- **Visual Contract:** DESIGN.md onboarding preset selection at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** New vertical modules beyond TASK-019/020/035.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-067: Mandatory Two-Factor Authentication for Platform Operators
- **Milestone:** M1
- **Requirement:** REQ-068
- **Constraints:** REQ-034, REQ-049, REQ-051
- **Risk Level:** R3
- **Allowed Paths:** `packages/auth/**`, `packages/db/migrations/**`, `packages/auth/src/platform/**`, `apps/web/src/middleware/**`, `apps/web/src/pages/auth/two-factor/**`, `apps/web/src/pages/account/security/**`, `apps/web/src/pages/api/auth/**`, `scripts/platform-operator.*`, `docs/operations/platform-access.md`, `tests/task-067/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-068; PLAN.md section 13; DECISIONS.md DEC-021.
- **Accepted Invariants:** Platform authority requires an active grant and a 2FA-completed session; tenant users are never forced into 2FA; no secret, TOTP seed or backup code is logged.
- **Depends On:** TASK-025, TASK-049
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-067 pass: the pinned Better Auth `twoFactor` plugin is configured and its API verified against the installed version; an operator without enrollment reaches only enrollment; a password-only or 2FA-incomplete session gets 403 on every `console.punyasitus.com` page and `/api/console` endpoint (enforced centrally in the platform middleware gate, before the platform feature tasks exist); a reusable `requireRecentSecondFactor` guard is provided and later platform tasks (TASK-026, TASK-046, TASK-047, TASK-048) apply it to grant/revoke, tenant state transition, domain change and theme grant with a 10-minute window; test fixtures provide 2FA-enrolled operators; backup codes are single-use; lost-factor recovery runs only through the audited bootstrap script; a tenant owner can enable and disable optional 2FA and is never forced.
- **Visual Contract:** DESIGN.md auth and account screens: enrollment with QR plus manual key, code entry, backup codes shown once, at 360/1440px with keyboard access.
- **Reopen Conditions:** A listed acceptance case fails, the pinned auth version changes the plugin API, or DEC-021 changes.
- **Rollback/Migration State:** Keep schema changes additive; disabling enforcement is a reviewed configuration change, never a silent fallback.
- **Non-Scope:** Mandatory 2FA for tenant users, SMS OTP, hardware-key-only policy and SSO.
- **Escalation Conditions:** The pinned Better Auth version lacks the plugin capability; a requirement to bypass 2FA for support; destructive migration.

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

### TASK-071: Preferred Schedule Fields for Inquiries
- **Milestone:** M2
- **Requirement:** REQ-072
- **Constraints:** REQ-014, REQ-031, REQ-029, REQ-039, REQ-040
- **Risk Level:** R3
- **Allowed Paths:** `packages/core/src/wa-dispatcher.ts`, `packages/core/src/leads/**`, `packages/db/src/leads/**`, `packages/db/migrations/**`, `apps/web/src/themes/default/sections/SectionContactForm.astro`, `apps/web/src/themes/default/components/**`, `apps/web/src/pages/api/leads.ts`, `apps/web/src/pages/dashboard/[handle]/leads/**`, `docs/api/**`, `tests/task-071/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-072; PLAN.md section 18.4.
- **Accepted Invariants:** No slot inventory or availability claim; date-only values in tenant timezone; WhatsApp CTA works without JS.
- **Depends On:** TASK-010, TASK-021, TASK-019
- **Verification:** Done when `pnpm test:unit` and `pnpm test:e2e` including tests/task-071 pass: tokens expand once and are rejected when unknown; past dates and dates beyond 180 days fail; timezone changes do not shift the date; branch must be an active outlet of the same tenant; preferred_time accepts only pagi/siang/sore/malam; empty fields drop their token sentence; JSON and no-JS submissions with schedule fields stay under 16 KiB, keep idempotency and reject other unknown fields; schedule values never appear in analytics payloads or logs; lead inbox shows the requested schedule; copy says "permintaan jadwal"; no-JS WhatsApp link still works.
- **Visual Contract:** DESIGN.md public form and lead inbox at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Booking slots, calendars, confirmations and reminders to visitors.
- **Escalation Conditions:** Request for availability or booking inventory.

### TASK-072: First-Party Insights: Popular Items, Sources and Peak Hours
- **Milestone:** M2
- **Requirement:** REQ-073
- **Constraints:** REQ-017, REQ-033, REQ-039, REQ-040
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/pages/api/events.ts`, `packages/db/src/analytics/**`, `packages/db/migrations/**`, `packages/core/src/analytics/**`, `apps/web/src/scripts/analytics.ts`, `apps/web/src/pages/dashboard/[handle]/index.astro`, `apps/web/src/pages/dashboard/[handle]/insights/**`, `docs/api/**`, `tests/task-072/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-073; PLAN.md sections 7.3 and 18.4.
- **Accepted Invariants:** Only daily per-tenant aggregates; no cookie, IP, user agent or identifier stored; labelled as estimates.
- **Depends On:** TASK-030, TASK-065
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-072 pass: browser arrivals from a search referrer, a social referrer, a UTM campaign and a direct visit are classified correctly, and later same-site navigation does not change the source; page views and clicks aggregate per content (pages, posts, catalog items) and hour; changing the tenant timezone re-projects hours without rewriting data; OpenAPI is regenerated without drift; dedup keys expire after 24 hours; bot user agents are dropped; stored rows contain no personal or request identifiers; cross-tenant reads fail; the dashboard card shows top items, sources and peak hours with an estimate label and an empty state.
- **Visual Contract:** DESIGN.md tenant overview card at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Visitor-level analytics, heatmaps and attribution claims.
- **Escalation Conditions:** A request to store visitor identifiers or IP addresses.

### TASK-073: Google Maps Review Link and Business Profile Checklist
- **Milestone:** M2
- **Requirement:** REQ-074
- **Constraints:** REQ-011, REQ-036, REQ-044, REQ-047, REQ-054
- **Risk Level:** R3
- **Allowed Paths:** `packages/core/src/settings/**`, `packages/db/src/settings/**`, `packages/db/migrations/**`, `apps/web/src/pages/dashboard/[handle]/settings/**`, `apps/web/src/pages/api/tenants/[tenantId]/settings/**`, `docs/api/**`, `apps/web/src/themes/default/sections/SectionTestimonials.astro`, `apps/web/src/themes/default/sections/SectionContactForm.astro`, `packages/core/src/presets/**`, `tests/task-073/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-074; PLAN.md section 18.4.
- **Accepted Invariants:** Plain link only; no widget, script, copied review text or rating schema.
- **Depends On:** TASK-040, TASK-043
- **Verification:** Done when `pnpm test:unit` and `pnpm test:e2e` including tests/task-073 pass: only the listed Google Maps host/path forms validate and `www.google.com/url?...` is rejected; OpenAPI is regenerated without drift; the link renders with rel attributes in testimonials and contact; JSON-LD contains no Review or AggregateRating; the onboarding checklist step links to the official help page; editors cannot change it.
- **Visual Contract:** DESIGN.md public testimonials/contact and settings at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Google Business Profile API integration and review import.
- **Escalation Conditions:** A request to embed review widgets or copy reviews.

### TASK-074: AI Writing Suggestions in the Editor
- **Milestone:** M2
- **Requirement:** REQ-075
- **Constraints:** REQ-034, REQ-039, REQ-053, REQ-060
- **Risk Level:** R3
- **Allowed Paths:** `packages/core/src/ai-writing/**`, `apps/web/src/pages/api/tenants/[tenantId]/ai-writing/**`, `apps/web/src/components/admin/editor/**`, `packages/db/src/ai-usage/**`, `packages/db/migrations/**`, `docs/api/**`, `docs/operations/privacy.md`, `tests/task-074/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-075; PLAN.md section 18.4; DECISIONS.md DEC-026 and open AI-provider decision.
- **Accepted Invariants:** Suggestions are never saved or published automatically; only selected fields are sent; quota and rate limits enforced; provider is a listed subprocessor.
- **Depends On:** TASK-033, TASK-052
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-074 pass against a mocked provider: insert/edit/discard flows leave content unchanged until the editor saves; requests contain only the selected fields and vertical; selected text containing an email or phone number is blocked before sending; leads are never sent; failed provider calls do not consume quota; locked tenants are denied; quota exhaustion and provider failure show clear messages; cross-tenant usage fails; logs contain no prompt text; the 101st suggestion in a 30-day period is refused with a clear message (DEC-028); the provider is recorded in DECISIONS.md before this task starts.
- **Visual Contract:** DESIGN.md editor inspector at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Automatic page generation, image generation and publishing by AI.
- **Escalation Conditions:** No provider/quota decision, or a request to send personal data to the provider.

### TASK-075: Tenant MCP Server for AI Agents
- **Milestone:** M2
- **Requirement:** REQ-076
- **Constraints:** REQ-001, REQ-034, REQ-036, REQ-039, REQ-060, REQ-068
- **Risk Level:** R3
- **Allowed Paths:** `packages/auth/**`, `packages/db/migrations/**`, `packages/core/src/mcp/**`, `apps/web/src/pages/mcp/**`, `apps/web/src/pages/api/auth/**`, `apps/web/src/pages/auth/consent/**`, `apps/web/src/pages/account/connected-apps/**`, `apps/web/src/middleware/**`, `packages/db/src/mcp/**`, `docs/api/**`, `docs/operations/mcp.md`, `tests/task-075/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-076; ADR-0008; PLAN.md section 18.3.
- **Accepted Invariants:** Admin host only; one website per grant; tools reuse server services and schemas; no delete, URL fetch, billing, domain, member or platform tools; every call rechecks membership, scope and entitlement and is audited.
- **Depends On:** TASK-025, TASK-033, TASK-049, TASK-059, TASK-067
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-075 pass with a local MCP test client: RFC 9728/8414 discovery and OAuth with PKCE succeed; tokens without or with a different RFC 8707 resource are rejected; reused codes, mismatched redirect URIs or PKCE verifiers and replayed refresh tokens fail; consent POST without the session CSRF/Origin fails; CIMD fetches to private addresses or via redirects are refused; consent binds one tenant and chosen scopes; tokens for tenant A cannot read or write tenant B; editors cannot connect agents; an admin demoted to editor loses access on the next call; session cookies are ignored on /mcp; /mcp and /.well-known/oauth-* return 404 on tenant hosts; a publish call only yields an approval link and an injected instruction in tool output cannot publish without the confirmation; revoked tokens and removed members fail immediately; locked tenants get an error without data; write tools create drafts only and publish needs its own scope; excluded tools are absent from the tool list; calls are audited and rate-limited; ChatGPT and Claude connection to a synthetic staging tenant is recorded as staging evidence (Grok recorded when supported, otherwise listed as unsupported).
- **Visual Contract:** DESIGN.md consent screen and connected-apps list at 360/1440px.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Public anonymous API, operator tools over MCP, media upload from URLs and automatic publishing.
- **Escalation Conditions:** A client requires an auth mode the pinned Better Auth version lacks; a request for platform or billing tools.

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

### TASK-077: Transactional Email Adapter (`env.EMAIL.send()` Cloudflare Email Service Primary + Resend Fallback)
- **Milestone:** M1
- **Requirement:** REQ-077
- **Constraints:** REQ-034, REQ-039, REQ-042, REQ-060
- **Risk Level:** R3
- **Allowed Paths:** `packages/core/src/email/**`, `apps/web/wrangler.jsonc`, `apps/web/src/worker/queues/dispatch/**`, `apps/web/src/worker/queues/email/**`, `apps/web/src/pages/api/webhooks/email/**`, `packages/db/src/email/**`, `packages/db/migrations/**`, `docs/operations/email.md`, `docs/api/**`, `tests/task-077/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-077; PLAN.md sections 1 and 12; ADR-0009; DECISIONS.md DEC-031, DEC-038.
- **Accepted Invariants:** One `EmailPort` adapter for all mail backed primarily by Cloudflare Email Service (`env.EMAIL.send()` binding on Workers Paid, encoding PDF receipt attachments as Base64 strings) with Resend HTTP retained as an optional config fallback; local/CI runs use a local mail sink; Cloudflare suppression list (`E_RECIPIENT_SUPPRESSED` / drop-suppressed) and optional bounce webhooks respected; email never controls access.
- **Depends On:** TASK-023, TASK-028
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-077 pass: templates render in Bahasa Indonesia with escaped data and a plain-text part; jobs retry with bounded backoff and dedupe by message key; one-shot messages take a claim before sending and an ambiguous outcome is never replayed (`submitted`/`failed`/`unknown`/`skipped`/`duplicate` recorded without recipient or text), the `send_email` binding is restricted to `noreply@notif.punyasitus.com`, and mocked `env.EMAIL.send()` (incl. Base64 PDF attachment and `E_RECIPIENT_SUPPRESSED` / rate-limit error codes) plus optional signed bounce webhook add/respect suppressed addresses with a visible owner notice while unsigned/replayed webhooks fail; the local mail sink receives verification, reset and invitation mail used by TASK-025/TASK-026 tests; `docs/operations/email.md` documents Cloudflare Email Service domain onboarding and SPF/DKIM/DMARC for `notif.punyasitus.com`, and a staging send is recorded as staging evidence.
- **Visual Contract:** No new admin screens beyond the suppression notice; email templates checked in a mail client preview at mobile width.
- **Reopen Conditions:** A listed acceptance case fails, the provider changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; switching provider replaces only the adapter implementation.
- **Non-Scope:** Marketing/newsletter email, mailbox hosting and tenant-domain sending.
- **Escalation Conditions:** Provider terms or pricing change materially, or a need to send from tenant domains.

### TASK-078: Pre-Launch Security Assurance (ASVS L2, ZAP, Cross-Tenant)
- **Milestone:** M2
- **Requirement:** REQ-078
- **Constraints:** REQ-001, REQ-034, REQ-038, REQ-039, REQ-068, REQ-076
- **Risk Level:** R3
- **Allowed Paths:** `docs/security/**`, `tests/security/**`, `.github/workflows/security.yml`, `scripts/security/**`, `tests/task-078/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-078; PLAN.md section 12; DECISIONS.md DEC-032.
- **Accepted Invariants:** Findings are fixed in their owning tasks' paths through normal task reopen, not inside this task; no testing against production or third-party systems without authorization.
- **Depends On:** TASK-063, TASK-067, TASK-075, TASK-076, TASK-077, TASK-079, TASK-083, TASK-084, TASK-085, TASK-086, TASK-098, TASK-099, TASK-100, TASK-101, TASK-102, TASK-103, TASK-107, TASK-109
- **Verification:** Done when `pnpm test:security` including tests/task-078 passes: the ASVS 5.0 L2 checklist in docs/security maps every applicable requirement to a test, control or accepted risk; the cross-tenant suite enumerates every tenant-owned API route, MCP tool and public route and proves 404/403 for foreign tenants; the ZAP baseline workflow runs in CI with no unaccepted high/medium alerts; a ZAP full scan against the production-like environment is recorded with each high/medium finding fixed (owning task reopened) or accepted with reason; an independent reviewer of a different model family signs off the report and the retest.
- **Visual Contract:** None.
- **Reopen Conditions:** A new internet-facing surface is added, a high finding reappears, or the ASVS version changes.
- **Rollback/Migration State:** Documentation and tests only.
- **Non-Scope:** Paid external pentest (DEC-032) and certification.
- **Escalation Conditions:** A critical finding that changes architecture, or a customer contract requiring an external pentest.

### TASK-079: Vehicle Showroom Offering (`/kendaraan`) & Static Credit-Estimate Table
- **Milestone:** M2
- **Requirement:** REQ-079
- **Constraints:** REQ-001, REQ-012, REQ-022, REQ-054
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/catalog/vehicle.ts`, `packages/core/src/schema-generator.ts`, `apps/web/src/pages/dashboard/[handle]/catalog/vehicles/**`, `apps/web/src/pages/kendaraan/**`, `apps/web/src/themes/default/sections/SectionVehiclesGrid.astro`, `tests/task-079/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-079; PLAN.md section 19.1; DESIGN.md section 12.
- **Accepted Invariants:** `vehicle` offerings render at `/kendaraan` and `/kendaraan/{slug}` for cars and motorcycles; `sold` units stay indexable with a `TERJUAL` badge; credit estimates are pure server-rendered integer math (`<=3` DP %, `<=4` tenors) with zero client JS and mandatory non-financing disclaimer; `Vehicle` JSON-LD never emits unsupported `Reserved` availability.
- **Depends On:** TASK-009, TASK-013, TASK-015, TASK-033, TASK-036
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-079 pass: car and motorcycle attributes validate (`mileage_km` rejected on `new`); `available`/`booked`/`sold` transitions preserve indexable detail pages while `hide_sold_in_grids` filters grids; integer credit math matches exact `round_half_up` fixtures with zero client JS and hides when not `published`+`available`+`fixed`; `Vehicle` JSON-LD matches visible facts.
- **Visual Contract:** DESIGN.md sections 6 and 12; showroom card/detail and credit table at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Financing application capture, leasing partner APIs or interactive JS calculators.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

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

### TASK-081: Numbered PDF Payment Receipts, Email Delivery & Credit Adjustments
- **Milestone:** M1
- **Requirement:** REQ-081
- **Constraints:** REQ-057, REQ-058, REQ-077
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/billing/receipts/**`, `packages/core/src/billing/receipt-pdf.ts`, `apps/web/src/worker/queues/billing/**`, `apps/web/src/pages/api/tenants/[tenantId]/billing/receipts/**`, `apps/web/src/pages/api/agency/receipts/**`, `apps/web/src/pages/api/console/billing/**`, `docs/api/**`, `tests/task-081/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-081; PLAN.md sections 16.1 and 19.3.
- **Accepted Invariants:** Every confirmed settlement allocates a gap-free yearly sequential receipt number (`PS-YYYY-NNNNNN`) in `PLATFORM_DB`, generates an immutable PDF via `pdf-lib` in the Worker (storing in R2 and emailing through `EmailPort`, Cloudflare Email Service `env.EMAIL.send()` primary per DEC-038), and never mutates issued receipts (refunds/adjustments emit separate linked credit documents).
- **Depends On:** TASK-055, TASK-056, TASK-057, TASK-077
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-081 pass: concurrent settlements allocate gap-free sequential numbers without collision; generated PDF bytes are valid, non-empty, immutable in R2 and show non-PKP notice plus itemized plan/discount/channel-fee lines; only the payer (owner or agency) and console operators can download; duplicate-payment refund issues a linked credit note without altering the original receipt.
- **Visual Contract:** None (PDF document layout and existing billing table download action).
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Tax-invoice (e-Faktur PKP) integration.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-082: Yearly Subscription Plans & Promotional Coupon Engine
- **Milestone:** M1
- **Requirement:** REQ-082
- **Constraints:** REQ-051, REQ-056, REQ-058
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/billing/coupons/**`, `packages/core/src/billing/coupons.ts`, `apps/web/src/pages/console/coupons/**`, `apps/web/src/pages/api/console/coupons/**`, `apps/web/src/pages/api/tenants/[tenantId]/billing/**`, `apps/web/src/components/admin/billing/**`, `docs/api/**`, `tests/task-082/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-082; PLAN.md sections 16.1, 17.1 and 19.3.
- **Accepted Invariants:** Checkout supports monthly (`Rp 179.000`) and yearly (`Rp 1.790.000`, 12 calendar months) plans from `platform_settings` and at most one coupon (`percent` or `fixed_idr`), enforcing window, redemption cap, 1-per-tenant rule and AutoLaris minimum floor atomically.
- **Depends On:** TASK-048, TASK-055, TASK-057, TASK-067
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-082 pass: yearly plan grants 12 calendar months with month-end clamp and displays `12 * monthly - yearly` savings; expired, exhausted, wrong-plan, stacked or repeat-tenant coupons fail; concurrent checkouts cannot exceed `max_redemptions`; coupon discount reduces net base before affiliate commission calculation.
- **Visual Contract:** DESIGN.md checkout plan selector and coupon input on mobile/desktop.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Automatic coupon stacking or public coupon marketplaces.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-083: Agency / Reseller Portal, Client Provisioning & Agency-Payer Billing
- **Milestone:** M2
- **Requirement:** REQ-083
- **Constraints:** REQ-001, REQ-034, REQ-056, REQ-068
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/agencies/**`, `packages/auth/src/agency/**`, `apps/web/src/layouts/AgencyLayout.astro`, `apps/web/src/pages/agency/**`, `apps/web/src/pages/api/agency/**`, `apps/web/src/pages/console/agencies/**`, `apps/web/src/pages/api/console/agencies/**`, `docs/api/**`, `tests/task-083/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-083; PLAN.md section 19.4; DESIGN.md section 4.2.
- **Accepted Invariants:** Agencies enroll via operator invite or self-registration (mandatory TOTP, `0%` initial discount, max 3 unpaid trials until first paid client); agencies manage only linked clients with audited actor attribution and own 100% of client billing/reminders/receipts while client members never see billing.
- **Depends On:** TASK-026, TASK-046, TASK-057, TASK-067, TASK-081, TASK-082, TASK-090
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-083 pass: un-enrolled 2FA agency user is blocked; 4th unpaid trial before first payment is rejected; agency switch into `/dashboard/{handle}` shows client banner and logs agency user in audit; client owner/admin/editor get 403/hidden on billing routes while agency receives reminders and PDF receipts; cross-agency access returns 404.
- **Visual Contract:** DESIGN.md section 4.2 Agency Portal shell at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** White-label custom domain for `app.punyasitus.com` itself.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-084: Affiliate Enrollment, First-Party Referral Attribution & Anti-Abuse Locks
- **Milestone:** M2
- **Requirement:** REQ-084
- **Constraints:** REQ-039, REQ-059, REQ-090
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/affiliates/**`, `packages/core/src/affiliates/**`, `apps/web/src/middleware/**`, `apps/web/src/pages/api/affiliates/apply.ts`, `apps/web/src/pages/api/onboarding/**`, `docs/api/**`, `tests/task-084/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-084; PLAN.md section 19.4.
- **Accepted Invariants:** Affiliate is a separate account type; `?ref=<code>` sets a 30-day first-party attribution cookie on `punyasitus.com` (or manual code at signup) and locks `referred_by_affiliate_id` immutably at trial creation; self-referral, agency-managed, demo and complimentary tenants are ineligible.
- **Depends On:** TASK-058, TASK-083, TASK-087, TASK-090
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-084 pass: valid `?ref=` within 30 days attributes signup once and cannot be overwritten later; expired (>30d) cookie, suspended affiliate, self-referral (matching user/email/payout identity) and agency-created tenants produce zero attribution; trial sites render the minimalist *"Dibuat dengan PunyaSitus"* footer badge while paid sites can hide it or attach their verified `?ref=<code>`.
- **Visual Contract:** None (API/cookie attribution and application endpoint).
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Multi-level marketing (MLM) tiers or third-party ad-network tracking cookies.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-085: Affiliate Commission Ledger (`60%`/`20%`), 14-Day Hold & Bi-Monthly Payout Batches
- **Milestone:** M2
- **Requirement:** REQ-085
- **Constraints:** REQ-057, REQ-081, REQ-084
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/affiliates/ledger/**`, `packages/core/src/affiliates/commission.ts`, `apps/web/src/worker/queues/billing/**`, `apps/web/src/worker/cron/**`, `tests/task-085/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-085; PLAN.md section 19.4.
- **Accepted Invariants:** Confirmed net subscription receipts (excluding AutoLaris fee and coupons) record `60%` on a referred tenant's first paid invoice and `20%` on renewals in `pending` state for 14 days before `approved`; refunded invoices reverse pending commissions or create negative balance offsets; Cron builds payout batches on the `15th` and `30th` (`Asia/Jakarta`) for balances `>= Rp 100.000`.
- **Depends On:** TASK-056, TASK-081, TASK-082, TASK-084
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-085 pass: frozen-time tests verify exact integer IDR `60%` first-payment and `20%` renewal calculation on net discounted base, duplicate settlement idempotency, 14-day `pending`->`approved` promotion, pre- and post-payout refund reversal/offset, and `15th`/`30th` `Asia/Jakarta` batch generation skipping balances `< Rp 100.000`.
- **Visual Contract:** None (ledger and scheduled batch engine).
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Automated bank-disbursement API calls (payout transfer is manual & audited in TASK-086).
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-086: Affiliate Self-Service Portal & Console Payout Management
- **Milestone:** M2
- **Requirement:** REQ-086
- **Constraints:** REQ-051, REQ-068, REQ-084, REQ-085
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/layouts/AffiliateLayout.astro`, `apps/web/src/pages/affiliate/**`, `apps/web/src/pages/api/affiliate/**`, `apps/web/src/pages/console/affiliates/**`, `apps/web/src/pages/api/console/affiliates/**`, `docs/api/**`, `tests/task-086/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-086; PLAN.md section 19.4; DESIGN.md section 4.3.
- **Accepted Invariants:** Affiliates view referral link, click/trial/paid counts (masked tenant handles only, zero tenant PII/content), pending/approved/paid balances and payout history; console operators approve/suspend affiliates and mark payout batches paid with transfer reference and audit.
- **Depends On:** TASK-032, TASK-048, TASK-067, TASK-084, TASK-085
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-086 pass: affiliate dashboard renders masked referrals and accurate ledger totals with zero tenant PII leakage; foreign-affiliate and tenant-only sessions get 403/404; operator approval/suspension and batch payout reference recording require 2FA + reason and write `platform_audit`.
- **Visual Contract:** DESIGN.md section 4.3 Affiliate Portal and Console Affiliate screens at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Exposing referred customer emails, phones or leads to affiliates.
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

### TASK-090: Primary Google Sign-In (`Masuk dengan Google`) & Cloudflare Turnstile Guards
- **Milestone:** M1
- **Requirement:** REQ-090
- **Constraints:** REQ-034, REQ-038, REQ-059, REQ-068
- **Risk Level:** R3
- **Allowed Paths:** `packages/auth/**`, `packages/core/src/security/turnstile.ts`, `apps/web/src/pages/auth/**`, `apps/web/src/pages/api/auth/**`, `apps/web/src/middleware/**`, `tests/task-090/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-090; PLAN.md sections 4, 6 and 17.2; DESIGN.md section 4.
- **Accepted Invariants:** "Masuk dengan Google" is the primary sign-in/signup button on `app.punyasitus.com` (`email_verified: true` accounts link cleanly to email/password); `console.punyasitus.com` enforces Google email allowlist + active `platform_operators` grant + mandatory TOTP; server-verified Cloudflare Turnstile protects signup, login, reset, lead/custom forms and abuse reports.
- **Depends On:** TASK-024, TASK-025, TASK-049, TASK-067
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-090 pass: mocked Google OAuth callback creates/links verified account without duplicate user or extra trial; unverified email accounts cannot auto-link; non-allowlisted Google account gets 403 on `console.punyasitus.com`; missing/invalid Turnstile token fails server-side before hitting auth or lead mutations.
- **Visual Contract:** DESIGN.md login/register screen with primary `Masuk dengan Google` CTA at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Facebook/Apple/TikTok social login providers.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

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

### TASK-095: AI & Search Visibility Engine (`robots.txt` Bot Split, `IndexNow` & `AI Assistant` Attribution)
- **Milestone:** M1
- **Requirement:** REQ-095
- **Constraints:** REQ-015, REQ-016, REQ-073
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/seo/robots.ts`, `packages/core/src/seo/indexnow.ts`, `packages/core/src/analytics/attribution.ts`, `apps/web/src/pages/robots.txt.ts`, `apps/web/src/pages/[indexnowKey].txt.ts`, `apps/web/src/pages/dashboard/[handle]/seo/**`, `apps/web/src/worker/queues/seo/**`, `apps/web/src/worker/cron/**`, `docs/api/**`, `tests/task-095/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-095; PLAN.md section 19.6; DESIGN.md section 9.
- **Accepted Invariants:** Dynamic `/robots.txt` separates search/user-triggered AI bots (`Googlebot`, `Bingbot`, `OAI-SearchBot`, `ChatGPT-User`, `Claude-SearchBot`, `Claude-User`, `PerplexityBot`, `Perplexity-User`, `Applebot` allowed on active paid sites) from training bots (`GPTBot`, `ClaudeBot`, `Google-Extended`, `Applebot-Extended`, controlled by owner toggle); verified custom-domain publishes enqueue deduplicated `IndexNow` pings; analytics & leads classify AI referrals (`chatgpt.com`, `claude.ai`, `perplexity.ai`, `gemini.google.com`, `copilot.microsoft.com`, `utm_medium=ai-assistant`) into `AI Assistant`.
- **Depends On:** TASK-003, TASK-016, TASK-028, TASK-051, TASK-059
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-095 pass: trial/suspended sites emit `Disallow: /` + `noindex`, while active paid sites allow search/citation bots, toggle training bots cleanly, and disallow multi-parameter faceted filter queries on `/kendaraan` & `/produk`; past `tour` departure dates are omitted from public HTML and JSON-LD; publishing on a verified custom domain serves `/<key>.txt` and sends one deduplicated `IndexNow` ping (including after confirmed MCP publishes, skipped on `.situsku.click` trials); events, WhatsApp clicks and leads from AI referrers (`chatgpt.com`, `perplexity.ai`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, `utm_medium=ai-assistant`) land in `ai_assistant`.
- **Visual Contract:** DESIGN.md section 9 AI Crawler Controls toggle card and Insights `AI Assistant` channel row.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Speculative `llms.txt` generation or paid third-party SEO API subscriptions.
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

### TASK-098: Plugin Store, Bespoke Client Grants (`private_client`) & AutoLaris Add-on Billing
- **Milestone:** M2
- **Requirement:** REQ-098
- **Constraints:** REQ-051, REQ-056, REQ-068, REQ-081, REQ-082, REQ-083, REQ-085, REQ-097
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/plugins/store/**`, `packages/core/src/plugins/billing.ts`, `apps/web/src/pages/dashboard/[handle]/plugins/**`, `apps/web/src/pages/api/tenants/[tenantId]/plugins/**`, `apps/web/src/pages/agency/plugins/**`, `apps/web/src/pages/api/agency/plugins/**`, `apps/web/src/pages/console/plugins/**`, `apps/web/src/pages/api/console/plugins/**`, `apps/web/src/worker/queues/billing/**`, `docs/api/**`, `tests/task-098/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-098; ADR-0010; PLAN.md section 19.7; DESIGN.md section 7.
- **Accepted Invariants:** `Plugin` is a dedicated top-level sidebar menu supporting symmetric **Gratis** (`public_free`), **Berbayar** (`public_paid`: `paid_once`, `paid_monthly`, `paid_yearly` via AutoLaris QRIS/VA, agency-billed for agency clients, issuing PDF receipts and affiliate commissions), and **Custom Dev** (`private_client` client/agency grants + `service_kind = "custom_plugin"` bespoke development request & quote workflow fulfilled on `console.punyasitus.com/plugins` by linking a `private_client` grant, promotable to the public store via metadata without code rewrite); installed plugins never add top-level sidebar spam; expiry/disable preserves `plg_*` data until `H+45` purge.
- **Depends On:** TASK-048, TASK-061, TASK-067, TASK-075, TASK-081, TASK-082, TASK-083, TASK-085, TASK-097
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-098 pass: `Plugin -> Custom Dev` submits a rate-limited `custom_plugin` request and operators deliver it only after linking an active `private_client` plugin grant; `private_client` plugin is invisible to ungranted tenants, works for granted client, and appears in store immediately when promoted by 2FA operator to `public_free` or `public_paid`; `paid_once` and `paid_monthly` checkouts settle via mocked AutoLaris Advice, generate numbered PDF receipts, credit affiliate commission, route agency-managed client purchases to the agency payer, and cleanly deactivate on add-on expiry without deleting `plg_*` rows.
- **Visual Contract:** DESIGN.md section 7 `Toko Plugin` (`Terpasang` / `Gratis` / `Berbayar` / `Khusus Klien`) and `console.punyasitus.com/plugins` at 360/1440 px.
- **Reopen Conditions:** Billing entitlement race, agency-client billing leak, or loss of `plg_*` data on plugin disable/expiry.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Revenue-share payouts to external third-party plugin developers.
- **Escalation Conditions:** Destructive migration or required change exceeding declared path boundary.

### TASK-099: Official Launch Seed Plugins (`bio-links` Free & `wa-cs-rotator` Commercial/Grantable)
- **Milestone:** M2
- **Requirement:** REQ-099
- **Constraints:** REQ-001, REQ-014, REQ-040, REQ-097, REQ-098
- **Risk Level:** R2
- **Allowed Paths:** `packages/plugins/bio-links/**`, `packages/plugins/wa-cs-rotator/**`, `apps/web/src/core/plugin-registry.ts`, `docs/api/**`, `tests/task-099/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-099; ADR-0010; PLAN.md section 19.7; `docs/plugins/PLUGIN-DEVELOPMENT.md`.
- **Accepted Invariants:** Both plugins live strictly inside `packages/plugins/*` with **zero edits to Frozen Core CMS packages** (`packages/core`, `packages/db`, `packages/auth`, `middleware`); `bio-links` serves a zero-JS `/link` page with first-party click stats; `wa-cs-rotator` distributes WhatsApp CTAs across multiple sales agents (round-robin, weights, active hours) with per-agent click attribution while unentitled websites retain the single-number base WhatsApp flow (`REQ-014`).
- **Depends On:** TASK-014, TASK-030, TASK-097, TASK-098
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-099 pass: `git diff` touches zero Frozen Core CMS files outside `plugin-registry.ts`; enabling `bio-links` publishes `/link` with `0` bytes client JS and records click counts in `plg_bio_links__*`; enabling `wa-cs-rotator` rotates WA redirects across active agents according to weight/schedule, skips off-shift agents (falling back to primary WA), logs per-agent clicks in `plg_wa_cs_rotator__*`, and returns to single-number WA immediately when disabled.
- **Visual Contract:** Public `/link` bio page and `base-nova` admin configuration screens for `bio-links` and `wa-cs-rotator` at 360/1440 px.
- **Reopen Conditions:** Any modification required in Frozen Core packages, public JS exceeding `25 KiB`, or cross-tenant CS rotation leak.
- **Rollback/Migration State:** Additive `plg_bio_links__*` and `plg_wa_cs_rotator__*` tables only; preserve data.
- **Non-Scope:** Official WhatsApp Business Cloud API chatbot inbox or paid Meta conversation billing.
- **Escalation Conditions:** Required change exceeding `packages/plugins/*` boundary into Frozen Core modules.

### TASK-100: Official Free Plugin `wp-importer` (WordPress `/wp-json` & WXR Safe Draft Importer)
- **Milestone:** M2
- **Requirement:** REQ-100
- **Constraints:** REQ-001, REQ-009, REQ-010, REQ-064, REQ-097
- **Risk Level:** R2
- **Allowed Paths:** `packages/plugins/wp-importer/**`, `apps/web/src/core/plugin-registry.ts`, `docs/api/**`, `tests/task-100/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-100; ADR-0010; PLAN.md section 19.7; `docs/plugins/PLUGIN-DEVELOPMENT.md`.
- **Accepted Invariants:** Built strictly inside `packages/plugins/wp-importer` with zero edits to Frozen Core CMS modules; imports posts, categories/tags, public SEO fields and SSRF-checked images (normalized to WebP in R2 within the website's storage quota) from a public WordPress URL (`/wp-json/wp/v2`) or uploaded WXR XML exclusively into unpublished `draft` records with an import report and former-URL inventory.
- **Depends On:** TASK-006, TASK-007, TASK-097, TASK-098
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-100 pass: `git diff` touches zero Frozen Core files outside `plugin-registry.ts`; golden WordPress `/wp-json` and WXR fixtures import into sanitized TipTap JSON `draft` posts (never auto-published) with categories and R2 WebP images; private/loopback SSRF URLs (`127.0.0.1`, `169.254.169.254`, `10.0.0.0/8`, IPv6 local), XML bombs, SVG/executable media and quota-exceeding imports fail safely.
- **Visual Contract:** `base-nova` WordPress import wizard & dry-run summary report inside `/dashboard/[handle]/plugins/wp-importer` at 360/1440 px.
- **Reopen Conditions:** SSRF bypass, auto-publishing unreviewed imports, quota bypass, or edits leaking into Frozen Core packages.
- **Rollback/Migration State:** Additive `plg_wp_importer__*` job-history tables only; preserve data.
- **Non-Scope:** Pixel-identical Elementor layout cloning, WooCommerce orders, or third-party WordPress plugin execution.
- **Escalation Conditions:** Required change exceeding `packages/plugins/wp-importer` boundary into Frozen Core modules.

### TASK-101: Official Plugin `lead-notifier` (1-Click Telegram Bot Linking & Signed CRM/Sheets Webhook)
- **Milestone:** M2
- **Requirement:** REQ-101
- **Constraints:** REQ-001, REQ-031, REQ-039, REQ-042, REQ-097, REQ-098
- **Risk Level:** R2
- **Allowed Paths:** `packages/plugins/lead-notifier/**`, `apps/web/src/core/plugin-registry.ts`, `docs/api/**`, `tests/task-101/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-101; ADR-0010; PLAN.md section 19.7; `docs/plugins/PLUGIN-DEVELOPMENT.md`.
- **Accepted Invariants:** Built strictly inside `packages/plugins/lead-notifier` with zero edits to Frozen Core CMS modules; 1-click `"Hubungkan Telegram"` generates a 15-minute single-use token for `https://t.me/<PlatformBot>?start=<token>` verified via `X-Telegram-Bot-Api-Secret-Token` on `/api/plugins/lead-notifier/webhook` (zero manual `chat_id` entry); `lead.created` Queue hook dispatches formatted inquiry + tap-to-WhatsApp CTA to Telegram (`public_free`) and/or HMAC-signed SSRF-guarded HTTPS webhooks (`public_paid` / grantable) without ever blocking or failing `POST /api/leads`.
- **Depends On:** TASK-021, TASK-028, TASK-097, TASK-098
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-101 pass: `git diff` touches zero Frozen Core files outside `plugin-registry.ts`; mocked Telegram `/start <token>` links the tenant chat once, rejects missing/wrong `X-Telegram-Bot-Api-Secret-Token`, expired (`>15m`) or replayed tokens, and delivers `lead.created` notifications with a valid `wa.me` follow-up button; webhook target blocks private IPs (SSRF) and signs payloads; simulated Telegram/webhook `500`/timeout still saves the lead in `TenantStore` with `200`.
- **Visual Contract:** `base-nova` 1-click Telegram connect/disconnect card and webhook test UI inside `/dashboard/[handle]/plugins/lead-notifier` at 360/1440 px.
- **Reopen Conditions:** Lead submission blocked by notifier failure, webhook SSRF bypass, cross-tenant chat token replay, or edits leaking into Frozen Core packages.
- **Rollback/Migration State:** Additive `plg_lead_notifier__*` tables only; preserve data.
- **Non-Scope:** Two-way live-chat ticketing inbox inside Telegram.
- **Escalation Conditions:** Required change exceeding `packages/plugins/lead-notifier` boundary into Frozen Core modules.

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

### TASK-105: WhatsApp Support Entry Point with Context and Published Hours
- **Milestone:** M2
- **Requirement:** REQ-105
- **Constraints:** REQ-083, REQ-090
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/components/admin/help/**`, `packages/core/src/support/**`, `apps/web/src/pages/console/settings/**`, `apps/web/src/pages/api/console/settings/**`, `tests/task-105/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-105; PLAN.md section 20.2.
- **Accepted Invariants:** The prefilled message holds only the handle and screen name; number, hours and response target come from platform settings; agency-managed websites show the agency contact first.
- **Depends On:** TASK-032, TASK-048, TASK-083
- **Verification:** Done when `pnpm test:unit` and `pnpm test:e2e` including tests/task-105 pass: the help button opens `wa.me` with the platform number and a message containing the handle and screen but no token, password or visitor data; support hours and the response target render from settings edited on the console with audit; a client member of an agency sees the agency contact.
- **Visual Contract:** Dashboard help button and support-hours panel at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Ticketing systems, shared inbox software or WhatsApp Business API integration.
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

### TASK-109: Optional AI Draft Step in Onboarding
- **Milestone:** M2
- **Requirement:** REQ-109
- **Constraints:** REQ-075, REQ-093
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/onboarding/ai-draft/**`, `apps/web/src/pages/auth/onboarding/**`, `apps/web/src/pages/api/onboarding/**`, `tests/task-109/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-109; PLAN.md section 20.5; DECISIONS.md DEC-028.
- **Accepted Invariants:** Generated text is always a `CONTOH` draft, never published automatically; facts are never generated; the step is optional and counted against the DEC-028 quota.
- **Depends On:** TASK-074, TASK-093
- **Verification:** Done when `pnpm test:unit` and `pnpm test:e2e` including tests/task-109 pass against a mocked provider: the optional step fills only text fields of the chosen blueprint as `CONTOH` drafts; price, licence, review and address fields stay empty; skipping the step leaves the blueprint unchanged; quota exhaustion and provider failure fall back to the plain blueprint without blocking signup.
- **Visual Contract:** Onboarding AI step with skip option at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** AI image generation or automatic publishing.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-110: Monthly Owner Performance Report Email
- **Milestone:** M2
- **Requirement:** REQ-110
- **Constraints:** REQ-073, REQ-077
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/worker/cron/monthly-report.ts`, `apps/web/src/worker/queues/reports/**`, `packages/core/src/reports/**`, `packages/core/src/email/**`, `apps/web/src/pages/dashboard/[handle]/settings/notifications/**`, `tests/task-110/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-110; PLAN.md section 20.5.
- **Accepted Invariants:** One report per active website per month; no visitor personal data; owners can opt out; low-activity websites receive none; no blind retry.
- **Depends On:** TASK-030, TASK-072, TASK-077
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-110 pass: a fixture month produces one email per eligible website with visits, leads, WhatsApp clicks, top offering, AI-assistant referrals, change against the previous month and one tip; a website below the threshold or opted out receives none; the email holds no visitor data; a failed send is recorded and not replayed.
- **Visual Contract:** Monthly report email template checked at mobile width; notification settings toggle at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Weekly or daily digests, or reports to agencies about other agencies' clients.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.
