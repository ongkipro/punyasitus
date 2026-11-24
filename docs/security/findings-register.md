# PunyaSitus — Pre-Launch Security Findings & Reopen Register (`TASK-078`)

- **Contract Authorities:** `PRD.md` (`REQ-078`), `DECISIONS.md` (`DEC-032`), `docs/tasks/wave-8.md` (`TASK-078`)
- **Accepted Invariant:** *"Findings are fixed in their owning tasks' paths through normal task reopen, not inside this task; no testing against production or third-party systems without authorization."*
- **Last Executed Verification Base:** Local built `@punyasitus/web` Worker (`apps/web/dist/server/wrangler.json`) after post-hardening merges (`5cb5de1`, `1da5819`, `04e885a`) + `workerd` integration suite + surface enumeration check (**0 High, 0 Medium, 0 Low DAST alerts — `PASS`**).

---

## 1. Verified Security Findings (Resolved via Owning-Task Reopen Hardening Commits)

Every finding below was discovered during `TASK-078` pre-launch security assurance, remediated in its owning task paths through dedicated hardening commits, and independently re-verified against automated tests and the live built `@punyasitus/web` Worker:

| Finding ID | Severity | Area | Exact File & Line Reference | Owning Task(s) & Resolution Commit | Resolution Summary & Automated Test Proof | Status |
|---|---|---|---|---|---|---|
| **SEC-001** (`M1-FU-03`) | **High** | Shared-Domain Content Screening (`ASVS V1.5`, `REQ-103`) | `packages/db/src/content-screening/publish-gate.ts`, `apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/publish.ts`, `apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts`, `apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/publish.ts`, `apps/web/src/pages/api/tenants/[tenantId]/identity/publish.ts` | `TASK-103`, `TASK-005`..`009` — **`04e885a`** (`1e25ec1`) | Routed all 4 direct dashboard publish endpoints (`pages`, `posts`, `catalog`, `identity`) through `publishResourceWithScreening`, closing the shared-domain gambling/Trust+ screening bypass. Proven by real `workerd` integration tests in `tests/task-103/workerd.integration.test.ts` (clean publish succeeds, gambling/Trust+ payloads fail closed with moderation hold). | `RESOLVED_VERIFIED` |
| **SEC-002** (`M1-FU-07`) | **Medium** *(was fail-closed functional / verification blocker)* | Streaming Media Upload Middleware CSRF Gate (`ASVS V5.3`, `REQ-010`, `REQ-064`) | `apps/web/src/middleware/auth.ts`, `apps/web/src/pages/api/tenants/[tenantId]/media/upload/[intentId].ts`, `apps/web/src/pages/api/tenants/[tenantId]/media/video/upload/[intentId].ts` | `TASK-025`, `TASK-012`, `TASK-050` — **`1da5819`** (`238c429`) | Added scoped `TENANT_MEDIA_STREAM_UPLOAD_RE` exemption in central auth middleware so streaming binary image/video `PUT` uploads bypass only the JSON `Content-Type` requirement while retaining strict exact-`Origin` CSRF verification and magic-byte sniffing. Proven in `tests/task-025/workerd.integration.test.ts`. | `RESOLVED_VERIFIED` |
| **SEC-003** | **Medium** | Baseline HTTP Security Headers on HTML & JSON API Surfaces (`ASVS V3.3`, ZAP `10038`/`10020`/`10021`, `CUSTOM-REFERRER-POLICY`) | `apps/web/src/middleware/csp.ts`, `packages/core/src/analytics/csp.ts`, `apps/web/src/core/tenant.ts`, `apps/web/src/pages/api/health/index.ts`, `apps/web/src/pages/api/tenants/[tenantId]/pages/index.ts` | `TASK-002`, `TASK-076`, `TASK-045` — **`1da5819`** (`238c429`) | Added central baseline security header emission in `apps/web/src/middleware/csp.ts`: `X-Content-Type-Options: nosniff` across HTML + JSON API surfaces, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`, and per-response nonced `Content-Security-Policy` on `marketing`, `app`, `console`, and `tenant` HTML. Verified with **0 alerts (`PASS`)** in `scripts/security/run-security-suite.mjs`, `tests/task-076/unit.test.ts`, and `tests/task-076/workerd.integration.test.ts`. (Cloudflare edge HSTS remains gated under `EXT-02`.) | `RESOLVED_VERIFIED` |
| **SEC-004** (`TASK-086`) | **Medium** | Console Affiliate CSV Export Step-Up & Truncation Transparency (`ASVS V6.4`, `V16.3`, `REQ-086`) | `apps/web/src/pages/api/console/affiliates/index.ts`, `apps/web/src/pages/api/console/affiliates/_shared.ts`, `apps/web/src/pages/console/affiliates/_ConsoleAffiliatesPanel.tsx` | `TASK-086` — **`5cb5de1`** (`ab89c76`) | Enforced recent 10-minute 2FA step-up (`requireStepUp: isCsvExport`) on `GET /api/console/affiliates?format=csv`, replaced the silent 200-row cap with bounded `offset`/`limit` pagination (`maxRows + 1`, default cap 5,000), emitted explicit `X-Export-Row-Count`, `X-Export-Max-Rows`, `X-Export-Truncated`, `X-Export-Offset`, and `X-Export-Next-Offset` headers, and logged export metadata in `PLATFORM_DB` audit. Proven by `tests/task-086/unit.test.ts` and `tests/task-086/workerd.integration.test.ts`. | `RESOLVED_VERIFIED` |
| **SEC-005** | **Low** | Central Middleware CSRF Prefix Defense-in-Depth (`ASVS V3.4`, `REQ-034`) | `apps/web/src/middleware/auth.ts`, `packages/auth/src/agency/http.ts`, `apps/web/src/pages/api/affiliate/_shared.ts`, `apps/web/src/pages/api/onboarding/_shared.ts` | `TASK-025`, `TASK-083`, `TASK-086` — **`1da5819`** (`238c429`) | Added `/api/agency`, `/api/affiliate`, and `/api/onboarding` to central `CSRF_PROTECTED_API_PREFIXES` in `apps/web/src/middleware/auth.ts` so every state-changing admin/partner API family receives defense-in-depth `Origin` + `Content-Type` enforcement centrally in addition to route-level guards. Proven by `tests/task-025/workerd.integration.test.ts`. | `RESOLVED_VERIFIED` |
| **SEC-006** | **Medium** | Strict Public & Platform CSP Eliminates `script-src 'unsafe-inline'` (`ASVS V3.2`, ZAP `10055`) | `packages/core/src/analytics/csp.ts`, `apps/web/src/middleware/csp.ts` | `TASK-076` — **`1da5819`** (`238c429`) | Replaced `'unsafe-inline'` in `buildStrictPublicCspHeader()` and added `buildPlatformSurfaceCspHeader()` with per-response 128-bit cryptographic `'nonce-<nonce>'` injection/rotation on inline `<script>` tags across `tenant`, `marketing`, `app`, and `console` HTML responses. Verified with **0 ZAP `10055` alerts (`PASS`)** in `scripts/security/run-security-suite.mjs`, `tests/task-076/unit.test.ts`, and `tests/task-076/workerd.integration.test.ts`. | `RESOLVED_VERIFIED` |

### 1.1 Secondary Low-Priority Pre-Staging Hardening Observations (Honest Carry-Forward from H2 Review)

During the `SEC-001` (`04e885a`) remediation review, secondary tenant configuration/publish mutation surfaces that are not primary editorial publish routes were identified for optional defense-in-depth screening expansion before live staging cutover (low priority; primary public content publish routes `pages`, `posts`, `catalog`, and `identity` are already enforced):
- `/api/tenants/:tenantId/forms`
- `/api/tenants/:tenantId/theme`
- `/api/tenants/:tenantId/settings`
- `/api/tenants/:tenantId/seo`
- `/api/tenants/:tenantId/presets`
- `/dashboard/:handle/catalog/{services,travel}`
- `/api/onboarding/*`

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
| `M1-FU-08` | Eliminated cold mobile `.ps-floating-dock` CLS (`0.1118` -> `0.0000`) in **`1da5819`** (`238c429`, `apps/web/src/themes/default/components/FloatingWhatsApp.astro`); CI & `tests/task-038/e2e.mjs` now enforce strict `CLS <= 0.10` with zero waiver (`p50=0 / p95=0 / max=0`, `clsBudgetMet=true`) | `docs/operations/release-checklist.md` | `RESOLVED_VERIFIED` |

---

## 3. External Live Staging, Provider & Legal Gates (`UNVERIFIED_STAGING_GATE`)

Per `docs/operations/release-checklist.md` §5, no local or CI run can verify external accounts, DNS zones, live provider relays, or Indonesian legal counsel sign-offs. All 10 gates remain explicitly `UNVERIFIED_STAGING_GATE` until authorized execution:

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
