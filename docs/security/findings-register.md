# PunyaSitus — Pre-Launch Security Findings & Reopen Register (`TASK-078`)

- **Contract Authorities:** `PRD.md` (`REQ-078`), `DECISIONS.md` (`DEC-032`), `docs/tasks/wave-8.md` (`TASK-078`)
- **Accepted Invariant:** *"Findings are fixed in their owning tasks' paths through normal task reopen, not inside this task; no testing against production or third-party systems without authorization."*
- **Last Executed Verification Base:** Local built `@punyasitus/web` Worker (`apps/web/dist/server/wrangler.json`) + `workerd` integration suite + surface enumeration check.

---

## 1. Verified Security Findings Requiring Owning-Task Reopen

Every finding below was directly verified against repository source code and/or live built-Worker HTTP DAST execution. None are patched inside `TASK-078`; each MUST be resolved in its owning task before `TASK-038` (Full Production Release Gate) passes.

| Finding ID | Severity | Area | Exact File & Line Reference | Owning Task(s) for Reopen | Summary & Required Remediation | Status |
|---|---|---|---|---|---|---|
| **SEC-001** (`M1-FU-03`) | **High** | Shared-Domain Content Screening (`ASVS V1.5`, `REQ-103`) | `apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/publish.ts:111`, `apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts`, `apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/publish.ts`, `apps/web/src/pages/api/tenants/[tenantId]/identity/publish.ts` | `TASK-103`, `TASK-005`, `TASK-006`, `TASK-007`, `TASK-009` | `publishResourceWithScreening` is currently wired ONLY in MCP publish approval (`packages/db/src/mcp/tools.ts:714`). Direct dashboard publish endpoints call `publishPage`/`publishPost`/`publishCatalogOffering` directly, bypassing the gambling/Trust+ keyword & domain screening gate. Reopen owning tasks to route all dashboard publish handlers through `publishResourceWithScreening`. | `FINDING_REOPEN_REQUIRED` |
| **SEC-002** (`M1-FU-07`) | **Medium** *(fail-closed functional / verification blocker)* | Streaming Media Upload Middleware CSRF Gate (`ASVS V5.3`, `REQ-010`, `REQ-064`) | `apps/web/src/middleware/auth.ts:375-391`, `apps/web/src/pages/api/tenants/[tenantId]/media/upload/[intentId].ts:55`, `apps/web/src/pages/api/tenants/[tenantId]/media/video/upload/[intentId].ts:56` | `TASK-025`, `TASK-012`, `TASK-050` | Central auth middleware fails closed (`403 FORBIDDEN`) by requiring `Content-Type: application/json` across all `/api/tenants/**` state-changing requests before binary image/video streams reach `media/upload/[intentId].ts` or `media/video/upload/[intentId].ts` (which declare `csrfMode: "origin_only"`). While fail-closed (no bypass), live end-to-end binary upload + magic-byte sniffing through the Worker cannot execute until those two upload paths are exempted from JSON `Content-Type` while retaining exact `Origin` validation. | `FINDING_REOPEN_REQUIRED` |
| **SEC-003** | **Medium** | Missing Baseline HTTP Security Headers on HTML & JSON API Surfaces (`ASVS V3.3`, ZAP `10038`/`10020`/`10021`, `CUSTOM-REFERRER-POLICY`) | `apps/web/src/middleware/csp.ts:219-271`, `apps/web/src/core/tenant.ts:332-363`, `apps/web/src/pages/api/health/index.ts`, `apps/web/src/pages/api/tenants/[tenantId]/pages/index.ts` | `TASK-002`, `TASK-076`, `TASK-045` | Live built-Worker DAST scan against `/marketing`, `/auth/login`, tenant `/`, `/api/health`, and `/api/tenants/:h/pages` confirmed: (1) `marketing` and `app` HTML responses emit no `Content-Security-Policy` and no `X-Frame-Options` / `frame-ancestors` (ZAP `10038` Medium, `10020` Medium); (2) HTML responses (`marketing`, `app`, `tenant`) AND JSON API responses (`api_health`, `api_tenant_pages`) omit `X-Content-Type-Options: nosniff` (ZAP `10021` Low); (3) HTML responses omit `Referrer-Policy` (`CUSTOM-REFERRER-POLICY` Low). Add central security header emission in middleware and verify Cloudflare edge HSTS on live staging. | `FINDING_REOPEN_REQUIRED` |
| **SEC-004** (`TASK-086`) | **Medium** | Console Affiliate CSV Export Step-Up & Silent 200-Row Truncation (`ASVS V6.4`, `V16.3`, `REQ-086`) | `apps/web/src/pages/api/console/affiliates/index.ts:54-60`, `apps/web/src/pages/api/console/affiliates/index.ts:80-126` | `TASK-086` | `GET /api/console/affiliates?format=csv` exports full affiliate payout/bank details with `requireStepUp: false` (no recent 2FA step-up) and hard-caps `loadConsoleAffiliatesDashboard(..., { limit: 200 })` without cursor pagination or a truncation warning header/row. Reopen `TASK-086` to require recent 2FA step-up for CSV payout exports and either paginate/stream all rows or emit an explicit truncation signal. | `FINDING_REOPEN_REQUIRED` |
| **SEC-005** | **Low** | Central Middleware CSRF Prefix Defense-in-Depth (`ASVS V3.4`, `REQ-034`) | `apps/web/src/middleware/auth.ts:44-51` | `TASK-025`, `TASK-083`, `TASK-086` | `CSRF_PROTECTED_API_PREFIXES` covers `/api/tenants`, `/api/account`, `/api/auth`, `/api/affiliates`, `/api/console`, and `/auth/consent`, but omits `/api/agency`, `/api/affiliate` (singular), and `/api/onboarding`. Currently mitigated because each route family enforces `assertAdminCsrfAndOrigin()` locally (`packages/auth/src/agency/http.ts:262`, `apps/web/src/pages/api/affiliate/_shared.ts:424`, `apps/web/src/pages/api/onboarding/_shared.ts:126`), but adding these prefixes centrally prevents future regression on new endpoints. | `FINDING_REOPEN_REQUIRED` |
| **SEC-006** | **Medium** | Strict Public CSP Includes `script-src 'unsafe-inline'` (`ASVS V3.2`, ZAP `10055`) | `packages/core/src/analytics/csp.ts:98-111` | `TASK-076` | Live built-Worker DAST scan observed `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com` on tenant public `/` (`buildStrictPublicCspHeader()`). While `gtm-relaxed` already uses a per-response 128-bit nonce without `'unsafe-inline'`, ZAP baseline (`10055`) flags `'unsafe-inline'` as Medium. Migrate remaining inline Astro/consent scripts on public pages to external modules or per-response nonces/hashes before clearing the CI ZAP baseline gate. | `FINDING_REOPEN_REQUIRED` |

