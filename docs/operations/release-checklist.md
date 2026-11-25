# PunyaSitus — Full Production Release Gate Checklist (M1 + M2 / TASK-063 + TASK-078 + TASK-038)

> **Release Boundary (`DEC-030`):**
> - **Phase 1 Checkpoint (`TASK-063`):** Validated Wave 0–Wave 6 (**85 / 85 M1 tasks**) and was explicitly **NOT a production release**.
> - **Full M1 + M2 Production Release Gate (`TASK-038` + `TASK-078`, `REQ-041`):** Validates the complete **109 / 110 roadmap scope** (`85` M1 + `22` Wave 7 M2 + `2` Wave 8 security & release gates; `TASK-062` explicitly deferred to Release 1.1 per `DEC-035 C16`) with `RELEASE.md` (`punyasitus-v1.0.0-rc1`, `Status: READY`), executed isolated backup/restore + `DEC-022` tombstone replay drill, PLAN §9 5-run mobile performance lab, and hardened multi-browser CI workflow (`.github/workflows/release-gate.yml`).
> - **External Authorization Boundary:** Live Cloudflare deploys, remote D1/R2 mutations, DNS changes, and external provider/legal sign-offs (`EXT-01`..`EXT-10`) remain **`UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION`**. All 6 local security reopen findings (`SEC-001`..`SEC-006`) and `M1-FU-03`/`M1-FU-07`/`M1-FU-08` are now **`RESOLVED_VERIFIED`** (`5cb5de1`, `1da5819`, `04e885a`); remaining pre-staging polish items (`M1-FU-01`, `M1-FU-02`, `M1-FU-04`, `M1-FU-05`, `M1-FU-06`) stay transparently tracked below.

- **Contract Authorities:** `PRD.md` (`REQ-040`, `REQ-041`, `REQ-042`, `REQ-078`), `PLAN.md` (§1, §8, §9, §12), `DECISIONS.md` (`DEC-022`, `DEC-030`, `DEC-032`, `DEC-035`, `DEC-036`, `DEC-037`, `DEC-038`, `DEC-042`, `DEC-047`), `RELEASE.md`, `TASKS.md`
- **Related Runbooks & Security Evidence:** [Release Manifest](../../RELEASE.md) | [Staged Release & Rollback](./release.md) | [Backup & Restore](./backup-restore.md) | [Hosting & Topology](./hosting.md) | [Telemetry](./telemetry-release.md) | [Privacy](./privacy.md) | [SEO Launch](./seo-launch.md) | [ASVS 5.0 L2 Checklist](../security/asvs-5.0-l2-checklist.md) | [Security Findings Register](../security/findings-register.md) | [ZAP Scan Report](../security/zap-scan-report.md)

---

## 1. Full M1 + M2 Scope vs. Release 1.1 Deferral (`109 / 110` Tasks)

