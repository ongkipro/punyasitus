# Status — punyasitus

Updated: 2026-11-24
Status: Active
State: IMPLEMENTING
Review-Risk: R3
Independent-Review: PASS
Primary-Worker: agy-supervisor
Independent-Reviewer: pi-claude-sonnet-5-5
Independent-Review-Head: b3b6f6f

## Now

**107 / 110 roadmap tasks (97.3% total; 85 / 85 = 100.0% Phase 1 M1 + 22 / 22 = 100.0% Wave 7 M2 landed!) completed, visually verified (360px/1440px Playwright), independently cross-family reviewed (`pi-claude-sonnet-5-5` via `ai-ask pi`), verified in `delivery-ledger`, merged, checkpointed, and pushed to `origin/main` (`b3b6f6f`):**
- **Wave 0–6 (85/85 — 100% M1):** All 85 M1 tasks including `TASK-063` Integration Checkpoint M1 (`086b018`, plus additive M2 migration forward-compatibility `36e9f2a`).
- **Wave 7 (22/22 — 100% M2):** All 22 M2 tasks landed: AI Writing (`TASK-074`, `platform/0029`), Insights (`TASK-072`, `tenant/0022`), Tenant MCP + OAuth 2.1 (`TASK-075`, `platform/0030`), Google Maps Review + GBP (`TASK-073`), Agency Portal (`TASK-083`, `platform/0028`), AI Draft Onboarding (`TASK-109`), Revision History (`TASK-064`, `tenant/0023`), Monthly Owner Report (`TASK-110`), Offline Gerai Multi-Outlet (`TASK-019`), WA Support Entry Point (`TASK-105`), Affiliate Enrollment & Attribution (`TASK-084`, `platform/0031`), Preferred Schedule Inquiries (`TASK-071`, `tenant/0024`), Travel & Umrah DEC-042 (`TASK-020`), Affiliate Commission Ledger & Payout Batches (`TASK-085`, `platform/0032`), Professional Services (`TASK-035`), Affiliate Portal & Console Payouts (`TASK-086`), Plugin Store & AutoLaris Add-ons (`TASK-098`, `platform/0033`), Vehicle Showroom `/kendaraan` (`TASK-079`), Vertical Starter Presets M2 (`TASK-066`), Official Seed Plugins `lead-notifier` (`TASK-101`), `wp-importer` (`TASK-100`), and `bio-links` + `wa-cs-rotator` (`TASK-099`) — all 5 official plugins registered in `plugin-registry.ts` with zero Frozen Core edits.
- **Clean Mainline (`b3b6f6f`):** `107/107` unit test files (`1,076/1,076` tests PASS), `0` typecheck errors, `spec:check` + `lint` + `delivery-ledger verify` PASS.

## Next

1. **Wave 8 — Final 2 Launch Gate Tasks:**
   - **`TASK-078` (R3):** Pre-Launch Security Assurance — OWASP ASVS 5.0 Level 2 checklist, exhaustive cross-tenant BOLA suite (every tenant API route, MCP tool, and public route), OWASP ZAP baseline CI workflow (`security.yml`), and full scan report + independent R3 review.
   - **`TASK-038` (R3):** Full Production Release Gate (M1 + M2) — Chromium/Firefox/WebKit matrix at 360/768/1440, PLAN §9 performance lab, executed backup/restore rehearsal, `RELEASE.md`, and `production-gate` (keeping `EXT-*` live/legal gates explicitly `UNVERIFIED` until owner authorizes live staging).
2. **`TASK-062`** (Owner Redirect Manager & 404 Monitor) remains explicitly deferred to Release 1.1 per `DEC-035 C16`.

## Blockers

None for local Wave 1 development (mocks and local `workerd` cover it). Pre-staging/pre-launch gates remain tracked below:

- Staging accounts and infrastructure (PLAN section 1): Cloudflare Workers Paid with `punyasitus-*` resources, both zones and a separate staging SaaS zone with the Trust+ IP check, Google OAuth client, Email Service DNS on `notif.punyasitus.com`, Telegram bot token, AutoLaris merchant approval and the static-IP relay host. Needed from `TASK-003`/`TASK-055` live checks onward.
- Legal and tax (DEC-047): PSE Lingkup Privat, Terms and Privacy with the UU 27/2022 review, UU KUP Art. 28(11), Kepmen Komdigi 127/128 text. Evidence required before `TASK-038`.
- Live verifications in the table below.

<!-- Keep Now/Next/Blockers within the first 80 lines and this file under 12 KB; history goes to BUILD-LOG.md. -->

## Delivery state machine

Allowed forward path:

`PLANNED -> READY -> IMPLEMENTING -> VERIFYING -> REVIEWING -> INTEGRATING -> PRODUCTION_READY -> AWAITING_DEPLOY_APPROVAL -> DEPLOYED -> SMOKE_TESTING -> VERIFIED`

Use `BLOCKED` only as an interruption state. Record the blocker and exact state to resume. Do not skip verification/review/integration states. `production-gate` proves the transition from `INTEGRATING` to `PRODUCTION_READY`; it never deploys.

`RELEASE.md` owns release-specific truth: release ID, base, declared risk, rollback reference/command, backup proof, and readiness status. `Review-Risk` is the highest semantic risk found during review. `production-gate` computes effective release risk as max(`RELEASE.md` Declared-Risk, deterministic `diff-risk`, `Review-Risk`). R3/R4 require `Independent-Review: PASS`, a reviewer distinct from `Primary-Worker`, and `Independent-Review-Head` bound to the reviewed release content. Only review-attestation files may change after that commit.

`OBSERVABILITY.md` owns post-deploy verification probes. After deployment, transition to `SMOKE_TESTING` and run `release-check`. Every configured observability probe must pass before transition to `VERIFIED`.

## Pending live verification

These were researched against official documentation on 2026-11-18 (see `BUILD-LOG.md`), but reading cannot prove them. Each is proven only by a live run with a real test domain and a real Cloudflare account. Until then, treat them as unverified and do not claim them in sales or launch material.

| Item | Why reading is not enough | Proven by | Needs |
|---|---|---|---|
| Certificate issuance through the Worker (HTTP DCV pass-through, zero-downtime migration with pre-issued certificate) | Cloudflare does not document how an originless Worker fallback passes validation paths through; `return fetch(request)` is an assumption also carried by `adsbook.id` | `TASK-023` spike, `TASK-045`, `TASK-003` | A disposable test domain, the staging SaaS zone with its own fallback origin |
| O2O with a real customer Cloudflare zone (routing, `301` primary redirect, interaction with the customer's own redirect rules) | Two zones run in sequence; behavior depends on the customer's zone settings, which no document can predict | `TASK-045`, `TASK-039` | A second Cloudflare account acting as the customer, with a proxied CNAME |
| Cloudflare Email Sending delivery (inbox placement, SPF/DKIM/DMARC alignment, behavior while the product is in beta) | Deliverability depends on reputation and receiving providers; the product is in public beta | `TASK-077` staging send | `notif.punyasitus.com` onboarded to Email Service; test inboxes at Gmail, Outlook and an Indonesian provider |
