# Wave 7 — Vertical Modules, Agency Portal, Affiliates, Plugin Store (`private_client`/`free`/`paid`), Seed Plugins, AI & MCP (M2)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

### TASK-084: Affiliate Enrollment, First-Party Referral Attribution & Anti-Abuse Locks
- **Milestone:** M2
- **Requirement:** REQ-084
- **Constraints:** REQ-039, REQ-059, REQ-090
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/affiliates/**`, `packages/core/src/affiliates/**`, `apps/web/src/middleware/**`, `apps/web/src/pages/api/affiliates/apply.ts`, `apps/web/src/pages/api/onboarding/**`, `docs/api/**`, `tests/task-084/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-084; PLAN.md section 19.4.
- **Accepted Invariants:** Affiliate is a separate account type; `?ref=<code>` sets a 30-day first-party attribution cookie on `punyasitus.com` (or manual code at signup) and locks `referred_by_affiliate_id` immutably at trial creation; self-referral, agency-managed, demo and complimentary tenants are ineligible.
- **Depends On:** TASK-058, TASK-083, TASK-087, TASK-090
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-084 pass: valid `?ref=` within 30 days attributes signup once and cannot be overwritten later; expired (>30d) cookie, suspended affiliate, self-referral (matching user/email/payout identity) and agency-created tenants produce zero attribution; trial sites render the minimalist *"Dibuat dengan PunyaSitus"* footer badge while paid sites can hide it or attach their verified `?ref=<code>`.
- **Visual Contract:** None (API/cookie attribution and application endpoint).
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Multi-level marketing (MLM) tiers or third-party ad-network tracking cookies.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-085: Affiliate Commission Ledger (`60%`/`20%`), 14-Day Hold & Bi-Monthly Payout Batches
- **Milestone:** M2
- **Requirement:** REQ-085
- **Constraints:** REQ-057, REQ-081, REQ-084
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/affiliates/ledger/**`, `packages/core/src/affiliates/commission.ts`, `apps/web/src/worker/queues/billing/**`, `apps/web/src/worker/cron/**`, `tests/task-085/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-085; PLAN.md section 19.4.
- **Accepted Invariants:** Confirmed net subscription receipts (excluding AutoLaris fee and coupons) record `60%` on a referred tenant's first paid invoice and `20%` on renewals in `pending` state for 14 days before `approved`; refunded invoices reverse pending commissions or create negative balance offsets; Cron builds payout batches on the `15th` and `30th` (`Asia/Jakarta`) for balances `>= Rp 100.000`.
- **Depends On:** TASK-056, TASK-081, TASK-082, TASK-084
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-085 pass: frozen-time tests verify exact integer IDR `60%` first-payment and `20%` renewal calculation on net discounted base, duplicate settlement idempotency, 14-day `pending`->`approved` promotion, pre- and post-payout refund reversal/offset, and `15th`/`30th` `Asia/Jakarta` batch generation skipping balances `< Rp 100.000`.
- **Visual Contract:** None (ledger and scheduled batch engine).
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Automated bank-disbursement API calls (payout transfer is manual & audited in TASK-086).
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-086: Affiliate Self-Service Portal & Console Payout Management
- **Milestone:** M2
- **Requirement:** REQ-086
- **Constraints:** REQ-051, REQ-068, REQ-084, REQ-085
- **Risk Level:** R3
- **Allowed Paths:** `apps/web/src/layouts/AffiliateLayout.astro`, `apps/web/src/pages/affiliate/**`, `apps/web/src/pages/api/affiliate/**`, `apps/web/src/pages/console/affiliates/**`, `apps/web/src/pages/api/console/affiliates/**`, `docs/api/**`, `tests/task-086/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-086; PLAN.md section 19.4; DESIGN.md section 4.3.
- **Accepted Invariants:** Affiliates view referral link, click/trial/paid counts (masked tenant handles only, zero tenant PII/content), pending/approved/paid balances and payout history; console operators approve/suspend affiliates and mark payout batches paid with transfer reference and audit.
- **Depends On:** TASK-032, TASK-048, TASK-067, TASK-084, TASK-085
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-086 pass: affiliate dashboard renders masked referrals and accurate ledger totals with zero tenant PII leakage; foreign-affiliate and tenant-only sessions get 403/404; operator approval/suspension and batch payout reference recording require 2FA + reason and write `platform_audit`.
- **Visual Contract:** DESIGN.md section 4.3 Affiliate Portal and Console Affiliate screens at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Exposing referred customer emails, phones or leads to affiliates.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-098: Plugin Store, Bespoke Client Grants (`private_client`) & AutoLaris Add-on Billing
- **Milestone:** M2
- **Requirement:** REQ-098
- **Constraints:** REQ-051, REQ-056, REQ-068, REQ-081, REQ-082, REQ-083, REQ-085, REQ-097
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/src/plugins/store/**`, `packages/core/src/plugins/billing.ts`, `apps/web/src/pages/dashboard/[handle]/plugins/**`, `apps/web/src/pages/api/tenants/[tenantId]/plugins/**`, `apps/web/src/pages/agency/plugins/**`, `apps/web/src/pages/api/agency/plugins/**`, `apps/web/src/pages/console/plugins/**`, `apps/web/src/pages/api/console/plugins/**`, `apps/web/src/worker/queues/billing/**`, `docs/api/**`, `tests/task-098/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-098; ADR-0010; PLAN.md section 19.7; DESIGN.md section 7.
- **Accepted Invariants:** `Plugin` is a dedicated top-level sidebar menu supporting symmetric **Gratis** (`public_free`), **Berbayar** (`public_paid`: `paid_once`, `paid_monthly`, `paid_yearly` via AutoLaris QRIS/VA, agency-billed for agency clients, issuing PDF receipts and affiliate commissions), and **Custom Dev** (`private_client` client/agency grants + `service_kind = "custom_plugin"` bespoke development request & quote workflow fulfilled on `console.punyasitus.com/plugins` by linking a `private_client` grant, promotable to the public store via metadata without code rewrite); installed plugins never add top-level sidebar spam; expiry/disable preserves `plg_*` data until `H+45` purge.
- **Depends On:** TASK-048, TASK-061, TASK-067, TASK-075, TASK-081, TASK-082, TASK-083, TASK-085, TASK-097
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-098 pass: `Plugin -> Custom Dev` submits a rate-limited `custom_plugin` request and operators deliver it only after linking an active `private_client` plugin grant; `private_client` plugin is invisible to ungranted tenants, works for granted client, and appears in store immediately when promoted by 2FA operator to `public_free` or `public_paid`; `paid_once` and `paid_monthly` checkouts settle via mocked AutoLaris Advice, generate numbered PDF receipts, credit affiliate commission, route agency-managed client purchases to the agency payer, and cleanly deactivate on add-on expiry without deleting `plg_*` rows.
- **Visual Contract:** DESIGN.md section 7 `Toko Plugin` (`Terpasang` / `Gratis` / `Berbayar` / `Khusus Klien`) and `console.punyasitus.com/plugins` at 360/1440 px.
- **Reopen Conditions:** Billing entitlement race, agency-client billing leak, or loss of `plg_*` data on plugin disable/expiry.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Revenue-share payouts to external third-party plugin developers.
- **Escalation Conditions:** Destructive migration or required change exceeding declared path boundary.

### TASK-099: Official Launch Seed Plugins (`bio-links` Free & `wa-cs-rotator` Commercial/Grantable)
- **Milestone:** M2
- **Requirement:** REQ-099
- **Constraints:** REQ-001, REQ-014, REQ-040, REQ-097, REQ-098
- **Risk Level:** R2
- **Allowed Paths:** `packages/plugins/bio-links/**`, `packages/plugins/wa-cs-rotator/**`, `apps/web/src/core/plugin-registry.ts`, `docs/api/**`, `tests/task-099/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-099; ADR-0010; PLAN.md section 19.7; `docs/plugins/PLUGIN-DEVELOPMENT.md`.
- **Accepted Invariants:** Both plugins live strictly inside `packages/plugins/*` with **zero edits to Frozen Core CMS packages** (`packages/core`, `packages/db`, `packages/auth`, `middleware`); `bio-links` serves a zero-JS `/link` page with first-party click stats; `wa-cs-rotator` distributes WhatsApp CTAs across multiple sales agents (round-robin, weights, active hours) with per-agent click attribution while unentitled websites retain the single-number base WhatsApp flow (`REQ-014`).
- **Depends On:** TASK-014, TASK-030, TASK-097, TASK-098
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-099 pass: `git diff` touches zero Frozen Core CMS files outside `plugin-registry.ts`; enabling `bio-links` publishes `/link` with `0` bytes client JS and records click counts in `plg_bio_links__*`; enabling `wa-cs-rotator` rotates WA redirects across active agents according to weight/schedule, skips off-shift agents (falling back to primary WA), logs per-agent clicks in `plg_wa_cs_rotator__*`, and returns to single-number WA immediately when disabled.
- **Visual Contract:** Public `/link` bio page and `base-nova` admin configuration screens for `bio-links` and `wa-cs-rotator` at 360/1440 px.
- **Reopen Conditions:** Any modification required in Frozen Core packages, public JS exceeding `25 KiB`, or cross-tenant CS rotation leak.
- **Rollback/Migration State:** Additive `plg_bio_links__*` and `plg_wa_cs_rotator__*` tables only; preserve data.
- **Non-Scope:** Official WhatsApp Business Cloud API chatbot inbox or paid Meta conversation billing.
- **Escalation Conditions:** Required change exceeding `packages/plugins/*` boundary into Frozen Core modules.

### TASK-100: Official Free Plugin `wp-importer` (WordPress `/wp-json` & WXR Safe Draft Importer)
- **Milestone:** M2
- **Requirement:** REQ-100
- **Constraints:** REQ-001, REQ-009, REQ-010, REQ-064, REQ-097
- **Risk Level:** R2
- **Allowed Paths:** `packages/plugins/wp-importer/**`, `apps/web/src/core/plugin-registry.ts`, `docs/api/**`, `tests/task-100/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-100; ADR-0010; PLAN.md section 19.7; `docs/plugins/PLUGIN-DEVELOPMENT.md`.
- **Accepted Invariants:** Built strictly inside `packages/plugins/wp-importer` with zero edits to Frozen Core CMS modules; imports posts, categories/tags, public SEO fields and SSRF-checked images (normalized to WebP in R2 within the website's storage quota) from a public WordPress URL (`/wp-json/wp/v2`) or uploaded WXR XML exclusively into unpublished `draft` records with an import report and former-URL inventory.
- **Depends On:** TASK-006, TASK-007, TASK-097, TASK-098
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-100 pass: `git diff` touches zero Frozen Core files outside `plugin-registry.ts`; golden WordPress `/wp-json` and WXR fixtures import into sanitized TipTap JSON `draft` posts (never auto-published) with categories and R2 WebP images; private/loopback SSRF URLs (`127.0.0.1`, `169.254.169.254`, `10.0.0.0/8`, IPv6 local), XML bombs, SVG/executable media and quota-exceeding imports fail safely.
- **Visual Contract:** `base-nova` WordPress import wizard & dry-run summary report inside `/dashboard/[handle]/plugins/wp-importer` at 360/1440 px.
- **Reopen Conditions:** SSRF bypass, auto-publishing unreviewed imports, quota bypass, or edits leaking into Frozen Core packages.
- **Rollback/Migration State:** Additive `plg_wp_importer__*` job-history tables only; preserve data.
- **Non-Scope:** Pixel-identical Elementor layout cloning, WooCommerce orders, or third-party WordPress plugin execution.
- **Escalation Conditions:** Required change exceeding `packages/plugins/wp-importer` boundary into Frozen Core modules.

### TASK-101: Official Plugin `lead-notifier` (1-Click Telegram Bot Linking & Signed CRM/Sheets Webhook)
- **Milestone:** M2
- **Requirement:** REQ-101
- **Constraints:** REQ-001, REQ-031, REQ-039, REQ-042, REQ-097, REQ-098
- **Risk Level:** R2
- **Allowed Paths:** `packages/plugins/lead-notifier/**`, `apps/web/src/core/plugin-registry.ts`, `docs/api/**`, `tests/task-101/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-101; ADR-0010; PLAN.md section 19.7; `docs/plugins/PLUGIN-DEVELOPMENT.md`.
- **Accepted Invariants:** Built strictly inside `packages/plugins/lead-notifier` with zero edits to Frozen Core CMS modules; 1-click `"Hubungkan Telegram"` generates a 15-minute single-use token for `https://t.me/<PlatformBot>?start=<token>` verified via `X-Telegram-Bot-Api-Secret-Token` on `/api/plugins/lead-notifier/webhook` (zero manual `chat_id` entry); `lead.created` Queue hook dispatches formatted inquiry + tap-to-WhatsApp CTA to Telegram (`public_free`) and/or HMAC-signed SSRF-guarded HTTPS webhooks (`public_paid` / grantable) without ever blocking or failing `POST /api/leads`.
- **Depends On:** TASK-021, TASK-028, TASK-097, TASK-098
- **Verification:** Done when `pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` including tests/task-101 pass: `git diff` touches zero Frozen Core files outside `plugin-registry.ts`; mocked Telegram `/start <token>` links the tenant chat once, rejects missing/wrong `X-Telegram-Bot-Api-Secret-Token`, expired (`>15m`) or replayed tokens, and delivers `lead.created` notifications with a valid `wa.me` follow-up button; webhook target blocks private IPs (SSRF) and signs payloads; simulated Telegram/webhook `500`/timeout still saves the lead in `TenantStore` with `200`.
- **Visual Contract:** `base-nova` 1-click Telegram connect/disconnect card and webhook test UI inside `/dashboard/[handle]/plugins/lead-notifier` at 360/1440 px.
- **Reopen Conditions:** Lead submission blocked by notifier failure, webhook SSRF bypass, cross-tenant chat token replay, or edits leaking into Frozen Core packages.
- **Rollback/Migration State:** Additive `plg_lead_notifier__*` tables only; preserve data.
- **Non-Scope:** Two-way live-chat ticketing inbox inside Telegram.
- **Escalation Conditions:** Required change exceeding `packages/plugins/lead-notifier` boundary into Frozen Core modules.

### TASK-105: WhatsApp Support Entry Point with Context and Published Hours
- **Milestone:** M2
- **Requirement:** REQ-105
- **Constraints:** REQ-083, REQ-090
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/components/admin/help/**`, `packages/core/src/support/**`, `apps/web/src/pages/console/settings/**`, `apps/web/src/pages/api/console/settings/**`, `tests/task-105/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-105; PLAN.md section 20.2.
- **Accepted Invariants:** The prefilled message holds only the handle and screen name; number, hours and response target come from platform settings; agency-managed websites show the agency contact first.
- **Depends On:** TASK-032, TASK-048, TASK-083
- **Verification:** Done when `pnpm test:unit` and `pnpm test:e2e` including tests/task-105 pass: the help button opens `wa.me` with the platform number and a message containing the handle and screen but no token, password or visitor data; support hours and the response target render from settings edited on the console with audit; a client member of an agency sees the agency contact.
- **Visual Contract:** Dashboard help button and support-hours panel at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Ticketing systems, shared inbox software or WhatsApp Business API integration.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-109: Optional AI Draft Step in Onboarding
- **Milestone:** M2
- **Requirement:** REQ-109
- **Constraints:** REQ-075, REQ-093
- **Risk Level:** R2
- **Allowed Paths:** `packages/core/src/onboarding/ai-draft/**`, `apps/web/src/pages/auth/onboarding/**`, `apps/web/src/pages/api/onboarding/**`, `tests/task-109/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-109; PLAN.md section 20.5; DECISIONS.md DEC-028.
- **Accepted Invariants:** Generated text is always a `CONTOH` draft, never published automatically; facts are never generated; the step is optional and counted against the DEC-028 quota.
- **Depends On:** TASK-074, TASK-093
- **Verification:** Done when `pnpm test:unit` and `pnpm test:e2e` including tests/task-109 pass against a mocked provider: the optional step fills only text fields of the chosen blueprint as `CONTOH` drafts; price, licence, review and address fields stay empty; skipping the step leaves the blueprint unchanged; quota exhaustion and provider failure fall back to the plain blueprint without blocking signup.
- **Visual Contract:** Onboarding AI step with skip option at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** AI image generation or automatic publishing.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.

### TASK-110: Monthly Owner Performance Report Email
- **Milestone:** M2
- **Requirement:** REQ-110
- **Constraints:** REQ-073, REQ-077
- **Risk Level:** R2
- **Allowed Paths:** `apps/web/src/worker/cron/monthly-report.ts`, `apps/web/src/worker/queues/reports/**`, `packages/core/src/reports/**`, `packages/core/src/email/**`, `apps/web/src/pages/dashboard/[handle]/settings/notifications/**`, `tests/task-110/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-110; PLAN.md section 20.5.
- **Accepted Invariants:** One report per active website per month; no visitor personal data; owners can opt out; low-activity websites receive none; no blind retry.
- **Depends On:** TASK-030, TASK-072, TASK-077
- **Verification:** Done when `pnpm test:unit` and `pnpm test:integration` including tests/task-110 pass: a fixture month produces one email per eligible website with visits, leads, WhatsApp clicks, top offering, AI-assistant referrals, change against the previous month and one tip; a website below the threshold or opted out receives none; the email holds no visitor data; a failed send is recorded and not replayed.
- **Visual Contract:** Monthly report email template checked at mobile width; notification settings toggle at 360/1440 px.
- **Reopen Conditions:** Upstream contract changes, regression in sibling tests, or missing negative-case coverage.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Weekly or daily digests, or reports to agencies about other agencies' clients.
- **Escalation Conditions:** Destructive migration, unapproved third-party subprocessor, or required change exceeding declared path boundary.