| Wave | Milestone | Focus | Count | Task IDs |
|---|---|---|---:|---|
| **Wave 0** | M1 | Monorepo & Cloudflare `workerd` Bootstrap | 1 | `TASK-023` |
| **Wave 1** | M1 | Core Schemas (`PLATFORM_DB` + `TenantStore`), OpenAPI, URL Helpers & `base-nova` Shell | 5 | `TASK-001`, `TASK-010`, `TASK-011`, `TASK-024`, `TASK-032` |
| **Wave 2** | M1 | Host Routing, Queues/Cron, Rate Limits, Privacy, Email, Better Auth + Google/2FA | 12 | `TASK-002`, `TASK-025`, `TASK-028`, `TASK-029`, `TASK-030`, `TASK-031`, `TASK-037`, `TASK-045`, `TASK-049`, `TASK-067`, `TASK-077`, `TASK-090` |
| **Wave 3** | M1 | Core CMS APIs, Cloudflare Images/Video Pipeline, Shared Theme Shell & SEO Foundations | 16 | `TASK-004`, `TASK-005`, `TASK-006`, `TASK-007`, `TASK-008`, `TASK-009`, `TASK-012`, `TASK-013`, `TASK-014`, `TASK-015`, `TASK-016`, `TASK-017`, `TASK-027`, `TASK-050`, `TASK-051`, `TASK-089` |
| **Wave 4** | M1 | Console Foundations, Custom Domains, AutoLaris Billing, Lifecycle, Receipts & Coupons | 11 | `TASK-003`, `TASK-026`, `TASK-048`, `TASK-055`, `TASK-056`, `TASK-057`, `TASK-058`, `TASK-059`, `TASK-081`, `TASK-082`, `TASK-095` |
| **Wave 5** | M1 | CMS Admin Screens, 6 Themes + Style Variants/Store, Plugin Runtime, Public Site, Forms, Branches, Marketing & Moderation | 39 | `TASK-018`, `TASK-021`, `TASK-022`, `TASK-033`, `TASK-034`, `TASK-036`, `TASK-039`, `TASK-040`, `TASK-041`, `TASK-042`, `TASK-043`, `TASK-044`, `TASK-046`, `TASK-047`, `TASK-052`, `TASK-053`, `TASK-054`, `TASK-060`, `TASK-061`, `TASK-065`, `TASK-068`, `TASK-069`, `TASK-070`, `TASK-076`, `TASK-080`, `TASK-087`, `TASK-088`, `TASK-091`, `TASK-092`, `TASK-093`, `TASK-094`, `TASK-096`, `TASK-097`, `TASK-102`, `TASK-103`, `TASK-104`, `TASK-106`, `TASK-107`, `TASK-108` |
| **Wave 6** | M1 | Phase 1 Integration Checkpoint (M1 Gate) | 1 | `TASK-063` |
| **Wave 7** | M2 | M2 Verticals (`/gerai`, `/tour`, `/kendaraan`, Professional Services, Presets), AI Writing & Onboarding, Insights, Revisions, Monthly Reports, MCP OAuth 2.1, Agency Portal, Affiliate Program, Plugin Store & 4 Additional Seed Plugins | 22 | `TASK-019`, `TASK-020`, `TASK-035`, `TASK-064`, `TASK-066`, `TASK-071`, `TASK-072`, `TASK-073`, `TASK-074`, `TASK-075`, `TASK-079`, `TASK-083`, `TASK-084`, `TASK-085`, `TASK-086`, `TASK-098`, `TASK-099`, `TASK-100`, `TASK-101`, `TASK-105`, `TASK-109`, `TASK-110` |
| **Wave 8** | M2 | Pre-Launch Security Assurance (`ASVS L2` + `ZAP` + BOLA) & Full Production Release Gate | 2 | `TASK-078`, `TASK-038` |
| **Total Release Scope** | **M1 + M2** | **100% of v1.0 Production Scope** | **109 / 110** | `TASK-062` (Owner Redirect Manager & 404 Monitor) explicitly deferred to Release 1.1 per `DEC-035 C16` |

---

## 2. Executed Full Release Gate Evidence (`TASK-038` + `TASK-078`, 2026-11-24)

All automated release gates execute with **zero production credentials**, **zero live Cloudflare deploys**, and **zero remote database writes** (`.github/workflows/ci.yml`, `.github/workflows/security.yml`, `.github/workflows/staged-release-dry-run.yml`, `.github/workflows/release-gate.yml`):

