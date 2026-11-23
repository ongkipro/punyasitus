# PunyaSitus — Phase 1 Integration Checkpoint Checklist (M1 / TASK-063)

> **Release Boundary (`DEC-030`):** This Phase 1 Integration Checkpoint (`TASK-063`, `REQ-041`) validates the completed M1 build phase across Wave 0 through Wave 6 (**85 / 85 M1 tasks**). **It is explicitly NOT a production release.** Full production release requires Wave 7 (M2 vertical/channel/AI/MCP modules), Wave 8 (`TASK-078` ASVS L2 / OWASP ZAP / BOLA assurance + `TASK-038` Full Production Release Gate), and explicit owner authorization for live Cloudflare, provider, DNS, and legal gates.

- **Contract Authorities:** `PRD.md` (`REQ-040`, `REQ-041`, `REQ-042`), `PLAN.md` (§1, §8, §9), `DECISIONS.md` (`DEC-030`, `DEC-035`, `DEC-036`, `DEC-037`, `DEC-038`, `DEC-047`), `TASKS.md`
- **Related Runbooks:** [Staged Release & Rollback](./release.md) | [Backup & Restore](./backup-restore.md) | [Hosting & Topology](./hosting.md) | [Telemetry](./telemetry-release.md) | [Privacy](./privacy.md) | [SEO Launch](./seo-launch.md)

---

## 1. Exact M1 Scope vs. Explicit Non-Scope

### 1.1 In Scope — Phase 1 (M1: 85 Tasks, Wave 0–Wave 6)

| Wave | Focus | Count | Task IDs |
|---|---|---:|---|
| **Wave 0** | Monorepo & Cloudflare `workerd` Bootstrap | 1 | `TASK-023` |
| **Wave 1** | Core Schemas (`PLATFORM_DB` + `TenantStore`), OpenAPI, URL Helpers & `base-nova` Shell | 5 | `TASK-001`, `TASK-010`, `TASK-011`, `TASK-024`, `TASK-032` |
| **Wave 2** | Host Routing, Queues/Cron, Rate Limits, Privacy, Email, Better Auth + Google/2FA | 12 | `TASK-002`, `TASK-025`, `TASK-028`, `TASK-029`, `TASK-030`, `TASK-031`, `TASK-037`, `TASK-045`, `TASK-049`, `TASK-067`, `TASK-077`, `TASK-090` |
| **Wave 3** | Core CMS APIs, Cloudflare Images/Video Pipeline, Shared Theme Shell & SEO Foundations | 16 | `TASK-004`, `TASK-005`, `TASK-006`, `TASK-007`, `TASK-008`, `TASK-009`, `TASK-012`, `TASK-013`, `TASK-014`, `TASK-015`, `TASK-016`, `TASK-017`, `TASK-027`, `TASK-050`, `TASK-051`, `TASK-089` |
| **Wave 4** | Console Foundations, Custom Domains, AutoLaris Billing, Lifecycle, Receipts & Coupons | 11 | `TASK-003`, `TASK-026`, `TASK-048`, `TASK-055`, `TASK-056`, `TASK-057`, `TASK-058`, `TASK-059`, `TASK-081`, `TASK-082`, `TASK-095` |
| **Wave 5** | CMS Admin Screens, 6 Themes + Style Variants/Store, Plugin Runtime, Public Site, Forms, Branches, Marketing & Moderation | 39 | `TASK-018`, `TASK-021`, `TASK-022`, `TASK-033`, `TASK-034`, `TASK-036`, `TASK-039`, `TASK-040`, `TASK-041`, `TASK-042`, `TASK-043`, `TASK-044`, `TASK-046`, `TASK-047`, `TASK-052`, `TASK-053`, `TASK-054`, `TASK-060`, `TASK-061`, `TASK-065`, `TASK-068`, `TASK-069`, `TASK-070`, `TASK-076`, `TASK-080`, `TASK-087`, `TASK-088`, `TASK-091`, `TASK-092`, `TASK-093`, `TASK-094`, `TASK-096`, `TASK-097`, `TASK-102`, `TASK-103`, `TASK-104`, `TASK-106`, `TASK-107`, `TASK-108` |
| **Wave 6** | Phase 1 Integration Checkpoint (M1 Gate) | 1 | `TASK-063` |
| **Total M1** | **Phase 1 Core Platform** | **85** | **100% of M1** |

