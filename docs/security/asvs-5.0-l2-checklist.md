# PunyaSitus — OWASP ASVS 5.0 Level 2 Security Assurance Checklist (`TASK-078`)

- **Contract Authorities:** `PRD.md` (`REQ-078`, `REQ-001`, `REQ-034`, `REQ-038`, `REQ-039`, `REQ-068`, `REQ-076`), `PLAN.md` (§3, §4, §5, §12, §18, §19), `DECISIONS.md` (`DEC-032`, `DEC-036`, `DEC-040`, `DEC-041`, `DEC-045`, `DEC-047`)
- **Related Security Artifacts:** [Surface Inventory](./surface-inventory.json) | [Findings & Reopen Register](./findings-register.md) | [ZAP & DAST Scan Report](./zap-scan-report.md)
- **Scope & Granularity Note (`DEC-032`):** Internal pre-launch security assurance review structured by **OWASP ASVS 5.0 Level 2 control groups** across domains `V1`–`V17` (a control-group mapping rather than a verbatim ~250-row sub-requirement transcription; external paid pentest and formal certification are explicitly non-scope). Findings discovered during this review are tracked for fix in their owning tasks via normal reopen — **never** patched inside `TASK-078`.

## Status Legend

| Status | Meaning |
|---|---|
| `VERIFIED_AUTOMATED` | Proven by passing unit, `workerd` integration, or built-Worker HTTP/browser tests on disk |
| `VERIFIED_STATIC` | Verified by inspecting implemented source/config/infrastructure/CI contracts on disk |
| `FINDING_REOPEN_REQUIRED` | Real gap or hardening defect identified; tracked in [findings-register.md](./findings-register.md) for owning-task reopen |
| `ACCEPTED_RISK` | Explicit bounded risk accepted with documented compensating controls and rationale |
| `UNVERIFIED_STAGING_GATE` | Requires authorized live staging/production infrastructure, third-party accounts, or legal counsel (`EXT-01..EXT-10`) |
| `NOT_APPLICABLE` | ASVS domain does not apply to PunyaSitus architecture (explicitly justified) |

---

## V1 — Encoding, Sanitization & Secure Architecture

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V1.1` | Multi-tenant architecture & physical data separation (`PLATFORM_DB` D1 control plane + per-tenant `TenantStore` SQLite DO) | `apps/web/src/worker/tenant-store.ts`, `packages/db/src/connections/index.ts`, `apps/web/src/core/tenant.ts`, `tests/security/workerd.bola.integration.test.ts` | `VERIFIED_AUTOMATED` |
| `V1.2` | Output encoding & rich-text HTML sanitization (TipTap restricted schema, XSS neutralization of `<script>`, inline handlers, `javascript:` URLs) | `packages/core/src/content/rich-text.ts`, `packages/core/src/link-sanitizer.ts`, `tests/e2e-gate/m1-checkpoint.mjs`, `scripts/security/run-security-suite.mjs` | `VERIFIED_AUTOMATED` |
| `V1.3` | SQL injection defense via parameterized Drizzle / D1 prepared statements & plugin SQL namespace guard (`plg_<id>__*`) | `packages/db/src/platform/repositories.ts`, `packages/core/src/plugins/sql-guard.ts`, `packages/db/src/plugins/scoped-db.ts` | `VERIFIED_AUTOMATED` |
| `V1.4` | CSV formula injection sanitization (`=`, `+`, `-`, `@`, tab/CR prefix neutralization) on lead and console exports | `packages/core/src/exports/sanitize.ts`, `apps/web/src/pages/api/tenants/[tenantId]/leads/export.ts`, `apps/web/src/pages/api/console/affiliates/_shared.ts` | `VERIFIED_AUTOMATED` |
| `V1.5` | Shared-domain abuse/gambling screening before publish (`REQ-103`) | `packages/core/src/content-screening/engine.ts`, `packages/db/src/content-screening/publish-gate.ts`, `packages/db/src/mcp/tools.ts`, `apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/publish.ts`, `apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts`, `apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/publish.ts`, `apps/web/src/pages/api/tenants/[tenantId]/identity/publish.ts`, `tests/task-103/workerd.integration.test.ts` (`SEC-001` resolved in `04e885a`) | `VERIFIED_AUTOMATED` |

## V2 — Validation & Business Logic

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V2.1` | Strict schema validation (Zod, unknown-field rejection, bounded payload caps `16 KiB`–`256 KiB`) across public & admin APIs | `packages/core/src/schemas/index.ts`, `apps/web/src/core/public-input.ts`, `packages/auth/src/agency/http.ts`, `apps/web/src/pages/api/leads.ts`, `apps/web/src/pages/api/events.ts` | `VERIFIED_AUTOMATED` |
| `V2.2` | Anti-automation on public registration, login, leads, and abuse forms (Turnstile, honeypot, D1 atomic rate limits) | `packages/core/src/security/turnstile.ts`, `packages/db/src/rate-limits/limiter.ts`, `apps/web/src/pages/api/leads.ts`, `apps/web/src/pages/api/abuse-report.ts` | `VERIFIED_AUTOMATED` |
| `V2.3` | Optimistic concurrency (`expectedVersion` -> `409 Conflict`), server-recomputed pricing/coupons, gap-free receipts, and idempotent payment webhooks | `packages/core/src/billing/coupons.ts`, `packages/core/src/billing/advice.ts`, `packages/core/src/billing/receipt-pdf.ts`, `tests/e2e-gate/m1-checkpoint.mjs` | `VERIFIED_AUTOMATED` |
| `V2.4` | Anti-SSRF URL validation (rejects `javascript:`, loopback, RFC1918, link-local `169.254.169.254`, redirects on CIMD/importer/webhooks) | `packages/core/src/link-sanitizer.ts`, `packages/core/src/mcp/security.ts`, `packages/plugins/wp-importer/src/ssrf.ts`, `packages/plugins/lead-notifier/src/ssrf.ts`, `tests/e2e-gate/m1-checkpoint.mjs` | `VERIFIED_AUTOMATED` |
| `V2.5` | Strict pathname canonicalization eliminating `%63`, double-slash `//`, backslash, null-byte, and `..` traversal before auth gates | `apps/web/src/middleware/auth.ts`, `tests/task-078/workerd.integration.test.ts`, `scripts/security/run-security-suite.mjs` | `VERIFIED_AUTOMATED` |