| Gate | Command | Verified Result & Measured Evidence |
|---|---|---|
| **Specification Integrity** | `pnpm spec:check` | PASS — DAG acyclicity, task contracts, and boundary parity verified |
| **Lint & Guardrails** | `pnpm lint` | PASS — ESLint across `apps/web/src`, `packages`, `tests`; zero `@radix-ui/*`, `asChild`, or `Sparkles` |
| **Typecheck** | `pnpm typecheck` | PASS — `tsc --noEmit` + `astro sync && astro check && tsc --noEmit` (`0` errors) |
| **Workflow Linting (`actionlint`)** | `actionlint .github/workflows/*.yml` | PASS — all 4 workflows (`ci.yml`, `security.yml`, `staged-release-dry-run.yml`, `release-gate.yml`) valid, 100% 40-char SHA-pinned, `permissions: {}`, per-job `contents: read`, `persist-credentials: false`, `fetch-depth: 0` on git-ancestry jobs (`ci.yml` `verify` & `release-gate.yml`), `timeout-minutes`, zero `${{ secrets.* }}` |
| **Build & Wrangler Dry-Run** | `pnpm --filter @punyasitus/web build` | PASS — real `@astrojs/cloudflare` SSR Worker (`apps/web/dist/server/wrangler.json`) built cleanly |
| **Release Manifest & Rollback Check** | `release-manifest --json . && rollback-check --json --migration-risk M1 .` | PASS — `release-manifest: VALID` (`punyasitus-v1.0.0-rc1`, `Environment: production`, `Declared-Risk: R3`, `Status: READY`), `rollback-check: PASS` (`M1` & `M3`). `Backup-Proof` reference: `backup://punyasitus-backup/local-drill-20261124-verified` (local pre-launch drill proof — not yet a live production R2 backup; live pre-launch R2 snapshot gated under `EXT-01`/`EXT-10`) |
| **Full M1 + M2 Static Release Gate** | `node scripts/verify/release-gate.mjs` | PASS — `109/109` task suites on disk, `PLATFORM_DB` migrations `0001..0033` & `TenantStore` `0001..0024` (0 destructive DDL), all 5 official Frozen-Core plugins registered (`seo-ai-autopilot` default-active only), `wrangler.jsonc` (`workers_dev: false`, `preview_urls: false`), `TASK-078` security artifacts (`APPROVED`) |
| **Executed Isolated Backup, Restore & `DEC-022` Tombstone Replay Proof** | `./scripts/verify/backup-restore-drill.mjs --verify-rollback-plan` + `tests/task-038/workerd.integration.test.ts` | PASS (`Backup-Proof: backup://punyasitus-backup/local-drill-20261124-verified`, CI artifact `release-gate-evidence`): **(a) Standalone Node SQLite harness (`scripts/verify/backup-restore-drill.mjs`):** isolated restore `rtoMs=27 ms` (`<= 4h` RTO budget), `platformSnapshotSha256=0cf48ee9f89825f63dcff6d1bf7454e48cfa84332704d920cd88be1f44ceab68`, active tenant & manifest SHA-256 verified (platform, tenant & manifest tamper tests reject cleanly), PITR bookmark verified, `DEC-022` tombstone replay prevented resurrection (`status=purged`, `0` active hosts, `0` R2 objects remaining, tombstoned `TenantStore` removed); **(b) Real product-code `workerd` integration (`tests/task-038/workerd.integration.test.ts`):** directly executes `exportPlatformDbLogicalSql` + `runDailyPlatformBackup` (`scripts/backup-restore/platform-backup.ts`), `runIsolatedRestoreDrill` (`scripts/backup-restore/restore-drill.ts`), and `recordDeletionTombstone` + `replayDeletionTombstones` (`packages/db/src/privacy/tombstones.ts`) against real `workerd` `PLATFORM_DB` D1, `TenantStore` DO, `BACKUP_BUCKET`, and `MEDIA_BUCKET` |
| **PLAN §9 5-Run Mobile Performance Lab** | `node tests/performance/release-lab.mjs` *(strict, zero waiver)* | **`PASS` (STRICT `CLS <= 0.10`, ZERO WAIVER)** — `M1-FU-08` resolved in `1da5819` (`238c429`) and `--allow-tracked-cls-deviation=M1-FU-08` removed from CI (`.github/workflows/release-gate.yml`) and `tests/task-038/e2e.mjs`. Measured `5` routes (`/` homepage, `/blog/*`, `/layanan/*`, `/kendaraan/*`, `/tour/*`) × `5` runs = `25` cold mobile runs (`360x800`, `4x CPU`, `1.6 Mbps / 750 Kbps / 150ms RTT`): `LCP p50=508 ms / p95=523.2 ms` (`< 2500 ms`), `TTFB p50=150 ms / p95=150 ms`, **`CLS p50=0 / p95=0 / max=0`** (`clsBudgetMet=true`, `trackedWaiver=null`), first-party public JS `max=3,603 B` (`<= 25 KiB`), initial transferred assets `max=19,746 B` (`<= 500 KiB`), `bodyReadFailures=0`, `INP=FIELD_DATA_ONLY_CRUX_RUM_28D` (never fabricated). `tests/performance/m1-budget.mjs` also passes strictly (`maxCLS=0.002 <= 0.10`, `clsBudgetMet=true`) |
| **M1 + M2 Multi-Browser, No-JS & Negative-Case Gate** | `node tests/e2e-gate/release-gate.mjs --browsers=chromium,firefox,webkit` | **`PASS` ON HOSTED GITHUB ACTIONS (`chromium=PASSED, firefox=PASSED, webkit=PASSED` — 54 screenshots; run `45577200732` on `6a4d6c1`, 2026-11-25)** — `360px`/`768px`/`1440px` across all 3 browser engines, WCAG 1.4.10 `200%` zoom & `320px` reflow, Escape focus restoration, `12` No-JS M1+M2 vertical HTML routes (`/`, `/blog`, `/layanan`, `/produk`, `/tour`, `/kendaraan`, `/gerai` + details) + `/sitemap.xml` + `/robots.txt` asserting concrete per-route Schema.org `@type` values (`WebSite`, `Article`/`BlogPosting`, `Service`, `Product`, `TouristTrip`, `Car`/`Motorcycle`/`Vehicle`, `LocalBusiness`/`Organization`) and zero fabricated ratings/financing schema, strict `404` cross-tenant A->B read & M2 outlet write denial, `403` CSRF/Origin mismatch, `422` unsafe URL, XSS neutralization, warm-cache suspension `503 no-store noindex` |
| **Release Gate Unit & Workerd Suites** | `vitest` (`tests/task-038/`, `tests/task-063/`, `tests/task-078/`, `tests/security/`) | PASS — all unit suites & real `workerd` integration suites PASS locally & on hosted GitHub Actions (`CI` run `45577200650` on `6a4d6c1`: `110` unit suites / `94` integration suites / `79` e2e scripts verified) |
| **Pre-Launch Security Assurance (`TASK-078`)** | `node scripts/security/run-security-suite.mjs` + hosted `zaproxy/action-baseline` | **`PASS` LOCALLY & ON HOSTED GITHUB ACTIONS (`Security Assurance` run `45577200637` on `6a4d6c1`: OWASP ZAP Baseline `PASS: 65, FAIL-NEW: 0, WARN-NEW: 0, INFO: 0, IGNORE: 6`; Local DAST `0 High, 0 Medium, 0 Low alerts`)** (`APPROVED` independent review `pi-claude-sonnet-5-5`, 2026-11-24): `375` routes / `16` MCP tools / `5` plugins (`0` drift), `50/50` live BOLA cross-tenant probes denied, all 6 findings (`SEC-001`..`SEC-006`) **`RESOLVED_VERIFIED`** (`5cb5de1`, `1da5819`, `04e885a`, `6a4d6c1`); live staging ZAP full scan remains `EXT-10` (`UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION`) |
| **Hosted GitHub Actions 4 / 4 Workflows (`6a4d6c1`)** | `CI`, `Security Assurance`, `Staged Release Dry-Run`, `Production Release Gate (M1 + M2)` | **`4 / 4 SUCCESS` on `origin/main` (`6a4d6c1`, 2026-11-25):** `CI` (`45577200650`, 2/2 jobs), `Security Assurance` (`45577200637`, 2/2 jobs incl. OWASP ZAP Baseline `65 PASS / 0 FAIL / 0 WARN`), `Staged Release Dry-Run` (`45577200654`), `Production Release Gate (M1 + M2)` (`45577200732`: `chromium`/`firefox`/`webkit` `PASSED`, strict zero-waiver 5-run mobile lab `LCP p50=460ms / p95=476ms / CLS p50=0 / p95=0 / max=0`, backup/restore drill `rtoMs=82ms`) |