---

## 2. Related Non-Security / Cross-Task Pre-Staging Follow-Ups (Tracked in `docs/operations/release-checklist.md`)

Preserved here for full traceability across Wave 8 (`TASK-078` -> `TASK-038`):

| Follow-Up ID | Area | Reference | Status |
|---|---|---|---|
| `M1-FU-01` | Centralize `PLATFORM_MIGRATIONS` & `TENANT_MIGRATIONS` descriptors | `docs/operations/release-checklist.md` | Tracked pre-staging |
| `M1-FU-02` | Mount `<AnalyticsHead />` + `SectionContactForm` / `SectionCustomForm` in shared public layout & `SectionRenderer.astro` (re-verify post-consent tracker gating once mounted) | `docs/operations/release-checklist.md` | Tracked pre-staging |
| `M1-FU-04` | Custom theme `managedHead={true}` parity | `docs/operations/release-checklist.md` | Tracked pre-staging |
| `M1-FU-05` | Fail-closed `503 no-store` & taxonomy archive URLs in `apps/web/src/pages/sitemaps/_shared.ts` | `docs/operations/release-checklist.md` | Tracked pre-staging |
| `M1-FU-06` | Synchronize `docs/api/openapi.json` across all shipped Wave 3–Wave 7 endpoints | `docs/operations/release-checklist.md` | Tracked pre-staging |
| `M1-FU-08` | Eliminate cold mobile `.ps-floating-dock` CLS (`0.1118`) before 5-run `TASK-038` lab | `docs/operations/release-checklist.md` | Tracked pre-staging |

---

## 3. External Live Staging, Provider & Legal Gates (`UNVERIFIED_STAGING_GATE`)

Per `docs/operations/release-checklist.md` §4, no local or CI run can verify external accounts, DNS zones, live provider relays, or Indonesian legal counsel sign-offs. All 10 gates remain explicitly `UNVERIFIED_STAGING_GATE` until authorized execution:

- **EXT-01:** Cloudflare Workers Paid account & isolated `punyasitus-*` bindings
- **EXT-02:** Staging Cloudflare for SaaS zone, live HTTP DCV pass-through, and live O2O customer zone
- **EXT-03:** Trust+ / Komdigi static-IP reputation check against live zones
- **EXT-04:** Live Google OAuth client credentials & consent screen verification
- **EXT-05:** Cloudflare Email Sending (`notif.punyasitus.com`) SPF/DKIM/DMARC & inbox placement
- **EXT-06:** AutoLaris merchant approval, static-IP relay host, and live Advice webhook reconciliation
- **EXT-07:** Indonesian legal counsel review of Bahasa Indonesia Terms & Privacy Policy (`UU 27/2022` UU PDP)
- **EXT-08:** PSE Lingkup Privat registration, `UU KUP Art. 28(11)` tax/record alignment, `Kepmen Komdigi 127/128` review
- **EXT-09:** Manual Google Search Console & Bing Webmaster live domain verification
- **EXT-10:** Full Production Release Gate (`TASK-038`) + **Live Staging OWASP ZAP Full Scan** + multi-browser & 5-run performance lab + backup restore/tombstone drill
