# Wave 5 — CMS Admin Screens, 6 Themes + Style Variants/Store, Plugin Runtime, Public Site, Forms, Branches, Marketing & Moderation (M1)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

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