## V3 — Web Frontend Security, CSP & HTTP Headers

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V3.1` | Consent-aware public CSP profiles (`strict` pre-consent, per-response 128-bit nonce `gtm-relaxed` post-consent, warm-cache bypass on consent cookie) | `apps/web/src/middleware/csp.ts`, `packages/core/src/analytics/csp.ts`, `apps/web/src/core/privacy.ts` | `VERIFIED_AUTOMATED` |
| `V3.2` | Strict CSP on public tenant and platform HTML without `'unsafe-inline'` script execution | `packages/core/src/analytics/csp.ts`, `apps/web/src/middleware/csp.ts`, `tests/task-076/unit.test.ts`, `tests/task-076/workerd.integration.test.ts`, `scripts/security/run-security-suite.mjs` (per-response 128-bit `'nonce-...'`, zero `'unsafe-inline'` in `script-src`; `SEC-006` resolved in `1da5819`) | `VERIFIED_AUTOMATED` |
| `V3.3` | Baseline security response headers (`Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` / `frame-ancestors 'self'`, `Referrer-Policy: strict-origin-when-cross-origin`) across HTML and JSON API surfaces | `apps/web/src/middleware/csp.ts`, `packages/core/src/analytics/csp.ts`, `tests/task-076/workerd.integration.test.ts`, `scripts/security/run-security-suite.mjs` (`0` alerts `PASS`; `SEC-003` resolved in `1da5819`; live edge HSTS gated under `EXT-02`) | `VERIFIED_AUTOMATED` |
| `V3.4` | Cross-Site Request Forgery (CSRF) & exact `Origin` verification on state-changing admin APIs (`Content-Type: application/json` + exact `Origin`, central prefixes covering `/api/tenants`, `/api/account`, `/api/auth`, `/api/agency`, `/api/affiliate`, `/api/affiliates`, `/api/onboarding`, `/api/console`, `/auth/consent`) | `packages/auth/src/session-guard.ts`, `apps/web/src/middleware/auth.ts`, `packages/auth/src/agency/http.ts`, `apps/web/src/pages/api/affiliate/_shared.ts`, `apps/web/src/pages/api/onboarding/_shared.ts`, `tests/task-025/workerd.integration.test.ts` (`SEC-005` resolved in `1da5819`) | `VERIFIED_AUTOMATED` |
| `V3.5` | Cookie isolation without PSL dependency (host-only `__Host-` cookies, `Domain=` stripping on tenant responses, zero cross-subdomain cookie bleed) | `packages/auth/src/cookies.ts`, `apps/web/src/core/tenant.ts`, `scripts/security/run-security-suite.mjs` | `VERIFIED_AUTOMATED` |
| `V3.6` | Zero pre-consent third-party tracking requests & click-to-load YouTube (`www.youtube-nocookie.com`) | `packages/core/src/analytics/config.ts`, `packages/core/src/media/youtube.ts`, `tests/e2e-gate/m1-checkpoint.mjs`; `<AnalyticsHead />` public layout mount tracked under `M1-FU-02` | `FINDING_REOPEN_REQUIRED` |

## V4 — API, Web Services & Tenant MCP Server

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V4.1` | Programmatic surface inventory covering 100% of HTTP routes, MCP tools, and plugins with zero drift and fail-closed `/api/**` classification | `scripts/security/enumerate-surfaces.mjs`, `docs/security/surface-inventory.json`, `tests/security/cross-tenant-bola.unit.test.ts` | `VERIFIED_AUTOMATED` |
| `V4.2` | MCP server strictly isolated to `app` host, bearer-only (`__Host-` cookies rejected `401`), explicit 16-tool allowlist, 31-tool denylist, draft-only writes, human browser publish approval with atomic claim-first | `apps/web/src/pages/mcp/index.ts`, `packages/core/src/mcp/constants.ts`, `packages/db/src/mcp/tools.ts`, `packages/auth/src/mcp/server.ts`, `tests/security/workerd.bola.integration.test.ts` | `VERIFIED_AUTOMATED` |
| `V4.3` | Inbound webhook verification (secret verified before reading body/DB, `128 KiB` bounded body cap, 5-minute timestamp window, durable replay ledger) | `apps/web/src/pages/api/plugins/[pluginId]/webhook.ts`, `apps/web/src/pages/api/webhooks/email/bounce-handler.ts`, `tests/security/workerd.bola.integration.test.ts` | `VERIFIED_AUTOMATED` |
| `V4.4` | OpenAPI contract documentation synchronized with all shipped endpoints | `docs/operations/release-checklist.md` (`M1-FU-06`) | `FINDING_REOPEN_REQUIRED` |

