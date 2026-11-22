# Wave 7 — Vertical Modules, Agency Portal, Affiliates, Plugin Store (`private_client`/`free`/`paid`), Seed Plugins, AI & MCP (M2)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

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
- **Canonical Contract Owners:** PRD.md REQ-075; PLAN.md section 18.4; DECISIONS.md DEC-026, DEC-028 and DEC-046 (Workers AI).
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