### 1.2 Explicitly Excluded Non-Scope (25 Tasks)

- **Wave 7 — M2 Phase 2 Modules (22 tasks):** `TASK-019`, `TASK-020`, `TASK-035`, `TASK-064`, `TASK-066`, `TASK-071`, `TASK-072`, `TASK-073`, `TASK-074`, `TASK-075`, `TASK-079`, `TASK-083`, `TASK-084`, `TASK-085`, `TASK-086`, `TASK-098`, `TASK-099`, `TASK-100`, `TASK-101`, `TASK-105`, `TASK-109`, `TASK-110`.
- **Wave 8 — M2 Security & Production Release Gates (2 tasks):** `TASK-078` (OWASP ASVS L2, ZAP, full BOLA suite) and `TASK-038` (Full Production Release Gate: Firefox/WebKit matrix, 5-run mobile performance lab, and isolated backup/restore + tombstone replay rehearsal).
- **Deferred Release 1.1 (1 task):** `TASK-062` (Owner Redirect Manager & 404 Monitor, deferred per `DEC-035 C16`).

---

## 2. Executed Local & CI Verification Matrix (M1)

All automated M1 gates run from a clean frozen-lockfile checkout with **zero production credentials**, **zero live Cloudflare deploys**, and **zero remote database writes** (`.github/workflows/ci.yml`):

| Gate | Command | Scope & Enforced Invariants |
|---|---|---|
| **Specification Integrity** | `pnpm run spec:check` | `scripts/check-spec.py` + `scripts/test-check-spec.py` verify DAG acyclicity, task contracts, and boundary parity |
| **Lint & Guardrails** | `pnpm lint` | ESLint across `apps/web/src`, `packages`, `tests` + zero `@radix-ui/*` / `asChild` enforcement (`DEC-036`) |
| **Typecheck** | `pnpm typecheck` | Workspace `tsc --noEmit` + Astro `astro sync && astro check && tsc --noEmit` |
| **Unit Test Suite** | `pnpm test:unit` | All **85 unit test files (806 tests)** (`tests/task-*/unit.test.ts`), including `tests/task-063/unit.test.ts` |
| **Workerd Integration Suite** | `pnpm test:integration` | Local Cloudflare `workerd` (`PLATFORM_DB` D1 + isolated `TenantStore` SQLite DOs + R2 + Queues) across all **73 integration test files (375 tests)** including `tests/task-063/workerd.integration.test.ts` |
| **Build & Wrangler Dry-Run** | `pnpm build` | Astro `@astrojs/cloudflare` SSR production build + Wrangler dry-run bundle (`< 64 MiB`; measured `14.07 MiB`) + real `workerd` cold startup (`< 1000 ms`; measured `77 ms`) |
| **M1 Static & Contract Gate** | `node scripts/verify/m1-gate.mjs` | Static/on-disk verification (does not itself execute vitest suites): checks 85-task M1 scope and on-disk test coverage, all SQL migrations (`platform` `<= 0027`, `tenant` `<= 0021`, zero destructive drops), `wrangler.jsonc` (`workers_dev: false`, `preview_urls: false`, zero leaked secrets), 100% 40-char SHA-pinned CI workflows (`permissions: {}`, `contents: read`, `persist-credentials: false`, zero `${{ secrets.* }}`), and zero `@radix-ui`/`asChild`/`Sparkles` |
| **M1 Performance & Asset Budget** | `node tests/performance/m1-budget.mjs` | Real built Astro SSR Worker (`dist/server/wrangler.json`) + Playwright Chromium mobile profile (`4x CPU`, `1.6 Mbps / 750 Kbps / 150ms RTT`) on homepage, blog article, and catalog/offering detail: first-party public JS `<= 25 KiB` gzip/route, initial transferred assets `<= 500 KiB`, cold/warm & non-consenting/consenting measurements (`INP` explicitly noted as field data, never fabricated; cold mobile CLS `0.1118` breach on `.ps-floating-dock` surfaced honestly as `M1-FU-08`) |
| **M1 Cross-Cutting Browser Gate** | `node tests/e2e-gate/m1-checkpoint.mjs` | Real built Astro SSR Worker + Playwright Chromium at **`360px`, `768px`, and `1440px`**, true `200%` zoom reflow (`720px` @ DPR 2 + `320px` WCAG 1.4.10 reflow + `200%` root font scaling), multi-control keyboard navigation & exact-trigger focus restoration, `aria-live` announcements, No-JS public browsing + **API-level No-JS `application/x-www-form-urlencoded` `303` PRG submission test** (`POST /api/leads`; `SectionContactForm` homepage mounting tracked in `M1-FU-02`), strict `404` cross-tenant A-to-B read/write denial, warm-cache suspension `503` `no-store` `noindex`, XSS sanitization, unsafe URL rejection (`422`), SVG upload-intent rejection (`415`) & `inspectImageBinary` magic-byte MIME spoofing rejection (`415` — **live binary upload through Worker is NOT verified in M1; blocked by `M1-FU-07`**), stale revision `409`, CSRF/Origin mismatch `403`, and consent withdrawal with zero pre-consent third-party requests (note: `<AnalyticsHead />` mounting is tracked under `M1-FU-02`, so post-consent analytics script gating must be re-verified once `M1-FU-02` lands) |
| **M1 Checkpoint Orchestrator** | `node tests/task-063/e2e.mjs` | Executes and validates all three M1 gate scripts end-to-end and verifies visual screenshot evidence in `/tmp/task-063-screenshots/` |