## V5 — File Handling & Media Pipeline

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V5.1` | Same-origin streaming upload (no browser presigned R2 PUT), hard byte counter (`5 MB` images / `10 MB` video), SHA-256 verification, tenant-prefixed R2 quarantine (`t/<tenantId>/quarantine/...`), client object-key override rejection | `packages/core/src/media/index.ts`, `packages/core/src/media/video.ts`, `apps/web/src/pages/api/tenants/[tenantId]/media/upload/[intentId].ts`, `apps/web/src/pages/api/tenants/[tenantId]/media/video/upload/[intentId].ts` | `VERIFIED_AUTOMATED` |
| `V5.2` | Strict magic-byte sniffing, pixel bounds, SVG/BMP rejection, WebP normalization, per-tenant quota accounting | `packages/core/src/media/index.ts`, `tests/e2e-gate/m1-checkpoint.mjs` | `VERIFIED_AUTOMATED` |
| `V5.3` | Live end-to-end streaming binary PUT through Worker middleware with exact-`Origin` CSRF protection | `apps/web/src/middleware/auth.ts`, `apps/web/src/pages/api/tenants/[tenantId]/media/upload/[intentId].ts`, `apps/web/src/pages/api/tenants/[tenantId]/media/video/upload/[intentId].ts`, `tests/task-025/workerd.integration.test.ts` (`SEC-002` / `M1-FU-07` resolved in `1da5819`) | `VERIFIED_AUTOMATED` |

## V6 — Authentication

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V6.1` | Primary Google OAuth (`email_verified` required for linking, console allowlist) with email/password fallback via Better Auth | `packages/auth/src/index.ts`, `packages/auth/src/google.ts`, `apps/web/src/pages/api/auth/[...all].ts` | `VERIFIED_AUTOMATED` |
| `V6.2` | Mandatory TOTP 2FA centrally enforced for ALL platform operators (`console`) and agency admins (`/agency`, `/api/agency`) regardless of sign-in method | `apps/web/src/middleware/auth.ts`, `packages/auth/src/platform/guard.ts`, `packages/auth/src/platform/two-factor.ts`, `packages/auth/src/agency/guard.ts` | `VERIFIED_AUTOMATED` |
| `V6.3` | Single-use expiring hashed verification/reset tokens, session revocation on password reset, anti-enumeration error neutrality | `packages/auth/src/index.ts`, `packages/auth/src/account.ts`, `packages/auth/src/onboarding/index.ts` | `VERIFIED_AUTOMATED` |
| `V6.4` | Recent step-up reauthentication for destructive/high-sensitivity actions (owner transfer, console sensitive payout/bank CSV exports & mutations) | `apps/web/src/pages/dashboard/[handle]/settings/members/api.ts`, `packages/auth/src/platform/console-http.ts`, `apps/web/src/pages/api/console/affiliates/index.ts`, `tests/task-086/workerd.integration.test.ts` (`requireStepUp: isCsvExport`; `SEC-004` / `TASK-086` resolved in `5cb5de1`) | `VERIFIED_AUTOMATED` |
| `V6.5` | Live Google OAuth client credentials, verified consent screen, and staging/production redirect URIs | `docs/operations/release-checklist.md` (`EXT-04`) | `UNVERIFIED_STAGING_GATE` |