---

## 3. Historical Phase 1 M1 Integration Checkpoint Baseline (`TASK-063`)

Preserved intact for M1 audit continuity (`tests/task-063/`):
- **M1 Unit Test Suite:** **85 unit test files (806 tests)** (`tests/task-*/unit.test.ts`).
- **M1 Workerd Integration Suite:** **73 integration test files (375 tests)** (`tests/task-*/workerd.integration.test.ts`).
- **M1 Build Baseline:** Wrangler dry-run bundle `14.07 MiB` (`< 64 MiB`), cold startup `77 ms` (`< 1000 ms`).
- **M1 Browser & Negative-Case Verification Notes:** Verified `360px`/`768px`/`1440px`, true `200%` zoom & `320px` WCAG 1.4.10 reflow, keyboard navigation & exact-trigger focus restoration, No-JS public browsing + **API-level No-JS `application/x-www-form-urlencoded` `303` PRG submission test** (`POST /api/leads`), strict `404` cross-tenant denial, warm-cache suspension `503` `no-store` `noindex`, XSS neutralization, and SVG upload-intent `415` / `inspectImageBinary` magic-byte spoofing `415` (**live binary upload through Worker was NOT verified in M1; blocked by `M1-FU-07`**).

---

## 4. Security Hardening Register (`TASK-078`: `SEC-001`..`SEC-006`) & M1 Follow-Ups (`M1-FU-01`..`M1-FU-08`)