---

## 3. M1 Integration Follow-Up / Pre-Production Hardening Register

To preserve strict per-task path boundaries and keep `tests/task-001` baseline checksums stable across Wave 0–Wave 5, the following cross-task integration polish items are transparently tracked for consolidation prior to live staging / Wave 8 (`TASK-078` / `TASK-038`):

| ID | Area | Follow-Up Item | Target Stage |
|---|---|---|---|
| **M1-FU-01** | Database Migrations | Consolidate active M1 migration descriptors (`platform` `0001..0027`, `tenant` `0001..0021`) into central `PLATFORM_MIGRATIONS` and `TENANT_MIGRATIONS` arrays and refresh `tests/task-001` checksum assertions in one audited PR. | Pre-staging / Wave 7–8 |
| **M1-FU-02** | Public Analytics & Contact/Custom Forms Mounting | Mount `<AnalyticsHead />` inside the shared public theme `<Layout>` head slot (consent-gated) and wire `SectionContactForm` + `SectionCustomForm` into `SectionRenderer.astro` for direct page-section contact/custom form rendering. | Pre-staging / Wave 7–8 |
| **M1-FU-03** | Shared-Domain Content Screening | Wire `TASK-103` publish-screening hooks consistently into every dashboard publish route (`pages`, `posts`, `catalog`, `identity`) in addition to the standalone screening service and console moderation queue. | Pre-staging / Wave 8 (`TASK-078`) |
| **M1-FU-04** | Custom Theme Head Parity | Align `apps/web/src/themes/custom/sample-agency/Layout.astro` with `managedHead={true}` parity when `<PublicSeoHead />` is slotted so custom themes share identical single-emitter head guarantees. | Pre-staging / Wave 7–8 |
| **M1-FU-05** | Sitemap Resilience & Taxonomy Archives | Add fail-closed `TenantStore` DB error handling (`503 no-store`) and opted-in taxonomy archive URLs directly into `apps/web/src/pages/sitemaps/_shared.ts` (matching `robots.txt.ts` and `sitemap.xml.ts`). | Pre-staging / Wave 7–8 |
| **M1-FU-06** | OpenAPI Contract Sync | Regenerate and audit `docs/api/openapi.json` across all Wave 3–Wave 5 endpoints so the full HTTP contract document stays synchronized with every shipped route handler. | Pre-staging / Wave 8 (`TASK-078`) |
| **M1-FU-07** | Streaming Media Upload Middleware CSRF | **Live binary media upload through the Worker (`PUT /api/tenants/:tenantId/media/upload/:intentId`) is NOT verified in M1** (unit-level `inspectImageBinary` magic-byte spoofing rejection is verified, and `upload-intent` rejects SVG with `415`). Exempt `/api/tenants/:tenantId/media/upload/:intentId` from the global `Content-Type: application/json` check in `apps/web/src/middleware/auth.ts:361-377` (retaining strict exact-`Origin` verification) so live binary image/video streams reach `media/upload/[intentId].ts` (`csrfMode: "origin_only"`). Discovered by real built-Worker `m1-checkpoint.mjs`. | Pre-staging / Wave 7–8 |
| **M1-FU-08** | Mobile Cold-Load Floating Dock CLS | Reserve stable geometry on `.ps-floating-dock` / `FloatingWhatsApp.astro` (`apps/web/src/styles/site/base.css:573`) so cold mobile load eliminates the `0.1118` layout shift (`> 0.10` target) before the 5-run `TASK-038` performance lab. Discovered by real built-Worker `m1-budget.mjs`. | Pre-staging / `TASK-038` |