## V7 — Session Management

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V7.1` | Host-only `__Host-` session cookies (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, NO `Domain`) with distinct cookie names and signing secrets between `app` and `console` | `packages/auth/src/cookies.ts`, `packages/auth/src/index.ts`, `scripts/security/run-security-suite.mjs` | `VERIFIED_AUTOMATED` |
| `V7.2` | Role-scoped idle and absolute session lifetime ceilings (`DEC-045`: tenant `8h/7d`, agency & affiliate `60m/12h`, superadmin `30m/8h`) enforced on every request | `packages/auth/src/google.ts`, `apps/web/src/middleware/auth.ts`, `packages/auth/src/agency/http.ts`, `apps/web/src/pages/api/affiliate/_shared.ts` | `VERIFIED_AUTOMATED` |
| `V7.3` | Distinct signing secret enforcement (`>= 32` chars, fail-closed outside `local`/`test`) | `packages/auth/src/cookies.ts`, `apps/web/src/middleware/auth.ts` | `VERIFIED_AUTOMATED` |

## V8 — Authorization & Multi-Tenant BOLA Isolation

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V8.1` | Live per-request `PLATFORM_DB` membership & role verification (`tenants JOIN members`), rejecting forged `activeOrganizationId` and returning strict neutral `404` for foreign tenants | `packages/auth/src/session-guard.ts`, `packages/auth/src/permissions.ts`, `tests/security/cross-tenant-bola.unit.test.ts`, `tests/security/workerd.bola.integration.test.ts` | `VERIFIED_AUTOMATED` |
| `V8.2` | Multi-tenant BOLA isolation: **dynamically proven** with positive controls (Tenant B `200`) + negative cross-tenant read & `POST`/`PUT`/`PATCH` mutation denials + MCP cross-tenant OAuth token-issuance denial (`workerd`) + 50 live built-Worker HTTP probes across tenant APIs, plugins, console, agency, affiliate, and public hosts; **statically audited** for authorization-guard presence across 100% of all 375 enumerated routes | `docs/security/surface-inventory.json`, `tests/security/cross-tenant-bola.unit.test.ts`, `tests/security/workerd.bola.integration.test.ts`, `tests/task-078/workerd.integration.test.ts`, `scripts/security/run-security-suite.mjs` | `VERIFIED_AUTOMATED` |
| `V8.3` | Live server wall-clock entitlement gating (`trial`/`active`/`grace`/`locked`/`suspended`/`purged`) enforced centrally before mutations and public edge cache hits | `packages/auth/src/entitlements/gate.ts`, `apps/web/src/middleware/auth.ts`, `apps/web/src/core/tenant.ts`, `tests/e2e-gate/m1-checkpoint.mjs` | `VERIFIED_AUTOMATED` |
| `V8.4` | Public forms (`POST /api/leads`, `/api/events`, `/api/abuse-report`) bind tenant strictly from verified `Host`, rejecting client-supplied `tenantId` with zero cross-tenant writes | `apps/web/src/core/public-input.ts`, `apps/web/src/pages/api/leads.ts`, `apps/web/src/pages/api/events.ts`, `tests/security/workerd.bola.integration.test.ts` | `VERIFIED_AUTOMATED` |

