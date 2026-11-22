# Tasks: PunyaSitus Implementation

> Layout (DEC-048): this file is the queue and stays under 50 KB. Each `### TASK-` record repeats the task's requirement and dependencies; the full contract (paths, invariants, verification) is in the linked `docs/tasks/` file. Read the record here, then its contract before starting.

> Revision: 2026-11-22 (split into index + `docs/tasks/`, DEC-048; Merged PunyaSitus + CMSPRO under DEC-035; 100% Cloudflare D1 + `TenantStore` DO + Containers + `base-nova` UI under ADR-0009 & DEC-036). All tasks are pending; this is a planning queue, not a completion report.
> Preserves TASK-001 through TASK-022; missing foundations append from TASK-023.
> Read AGENTS.md, PRD.md, PLAN.md and DESIGN.md before execution. Numeric order is not dependency order.

## Execution contract

- Specifications are promoted into this repository (2026-09-26). Work only after explicit development authorization. No implicit commit, push, deployment, DNS mutation or paid provisioning.
- Resolve PLAN section 1 gates for the affected task. New architecture proposals are not accepted human decisions.
- Shared requirements: REQ-001 applies to every tenant-owned surface; REQ-034 to admin operations; REQ-039 to personal data; REQ-040 to browser-visible work.
- Every task allows its own tests at tests/task-NNN/**, plus evidence-only updates to the repository STATUS.md, BUILD-LOG.md and existing .delivery/ contract. Every task that adds or changes an HTTP contract may also edit its own schema files under `packages/core/src/schemas/**` and the generated `docs/api/**`, and must leave the TASK-024 drift check green. Admin navigation links for a task's own screens may be added in `apps/web/src/components/admin/nav/**`. Feature source paths are listed below. Follow repository boundary tooling when present.
- A path listed in both Allowed and Protected Paths is in scope but always requires independent review at protected risk R3 (typically `packages/db/migrations/**`, `packages/auth/**`, `.github/workflows/**`).
- Every task has one primary requirement. Constraints do not replace the primary outcome.
- Verification commands in `docs/tasks/` are future script contracts created by TASK-023. Run a targeted test folder as well as relevant integration/build checks; never report a command as passed before the project exists.
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

Task records below preserve stable IDs (`TASK-001`..`TASK-110`). Execute development strictly along these DAG waves (109 v1 tasks + 1 Release 1.1 deferred task):

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

## In progress

None.

## Pending

**Wave 0 — Monorepo & Cloudflare `workerd` Bootstrap**

### TASK-023: Workspace Bootstrap & Runtime Compatibility Spike
- **Requirement:** REQ-041 · R3 · M1 · contract [`wave-0`](docs/tasks/wave-0.md)
- **Depends On:** None

**Wave 1 — Core Schemas (`PLATFORM_DB` + `TenantStore`), OpenAPI, URL Helpers & `base-nova` UI Shell**

### TASK-001: Multi-Tenant Database Schema & Drizzle Migrations
- **Requirement:** REQ-001 · R3 · M1 · contract [`wave-1`](docs/tasks/wave-1.md)
- **Depends On:** TASK-023
### TASK-010: WhatsApp Dynamic CTA URL Generator & E.164 Validation
- **Requirement:** REQ-014 · R1 · M1 · contract [`wave-1`](docs/tasks/wave-1.md)
- **Depends On:** TASK-023
### TASK-011: External Link-Out Validation
- **Requirement:** REQ-015 · R1 · M1 · contract [`wave-1`](docs/tasks/wave-1.md)
- **Depends On:** TASK-023
### TASK-024: HTTP Schemas and Authorization Contract
- **Requirement:** REQ-034 · R3 · M1 · contract [`wave-1`](docs/tasks/wave-1.md)
- **Depends On:** TASK-023
### TASK-032: UX Direction and Accessible Admin Foundation
- **Requirement:** REQ-037 · R2 · M1 · contract [`wave-1`](docs/tasks/wave-1.md)
- **Depends On:** TASK-023

**Wave 2 — Host Routing, Queues/Cron, Rate Limits, Privacy, Email & Better Auth + Google/2FA**

### TASK-002: Host-Based Tenant Resolution & Tenant Context Middleware
- **Requirement:** REQ-002 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-001, TASK-024
### TASK-025: Better Auth Organization Sessions & RBAC
- **Requirement:** REQ-034 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-001, TASK-024, TASK-032, TASK-077
### TASK-028: Durable Jobs on Cloudflare Queues and Safe Retry Infrastructure
- **Requirement:** REQ-042 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-001
### TASK-029: Anonymous Request Limits and Idempotency
- **Requirement:** REQ-038 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-001, TASK-002, TASK-024
### TASK-030: First-Party Click Counters and Admin Metrics
- **Requirement:** REQ-017 · R2 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-002, TASK-024, TASK-029, TASK-031, TASK-032
### TASK-031: Consent, Retention and Privacy Controls
- **Requirement:** REQ-039 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-001, TASK-028, TASK-032
### TASK-037: Telemetry, Backups and Release Procedures
- **Requirement:** REQ-042 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-028, TASK-031
### TASK-045: Cloudflare for SaaS Fallback-Origin Worker Topology and Route Contract
- **Requirement:** REQ-041 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-023, TASK-002, TASK-025, TASK-028
### TASK-049: Platform Grant, Bootstrap and Audit Foundation
- **Requirement:** REQ-051 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-025, TASK-028
### TASK-067: Mandatory Two-Factor Authentication for Platform Operators
- **Requirement:** REQ-068 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-025, TASK-049
### TASK-077: Transactional Email Adapter (`env.EMAIL.send()` Cloudflare Email Service Primary + Resend Fallback)
- **Requirement:** REQ-077 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-023, TASK-028
### TASK-090: Primary Google Sign-In (`Masuk dengan Google`) & Cloudflare Turnstile Guards
- **Requirement:** REQ-090 · R3 · M1 · contract [`wave-2`](docs/tasks/wave-2.md)
- **Depends On:** TASK-024, TASK-025, TASK-049, TASK-067

**Wave 3 — Core CMS APIs, Cloudflare Images/Video Pipeline, Shared Theme Shell & SEO Foundations**

### TASK-004: Hierarchical Navigation Menu Builder API & Data Tree
- **Requirement:** REQ-006 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-001, TASK-024, TASK-025
### TASK-005: Static Pages Manager API with SEO Overrides
- **Requirement:** REQ-008 · R3 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-027
### TASK-006: Blog Articles Manager API with Rich Text & Categories
- **Requirement:** REQ-009 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-005
### TASK-007: Media Library Upload Pipeline & Automated WebP Conversion
- **Requirement:** REQ-010 · R3 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-028
### TASK-008: Site Identity & Brand Configuration API
- **Requirement:** REQ-011 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-027
### TASK-009: Typed Offerings (`service`, `product`, `tour`, `vehicle`) & Categories Management API
- **Requirement:** REQ-012 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-027, TASK-010, TASK-011
### TASK-012: Shared Theme Base Shell (`themes/default`) & Dynamic Token Injection
- **Requirement:** REQ-018 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-002, TASK-027, TASK-032
### TASK-013: Modular Section Registry & Dynamic Page Assembly
- **Requirement:** REQ-019 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-012, TASK-005, TASK-006, TASK-007, TASK-009
### TASK-014: Floating WhatsApp Widget
- **Requirement:** REQ-014 · R1 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-010, TASK-012
### TASK-015: Schema.org Structured Data Generator
- **Requirement:** REQ-022 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-051
### TASK-016: Open Graph & Social Share Metadata
- **Requirement:** REQ-023 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-005, TASK-007, TASK-012, TASK-051
### TASK-017: Tenant-Scoped Sitemap and Robots Endpoints
- **Requirement:** REQ-024 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-002, TASK-051
### TASK-027: Draft/Publish Snapshots and Revisioned Cache
- **Requirement:** REQ-036 · R3 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-001, TASK-024, TASK-025
### TASK-050: In-Process Draft Preview and Admin Preview Shell
- **Requirement:** REQ-036 · R3 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-012, TASK-025, TASK-027, TASK-032
### TASK-051: Shared Published SEO Policy
- **Requirement:** REQ-052 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-002, TASK-024, TASK-027
### TASK-089: Privacy-Preserving Click-to-Load YouTube Embeds
- **Requirement:** REQ-089 · R2 · M1 · contract [`wave-3`](docs/tasks/wave-3.md)
- **Depends On:** TASK-006, TASK-007, TASK-009, TASK-013

**Wave 4 — Console Foundations, Custom Domains, AutoLaris Billing, Lifecycle, Receipts & Coupons**

### TASK-003: Custom Domain Verification & Cloudflare for SaaS Integration
- **Requirement:** REQ-004 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-002, TASK-025, TASK-026, TASK-028
### TASK-026: Operator Provisioning, Invitations & Service State
- **Requirement:** REQ-035 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-025, TASK-002, TASK-032, TASK-049, TASK-067
### TASK-048: Platform Operators, Audit and Health Views
- **Requirement:** REQ-051 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-025, TASK-028, TASK-032, TASK-037, TASK-049, TASK-067
### TASK-055: Subscription Obligations and AutoLaris Instruction Creation
- **Requirement:** REQ-056 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-001, TASK-024, TASK-025, TASK-028, TASK-049
### TASK-056: Advice Reconciliation and Exactly-Once Entitlement Grants
- **Requirement:** REQ-057 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-055, TASK-059
### TASK-057: Owner Payment Recovery and Scoped Operator Billing Views
- **Requirement:** REQ-058 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-032, TASK-048, TASK-055, TASK-056, TASK-059
### TASK-058: Verified Signup and Unique Trial Website Provisioning
- **Requirement:** REQ-059 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-025, TASK-026, TASK-032, TASK-059
### TASK-059: Timed Entitlement Gate, Lockout and Maintenance States
- **Requirement:** REQ-060 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-002, TASK-025, TASK-028, TASK-032, TASK-055, TASK-077
### TASK-081: Numbered PDF Payment Receipts, Email Delivery & Credit Adjustments
- **Requirement:** REQ-081 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-055, TASK-056, TASK-057, TASK-077
### TASK-082: Yearly Subscription Plans & Promotional Coupon Engine
- **Requirement:** REQ-082 · R3 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-048, TASK-055, TASK-057, TASK-067
### TASK-095: AI & Search Visibility Engine (`robots.txt` Bot Split, `IndexNow` & `AI Assistant` Attribution)
- **Requirement:** REQ-095 · R2 · M1 · contract [`wave-4`](docs/tasks/wave-4.md)
- **Depends On:** TASK-003, TASK-016, TASK-028, TASK-051, TASK-059

**Wave 5 — CMS Admin Screens, 6 Themes + Style Variants/Store, Plugin Runtime, Public Site, Forms, Branches, Marketing & Moderation**

### TASK-018: Custom Theme Registry & Agency Routing
- **Requirement:** REQ-021 · R3 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-012, TASK-015, TASK-016, TASK-017
### TASK-021: Native Lead Capture API & Inbox
- **Requirement:** REQ-031 · R3 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-013, TASK-024, TASK-025, TASK-029, TASK-031, TASK-077
### TASK-022: Consent-Aware Analytics Signal Dispatcher
- **Requirement:** REQ-027 · R2 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-010, TASK-021, TASK-030, TASK-031
### TASK-033: CMS Admin Screens and Media Workflows
- **Requirement:** REQ-037 · R2 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-032, TASK-004, TASK-005, TASK-006, TASK-007, TASK-008, TASK-009
### TASK-034: Theme Customizer Screens
- **Requirement:** REQ-037 · R2 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-032, TASK-013, TASK-027, TASK-050
### TASK-036: Public Routes, Listing and Content Detail Journeys
- **Requirement:** REQ-018 · R2 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-013, TASK-015, TASK-016, TASK-017
### TASK-039: Custom Domain Connect, Primary Switch and Safe Removal
- **Requirement:** REQ-043 · R3 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-048, TASK-003, TASK-034
### TASK-040: Grouped Admin Settings and Public Defaults
- **Requirement:** REQ-044 · R3 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-008, TASK-024, TASK-025, TASK-027, TASK-032, TASK-034
### TASK-041: Blog Categories, Tags and Catalog Taxonomy Screens
- **Requirement:** REQ-045 · R3 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-006, TASK-009, TASK-024, TASK-032, TASK-033, TASK-036
### TASK-042: Theme Library, Compatibility Preview and Activation
- **Requirement:** REQ-046 · R3 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-018, TASK-024, TASK-025, TASK-032, TASK-034
### TASK-043: Company-Profile Starter Preset (M1)
- **Requirement:** REQ-047 · R3 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-013, TASK-025, TASK-032, TASK-040, TASK-042
### TASK-044: Content Trash and Recovery (M1)
- **Requirement:** REQ-048 · R3 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-024, TASK-027, TASK-028, TASK-033
### TASK-046: Superadmin Tenant Directory and Scoped Operations
- **Requirement:** REQ-049 · R3 · M1 · contract [`wave-5a`](docs/tasks/wave-5a.md)
- **Depends On:** TASK-026, TASK-032, TASK-042, TASK-048, TASK-067
### TASK-047: Superadmin Domain and Job Recovery Queues
- **Requirement:** REQ-050 · R2 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-003, TASK-028, TASK-032, TASK-039, TASK-046, TASK-067
### TASK-052: SEO Editor Controls and Verification Settings
- **Requirement:** REQ-053 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-033, TASK-040, TASK-041, TASK-051
### TASK-053: Local Entity Schema and Crawlable Content Integration
- **Requirement:** REQ-054 · R2 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-015, TASK-036, TASK-041, TASK-051, TASK-052
### TASK-054: SEO Crawl Regression and Webmaster Launch Runbook
- **Requirement:** REQ-055 · R2 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-017, TASK-039, TASK-051, TASK-052, TASK-053
### TASK-060: Short Video Upload, Validation and Delivery
- **Requirement:** REQ-062 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-007, TASK-013, TASK-059
### TASK-061: Custom Theme Service Page, Packages and Requests
- **Requirement:** REQ-063 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-024, TASK-032, TASK-042, TASK-048, TASK-049
### TASK-065: Analytics Hardening: Event Dedup (M1)
- **Requirement:** REQ-027 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-022, TASK-030, TASK-076
### TASK-068: Locked-Tenant Retention, Leads Export and Offboarding
- **Requirement:** REQ-069 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-021, TASK-028, TASK-031, TASK-039, TASK-059
### TASK-069: Terima Beres Setup Service Packages and Requests
- **Requirement:** REQ-070 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-061, TASK-026
### TASK-070: Domain and Business Email Guide
- **Requirement:** REQ-071 · R1 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-039
### TASK-076: Easy Google Tag Manager Setup
- **Requirement:** REQ-027 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-022, TASK-031, TASK-046, TASK-049, TASK-067
### TASK-080: Tenant-Defined Custom Forms, Vertical Templates & WhatsApp After-Submit
- **Requirement:** REQ-080 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-008, TASK-013, TASK-024, TASK-025, TASK-032, TASK-090, TASK-091
### TASK-087: Platform Marketing Surface (`punyasitus.com`), Demo Tenants & Funnel Analytics
- **Requirement:** REQ-087 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-002, TASK-013, TASK-048, TASK-058
### TASK-088: Multi-Branch Locations (`branches`) & Unified Schema.org `@graph`
- **Requirement:** REQ-088 · R3 · M1 · contract [`wave-5b`](docs/tasks/wave-5b.md)
- **Depends On:** TASK-001, TASK-013, TASK-015, TASK-024, TASK-025, TASK-032, TASK-091
### TASK-091: Structured Business Profile, Schema.org Subtype Mapping & Auto-Derived Brand Assets
- **Requirement:** REQ-091 · R3 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-007, TASK-015, TASK-041
### TASK-092: Blog Author Profiles, `content_modified_at` Discipline & Server-Rendered TOC
- **Requirement:** REQ-092 · R3 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-006, TASK-015, TASK-033, TASK-036, TASK-040
### TASK-093: Six-Theme Platform Catalog (`compro`..`dealer`) & Guided Onboarding Checklist
- **Requirement:** REQ-093 · R2 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-012, TASK-013, TASK-042, TASK-043, TASK-080, TASK-091
### TASK-094: Public Abuse Reporting, Console Moderation Queue & Tenant Single-Lead Deletion / Activity Log
- **Requirement:** REQ-094 · R3 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-008, TASK-025, TASK-046, TASK-067, TASK-077, TASK-090
### TASK-096: Theme Style Variants & Commercial Theme Store (`included`, `paid_once`, `custom`)
- **Requirement:** REQ-096 · R3 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-042, TASK-057, TASK-081, TASK-082, TASK-093
### TASK-097: Frozen-Core Modular Plugin Runtime, `plg_*` `TenantStore` Isolation & Slot Dispatcher
- **Requirement:** REQ-097 · R3 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-001, TASK-013, TASK-025, TASK-028, TASK-059
### TASK-102: Official Free Zero-Config Plugin `seo-ai-autopilot` (One-Click Autopilot SEO, Sitemap/Robots & AI Indexing)
- **Requirement:** REQ-102 · R2 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-015, TASK-016, TASK-017, TASK-052, TASK-053, TASK-093, TASK-095, TASK-097
### TASK-103: Shared-Domain Protection: Publish Screening, Trust+ Watch, Takedown and Fallback Zone
- **Requirement:** REQ-103 · R3 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-005, TASK-006, TASK-009, TASK-028, TASK-046, TASK-094
### TASK-104: Indonesian Help Center at `punyasitus.com/bantuan` with In-Dashboard Help Links
- **Requirement:** REQ-104 · R2 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-032, TASK-087
### TASK-106: Platform Status Page, Incident Banner and Staged Releases
- **Requirement:** REQ-106 · R3 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-023, TASK-037, TASK-048
### TASK-107: Owner Full-Website Export Archive and Self-Service Deletion with Undo
- **Requirement:** REQ-107 · R3 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-007, TASK-021, TASK-025, TASK-028, TASK-067, TASK-068
### TASK-108: Free QR Codes for Website, Pages and Offerings
- **Requirement:** REQ-108 · R1 · M1 · contract [`wave-5c`](docs/tasks/wave-5c.md)
- **Depends On:** TASK-009, TASK-030, TASK-036

**Wave 6 — Phase 1 Integration Checkpoint (53 direct M1 leaf dependencies)**

### TASK-063: Phase 1 Integration Checkpoint (M1)
- **Requirement:** REQ-041 · R3 · M1 · contract [`wave-6`](docs/tasks/wave-6.md)
- **Depends On:** TASK-014, TASK-018, TASK-022, TASK-026, TASK-033, TASK-034, TASK-036, TASK-037, TASK-039, TASK-040, TASK-041, TASK-042, TASK-043, TASK-044, TASK-045, TASK-046, TASK-047, TASK-048, TASK-049, TASK-050, TASK-051, TASK-052, TASK-053, TASK-054, TASK-055, TASK-056, TASK-057, TASK-058, TASK-059, TASK-060, TASK-061, TASK-065, TASK-067, TASK-068, TASK-069, TASK-070, TASK-076, TASK-077, TASK-080, TASK-081, TASK-082, TASK-087, TASK-088, TASK-089, TASK-090, TASK-091, TASK-092, TASK-093, TASK-094, TASK-095, TASK-096, TASK-097, TASK-102, TASK-103, TASK-104, TASK-106, TASK-107, TASK-108

**Wave 7 — Vertical Modules, Agency Portal, Affiliates, Plugin Store (`private_client`/`free`/`paid`), Seed Plugins, AI & MCP**

### TASK-019: Offline Gerai Multi-Outlet Directory & Maps
- **Requirement:** REQ-029 · R2 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-025, TASK-013, TASK-031, TASK-015, TASK-036
### TASK-020: Travel & Umrah Itinerary & Departure Module (Umrah gated by `SK PPIU` check, DEC-042)
- **Requirement:** REQ-028 · R2 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-009, TASK-013, TASK-015, TASK-036
### TASK-035: Professional Services Pricing & Consultation Module
- **Requirement:** REQ-030 · R2 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-009, TASK-013, TASK-033, TASK-015, TASK-036
### TASK-064: Content Revision History (M2)
- **Requirement:** REQ-048 · R3 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-044, TASK-033
### TASK-066: Additional Vertical Starter Presets (M2)
- **Requirement:** REQ-047 · R2 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-043, TASK-019, TASK-020, TASK-035
### TASK-071: Preferred Schedule Fields for Inquiries
- **Requirement:** REQ-072 · R3 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-010, TASK-021, TASK-019
### TASK-072: First-Party Insights: Popular Items, Sources and Peak Hours
- **Requirement:** REQ-073 · R3 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-030, TASK-065
### TASK-073: Google Maps Review Link and Business Profile Checklist
- **Requirement:** REQ-074 · R3 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-040, TASK-043
### TASK-074: AI Writing Suggestions in the Editor
- **Requirement:** REQ-075 · R3 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-033, TASK-052
### TASK-075: Tenant MCP Server for AI Agents
- **Requirement:** REQ-076 · R3 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-025, TASK-033, TASK-049, TASK-059, TASK-067
### TASK-079: Vehicle Showroom Offering (`/kendaraan`) & Static Credit-Estimate Table
- **Requirement:** REQ-079 · R2 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-009, TASK-013, TASK-015, TASK-033, TASK-036
### TASK-083: Agency / Reseller Portal, Client Provisioning & Agency-Payer Billing
- **Requirement:** REQ-083 · R3 · M2 · contract [`wave-7a`](docs/tasks/wave-7a.md)
- **Depends On:** TASK-026, TASK-046, TASK-057, TASK-067, TASK-081, TASK-082, TASK-090
### TASK-084: Affiliate Enrollment, First-Party Referral Attribution & Anti-Abuse Locks
- **Requirement:** REQ-084 · R3 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-058, TASK-083, TASK-087, TASK-090
### TASK-085: Affiliate Commission Ledger (`60%`/`20%`), 14-Day Hold & Bi-Monthly Payout Batches
- **Requirement:** REQ-085 · R3 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-056, TASK-081, TASK-082, TASK-084
### TASK-086: Affiliate Self-Service Portal & Console Payout Management
- **Requirement:** REQ-086 · R3 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-032, TASK-048, TASK-067, TASK-084, TASK-085
### TASK-098: Plugin Store, Bespoke Client Grants (`private_client`) & AutoLaris Add-on Billing
- **Requirement:** REQ-098 · R3 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-048, TASK-061, TASK-067, TASK-075, TASK-081, TASK-082, TASK-083, TASK-085, TASK-097
### TASK-099: Official Launch Seed Plugins (`bio-links` Free & `wa-cs-rotator` Commercial/Grantable)
- **Requirement:** REQ-099 · R2 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-014, TASK-030, TASK-097, TASK-098
### TASK-100: Official Free Plugin `wp-importer` (WordPress `/wp-json` & WXR Safe Draft Importer)
- **Requirement:** REQ-100 · R2 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-006, TASK-007, TASK-097, TASK-098
### TASK-101: Official Plugin `lead-notifier` (1-Click Telegram Bot Linking & Signed CRM/Sheets Webhook)
- **Requirement:** REQ-101 · R2 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-021, TASK-028, TASK-097, TASK-098
### TASK-105: WhatsApp Support Entry Point with Context and Published Hours
- **Requirement:** REQ-105 · R2 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-032, TASK-048, TASK-083
### TASK-109: Optional AI Draft Step in Onboarding
- **Requirement:** REQ-109 · R2 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-074, TASK-093
### TASK-110: Monthly Owner Performance Report Email
- **Requirement:** REQ-110 · R2 · M2 · contract [`wave-7b`](docs/tasks/wave-7b.md)
- **Depends On:** TASK-030, TASK-072, TASK-077

**Wave 8 — Pre-Launch Security Assurance (`ASVS L2` + `ZAP` + BOLA) & Full Production Release Gate**

### TASK-038: Full Production Release Gate (M1 + M2)
- **Requirement:** REQ-041 · R3 · M2 · contract [`wave-8`](docs/tasks/wave-8.md)
- **Depends On:** TASK-063, TASK-019, TASK-020, TASK-035, TASK-064, TASK-065, TASK-066, TASK-071, TASK-072, TASK-073, TASK-074, TASK-075, TASK-078, TASK-079, TASK-083, TASK-084, TASK-085, TASK-086, TASK-098, TASK-099, TASK-100, TASK-101, TASK-105, TASK-109, TASK-110
### TASK-078: Pre-Launch Security Assurance (ASVS L2, ZAP, Cross-Tenant)
- **Requirement:** REQ-078 · R3 · M2 · contract [`wave-8`](docs/tasks/wave-8.md)
- **Depends On:** TASK-063, TASK-067, TASK-075, TASK-076, TASK-077, TASK-079, TASK-083, TASK-084, TASK-085, TASK-086, TASK-098, TASK-099, TASK-100, TASK-101, TASK-102, TASK-103, TASK-107, TASK-109

**Deferred to release 1.1**

### TASK-062: SEO Redirects and 404 Monitor
- **Requirement:** REQ-067 · R3 · Release 1.1 (deferred per DEC-035 C16; excluded from TASK-063 and TASK-038) · contract [`release-1.1`](docs/tasks/release-1.1.md)
- **Depends On:** TASK-024, TASK-027, TASK-032, TASK-036, TASK-051

## Done

None yet. A finished task leaves `## Pending`, its contract moves to `docs/archive/TASKS-<date>.md`, and one line is added here.
