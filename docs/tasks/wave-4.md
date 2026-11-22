# Wave 4 — Console Foundations, Custom Domains, AutoLaris Billing, Lifecycle, Receipts & Coupons (M1)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

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