## V9 — Self-Contained Tokens & Signed Downloads

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V9.1` | Signed, expiring, tenant-bound archive export download tokens & affiliate referral cookies using keyed HMAC verification | `packages/core/src/exports/signing.ts`, `packages/core/src/affiliates/cookie.ts`, `apps/web/src/middleware/affiliate-referral.ts` | `VERIFIED_AUTOMATED` |
| `V9.2` | One-time Telegram link tokens & MCP publish-approval tokens (15-minute expiry, stored hashed, tenant-bound, atomic single-use claim) | `packages/plugins/lead-notifier/src/tokens.ts`, `packages/db/src/mcp/tools.ts`, `packages/db/src/mcp/store.ts` | `VERIFIED_AUTOMATED` |

## V10 — OAuth 2.1 & OIDC

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V10.1` | OAuth 2.1 Authorization Code + mandatory PKCE `S256` + RFC 8707 `resource` indicator binding + CIMD metadata validation (`redirect: "error"`, SSRF checks, DCR disabled `403`, cross-tenant consent issuance denied) | `packages/auth/src/mcp/oauth.ts`, `packages/core/src/mcp/security.ts`, `apps/web/src/middleware/mcp-oauth.ts`, `tests/task-075/workerd.integration.test.ts`, `tests/security/workerd.bola.integration.test.ts` | `VERIFIED_AUTOMATED` |
| `V10.2` | Short-lived access tokens (`15 min`), rotating refresh tokens (`7d` TTL, `90d` absolute ceiling), RFC 7009 immediate grant revocation, authorize endpoint rate limiting | `packages/core/src/mcp/constants.ts`, `packages/auth/src/mcp/oauth.ts`, `apps/web/src/middleware/mcp-oauth.ts` | `VERIFIED_AUTOMATED` |

## V11 — Cryptography

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V11.1` | Web Crypto CSPRNG (`crypto.getRandomValues` / `crypto.randomUUID`), SHA-256 token/checksum hashing, HMAC-SHA256 webhook/download signing, constant-time comparisons | `packages/core/src/analytics/csp.ts`, `packages/core/src/exports/signing.ts`, `packages/core/src/media/index.ts`, `packages/plugins/lead-notifier/src/crypto.ts` | `VERIFIED_STATIC` |
| `V11.2` | Production secrets managed exclusively as Worker Secrets (never committed in `wrangler.jsonc` or git); local dev fallbacks restricted strictly to `APP_ENV === "local" | "test"` | `apps/web/wrangler.jsonc`, `apps/web/src/middleware/auth.ts`, `scripts/verify/m1-gate.mjs` | `VERIFIED_AUTOMATED` |

## V12 — Secure Communication, TLS, DCV & O2O

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V12.1` | Strict HTTPS (`ssl_mode: strict`, `always_use_https: true`, `min_tls_version: 1.2`), `workers_dev: false`, `preview_urls: false`, HTTP DCV pass-through (`/.well-known/acme-challenge/*`, `/.well-known/pki-validation/*`), O2O rules | `infra/cloudflare/topology.json`, `apps/web/wrangler.jsonc`, `apps/web/src/worker/index.ts`, `apps/web/src/core/tenant.ts` | `VERIFIED_STATIC` |
| `V12.2` | Live Cloudflare SaaS zone TLS/DCV/O2O, HSTS edge enforcement, Cloudflare Email SPF/DKIM/DMARC, and AutoLaris static-IP relay TLS | `docs/operations/release-checklist.md` (`EXT-01`, `EXT-02`, `EXT-05`, `EXT-06`) | `UNVERIFIED_STAGING_GATE` |

## V13 — Configuration & Supply-Chain Hardening

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V13.1` | CI/CD supply-chain hardening: top-level `permissions: {}`, least-privilege `contents: read`, `persist-credentials: false`, 100% 40-char SHA-pinned GitHub Actions, frozen lockfile installs, zero `${{ secrets.* }}` | `.github/workflows/ci.yml`, `.github/workflows/security.yml`, `tests/task-078/unit.test.ts` | `VERIFIED_AUTOMATED` |
| `V13.2` | OWASP ZAP baseline workflow configured in CI against Host-routed `app.punyasitus.com` with explicit High/Medium `FAIL` rules in `zap-rules.tsv` (executes on GitHub Actions runner upon PR/push; not executed on a live CI runner in this local session) | `.github/workflows/security.yml`, `scripts/security/zap-rules.tsv`, `docs/security/zap-scan-report.md`, `tests/task-078/unit.test.ts` | `VERIFIED_STATIC` |
| `V13.3` | Dotfile/probe rejection (`/.env`, `/.git/config`, `/wp-login.php`) in Worker routing & Cloudflare WAF declarative rules | `infra/cloudflare/topology.json`, `scripts/security/run-security-suite.mjs` | `VERIFIED_AUTOMATED` |

## V14 — Data Protection & UU PDP Privacy

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V14.1` | Retention schedules (`DEC-045`: leads 180d, event dedup 24h, daily aggregates 13m, audit logs 90d, quarantine 24h, backups 30d) + durable deletion tombstones | `packages/db/src/privacy/retention.ts`, `packages/db/src/privacy/tombstones.ts`, `apps/web/src/worker/index.ts` | `VERIFIED_AUTOMATED` |
| `V14.2` | Zero-PII affiliate reporting (masked handles only), PII-free email notifications, AI writing PII blocker (blocks obvious emails/phones before `env.AI`) | `apps/web/src/pages/api/affiliate/_shared.ts`, `packages/core/src/ai-writing/pii-blocker.ts`, `packages/core/src/reports/pii-guard.ts` | `VERIFIED_AUTOMATED` |
| `V14.3` | UU 27/2022 (UU PDP) legal counsel review, PSE Lingkup Privat registration, and UU KUP Art. 28(11) tax/record review | `docs/operations/release-checklist.md` (`EXT-07`, `EXT-08`) | `UNVERIFIED_STAGING_GATE` |