---

## 4. External Provider, Legal & Launch Gates (`UNVERIFIED`)

Every external dependency below **cannot** be proven by reading documentation or running local mocks. Each remains explicitly **`UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION`** until executed with owner approval against live accounts and counsel:

| Gate ID | Category | Gate Description | Status | Proven By / Target |
|---|---|---|---|---|
| **EXT-01** | Cloudflare Infra | Cloudflare Workers Paid account with isolated `punyasitus-*` D1, R2, Queues, Images, and AI bindings | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live staging provisioning (`PLAN §1`, `TASK-045`) |
| **EXT-02** | Cloudflare SaaS / DCV / O2O | Separate staging SaaS zone + fallback origin, live HTTP DCV pass-through (`return fetch(request)`), and O2O with a real second Cloudflare customer zone | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live staging test domain (`TASK-045`, `TASK-003`, `TASK-039`) |
| **EXT-03** | Trust+ / Komdigi | Trust+ / Komdigi static-IP reputation check against staging and production SaaS zones | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live zone DNS/IP check (`TASK-103`, `PLAN §1`) |
| **EXT-04** | Identity | Google OAuth live client credentials, consent screen verification, and production/staging redirect URIs | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live OAuth callback test (`TASK-090`) |
| **EXT-05** | Transactional Email | Cloudflare Email Sending (Beta) DNS onboarding (`notif.punyasitus.com`) and live inbox placement (SPF/DKIM/DMARC across Gmail, Outlook, Indonesian ISP) | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live staging send (`TASK-077`, `STATUS.md`) |
| **EXT-06** | Payments (AutoLaris) | AutoLaris merchant approval, static-IP relay host, live VA/QRIS checkout instruction, and live Advice webhook reconciliation | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live merchant sandbox/staging (`TASK-055`, `TASK-056`) |
| **EXT-07** | Legal — UU PDP | Indonesian legal counsel review of Bahasa Indonesia Terms of Service and Privacy Policy (`UU 27/2022` UU PDP) | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Counsel sign-off (`DEC-047`, before `TASK-038`) |
| **EXT-08** | Regulatory — PSE / Tax / Komdigi | PSE Lingkup Privat registration, `UU KUP Art. 28(11)` invoice/tax retention alignment, and `Kepmen Komdigi 127/128` compliance text | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Legal/regulatory filing (`DEC-047`, before `TASK-038`) |
| **EXT-09** | Webmaster / SEO | Manual Google Search Console & Bing Webmaster property verification on live domain(s) | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live launch verification (`TASK-054`, `seo-launch.md`) |
| **EXT-10** | Full Release Gate | Full multi-browser matrix (Chromium + Firefox + WebKit), 5-run mobile performance lab, OWASP ASVS L2 / ZAP full scan, and isolated backup restore + tombstone replay rehearsal | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Wave 8 (`TASK-078` + `TASK-038`) |

---

## 5. Sign-Off Rules

1. **M1 Checkpoint (`TASK-063`)** proves local/CI integration across all 85 Phase 1 tasks only. It does **not** authorize `wrangler deploy`, remote D1 migrations, DNS mutations, or public launch.
2. Any failing acceptance case, upstream contract drift, or stale evidence reopens `TASK-063`.
3. `INP` is field data (28-day CrUX/RUM p75) and is never claimed from synthetic Chromium runs.