All 6 security findings (`SEC-001`..`SEC-006`) and `M1-FU-03`/`M1-FU-07`/`M1-FU-08` were closed in their owning tasks (`5cb5de1`, `1da5819`, `04e885a`) and re-verified on the built Worker; remaining non-blocking pre-staging polish items stay transparently tracked below:

### 4.1 Security Findings (`docs/security/findings-register.md`)

| Finding ID | Severity | Area | Owning Task(s) & Commit | Status |
|---|---|---|---|---|
| **SEC-001** (`M1-FU-03`) | **High** | Dashboard publish endpoints (`pages`, `posts`, `catalog`, `identity`) routed through `publishResourceWithScreening` (shared-domain content screening) | `TASK-103`, `TASK-005`..`009` (`04e885a`) | `RESOLVED_VERIFIED` |
| **SEC-002** (`M1-FU-07`) | **Medium** *(was fail-closed)* | Streaming media upload `PUT /media/upload/:intentId` & `video/upload/:intentId` exempted from JSON `Content-Type` while keeping strict exact-`Origin` CSRF guard | `TASK-025`, `TASK-012`, `TASK-050` (`1da5819`) | `RESOLVED_VERIFIED` |
| **SEC-003** | **Medium** | Baseline HTTP security headers (`CSP`, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`) enforced centrally across HTML + JSON APIs (`0` DAST alerts) | `TASK-002`, `TASK-076`, `TASK-045` (`1da5819`) | `RESOLVED_VERIFIED` |
| **SEC-004** | **Medium** | Console affiliate CSV export enforces 10-minute 2FA step-up, bounded `offset`/`limit` pagination (default 5,000), explicit `X-Export-*` truncation headers & audit logging | `TASK-086` (`5cb5de1`) | `RESOLVED_VERIFIED` |
| **SEC-005** | **Low** | Central middleware `CSRF_PROTECTED_API_PREFIXES` now includes `/api/agency`, `/api/affiliate`, `/api/onboarding` | `TASK-025`, `TASK-083`, `TASK-086` (`1da5819`) | `RESOLVED_VERIFIED` |
| **SEC-006** | **Medium** | Strict public & platform CSP emits per-response 128-bit cryptographic `'nonce-...'` with zero `'unsafe-inline'` in `script-src` (`0` ZAP `10055` alerts) | `TASK-076` (`1da5819`) | `RESOLVED_VERIFIED` |

### 4.2 Integration Follow-Up Register (`M1-FU-01`..`M1-FU-08`)

| ID | Area | Follow-Up Item | Status / Target Stage |
|---|---|---|---|
| **M1-FU-01** | Database Migrations | Consolidate active M1+M2 migration descriptors (`platform` `0001..0033`, `tenant` `0001..0024`) into central `PLATFORM_MIGRATIONS` and `TENANT_MIGRATIONS` arrays and refresh `tests/task-001` checksum assertions in one audited PR. | Tracked pre-staging |
| **M1-FU-02** | Public Analytics & Contact/Custom Forms Mounting | Mount `<AnalyticsHead />` inside the shared public theme `<Layout>` head slot (consent-gated) and wire `SectionContactForm` + `SectionCustomForm` into `SectionRenderer.astro` for direct page-section contact/custom form rendering. | Tracked pre-staging |
| **M1-FU-03** | Shared-Domain Content Screening | Wired `TASK-103` `publishResourceWithScreening` into all 4 direct dashboard publish routes (`pages`, `posts`, `catalog`, `identity`) in `04e885a` (`SEC-001`). | `RESOLVED_VERIFIED` (`04e885a`) |
| **M1-FU-04** | Custom Theme Head Parity | Align `apps/web/src/themes/custom/sample-agency/Layout.astro` with `managedHead={true}` parity when `<PublicSeoHead />` is slotted. | Tracked pre-staging |
| **M1-FU-05** | Sitemap Resilience & Taxonomy Archives | Add fail-closed `TenantStore` DB error handling (`503 no-store`) and opted-in taxonomy archive URLs in `apps/web/src/pages/sitemaps/_shared.ts`. | Tracked pre-staging |
| **M1-FU-06** | OpenAPI Contract Sync | Regenerate and audit `docs/api/openapi.json` across all Wave 3–Wave 7 endpoints. | Tracked pre-staging |
| **M1-FU-07** | Streaming Media Upload Middleware CSRF | Exempted `/api/tenants/:tenantId/media/upload/:intentId` & `video/upload/:intentId` from global JSON `Content-Type` while retaining strict exact-`Origin` verification in `1da5819` (`SEC-002`, proven in `tests/task-025/workerd.integration.test.ts`; live binary upload through the Worker was historically NOT verified in M1). | `RESOLVED_VERIFIED` (`1da5819`) |
| **M1-FU-08** | Mobile Cold-Load Floating Dock CLS | Fixed `.ps-floating-dock` / `FloatingWhatsApp.astro` geometry in `1da5819` (`238c429`); 5-run mobile lab now passes strictly with **`CLS p50=0 / p95=0 / max=0` (`clsBudgetMet=true`, ZERO waiver)** and waiver removed from CI & `tests/task-038/e2e.mjs`. | `RESOLVED_VERIFIED` (`1da5819`) |

---

## 5. External Provider, Legal & Launch Gates (`UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION`)

Every external dependency below **cannot** be proven by reading documentation or running local mocks. Each remains explicitly **`UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION`** until executed with owner approval against live accounts and counsel:

| Gate ID | Category | Gate Description | Status | Proven By / Target |
|---|---|---|---|---|
| **EXT-01** | Cloudflare Infra | Cloudflare Workers Paid account with isolated `punyasitus-*` D1, R2, Queues, Images, and AI bindings | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live staging provisioning (`PLAN §1`, `TASK-045`) |
| **EXT-02** | Cloudflare SaaS / DCV / O2O | Separate staging SaaS zone + fallback origin, live HTTP DCV pass-through (`return fetch(request)`), and O2O with a real second Cloudflare customer zone | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live staging test domain (`TASK-045`, `TASK-003`, `TASK-039`) |
| **EXT-03** | Trust+ / Komdigi | Trust+ / Komdigi static-IP reputation check against staging and production SaaS zones | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live zone DNS/IP check (`TASK-103`, `PLAN §1`) |
| **EXT-04** | Identity | Google OAuth live client credentials, consent screen verification, and production/staging redirect URIs | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live OAuth callback test (`TASK-090`) |
| **EXT-05** | Transactional Email | Cloudflare Email Sending (Beta) DNS onboarding (`notif.punyasitus.com`) and live inbox placement (SPF/DKIM/DMARC across Gmail, Outlook, Indonesian ISP) | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live staging send (`TASK-077`, `STATUS.md`) |
| **EXT-06** | Payments (AutoLaris) | AutoLaris merchant approval, static-IP relay host, live VA/QRIS checkout instruction, and live Advice webhook reconciliation | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live merchant sandbox/staging (`TASK-055`, `TASK-056`) |
| **EXT-07** | Legal — UU PDP | Indonesian legal counsel review of Bahasa Indonesia Terms of Service and Privacy Policy (`UU 27/2022` UU PDP) | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Counsel sign-off (`DEC-047`) |
| **EXT-08** | Regulatory — PSE / Tax / Komdigi | PSE Lingkup Privat registration, `UU KUP Art. 28(11)` invoice/tax retention alignment, and `Kepmen Komdigi 127/128` compliance text | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Legal/regulatory filing (`DEC-047`) |
| **EXT-09** | Webmaster / SEO | Manual Google Search Console & Bing Webmaster property verification on live domain(s) | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Live launch verification (`TASK-054`, `seo-launch.md`) |
| **EXT-10** | Live Staging Full Release Gate | Live staging OWASP ZAP full active scan, live staging multi-browser (Chromium + Firefox + WebKit) 5-run lab, and production pre-launch R2 backup snapshot | `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` | Authorized staging & launch cutover (`TASK-078` + `TASK-038`) |

---

## 6. Sign-Off Rules

1. **Repository Release Gate (`TASK-038`)** proves local/CI readiness across all `109` M1+M2 tasks, `RELEASE.md` manifest & rollback contract, isolated backup/restore + `DEC-022` tombstone replay drill, 5-run mobile lab, and hardened multi-browser CI workflows. It does **not** authorize `wrangler deploy`, remote D1 migrations, DNS mutations, or public launch.
2. Any failing acceptance case, upstream contract drift, or stale evidence reopens `TASK-038`.
3. `INP` is field data (`FIELD_DATA_ONLY_CRUX_RUM_28D` — 28-day CrUX/RUM p75) and is never claimed from synthetic Chromium runs.