## V15 — Secure Coding & Frozen-Core Plugin Isolation

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V15.1` | Frozen-Core static first-party plugin registry (zero `.zip` uploads, zero remote `import()`, zero `eval()`), compiled theme registry with zero DB/auth imports | `apps/web/src/core/plugin-registry.ts`, `apps/web/src/core/plugin-runtime.ts`, `apps/web/src/core/theme-registry.ts`, `tests/security/cross-tenant-bola.unit.test.ts` | `VERIFIED_AUTOMATED` |
| `V15.2` | Zero-cost inactive/unentitled plugin isolation (no SQL migrations/queries or routes mounted unless entitled in `PLATFORM_DB`) | `apps/web/src/core/plugin-runtime.ts`, `packages/db/src/plugins/scoped-db.ts`, `tests/security/workerd.bola.integration.test.ts` | `VERIFIED_AUTOMATED` |
| `V15.3` | Static lint/typecheck guardrails (`strict: true`, ESLint, DEC-036 `@base-ui/react` enforcement) | `tsconfig.json`, `scripts/dev/lint.mjs`, `.github/workflows/ci.yml` | `VERIFIED_AUTOMATED` |

## V16 — Security Logging, Error Handling & Immutable Audit Trail

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V16.1` | Append-only, read-only, read-side redacted platform audit explorer (`POST`/`PUT`/`PATCH`/`DELETE` return `405`, zero passwords/tokens/cookies/secrets) | `apps/web/src/pages/api/console/audit/index.ts`, `packages/db/src/platform/audit.ts`, `packages/core/src/jobs/redact.ts`, `packages/core/src/telemetry/logger.ts` | `VERIFIED_AUTOMATED` |
| `V16.2` | Tenant activity log isolated per tenant; MCP tool calls, agency actions, affiliate payout actions, and security denials recorded with `requestId` | `apps/web/src/pages/api/tenants/[tenantId]/activity/index.ts`, `packages/db/src/mcp/tools.ts`, `packages/auth/src/platform/guard.ts` | `VERIFIED_AUTOMATED` |
| `V16.3` | Console affiliate CSV export pagination, truncation headers (`X-Export-Row-Count`, `X-Export-Max-Rows`, `X-Export-Truncated`, `X-Export-Offset`, `X-Export-Next-Offset`), and `PLATFORM_DB` audit trail | `apps/web/src/pages/api/console/affiliates/index.ts`, `apps/web/src/pages/api/console/affiliates/_shared.ts`, `tests/task-086/unit.test.ts`, `tests/task-086/workerd.integration.test.ts` (`SEC-004` / `TASK-086` resolved in `5cb5de1`) | `VERIFIED_AUTOMATED` |
| `V16.4` | Fail-closed error handling: neutral HTML/JSON state pages (`404`/`503 no-store noindex`), zero stack traces or internal DB details leaked to callers | `apps/web/src/core/tenant.ts`, `apps/web/src/middleware/auth.ts`, `packages/auth/src/agency/http.ts`, `scripts/security/run-security-suite.mjs` | `VERIFIED_AUTOMATED` |

## V17 — WebRTC

| Control Group | Control / Requirement | PunyaSitus Evidence (Files & Tests on Disk) | Status |
|---|---|---|---|
| `V17.1` | WebRTC media/signaling/TURN/ICE security controls | PunyaSitus does not implement WebRTC peer connections, media streams, STUN/TURN servers, or real-time voice/video calling (`PRD.md` scope). | `NOT_APPLICABLE` |
