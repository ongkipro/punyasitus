# Wave 2 — Host Routing, Queues/Cron, Rate Limits, Privacy, Email & Better Auth + Google/2FA (M1)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

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
