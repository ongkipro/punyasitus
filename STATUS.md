# Status — punyasitus

Updated: 2026-11-24
Status: Active
State: IMPLEMENTING
Review-Risk: R3
Independent-Review: PASS
Primary-Worker: agy-supervisor
Independent-Reviewer: pi-claude-sonnet-5-5
Independent-Review-Head: b4fa649

## Now

**94 / 110 roadmap tasks (85.5% total; 85 / 85 = 100.0% Phase 1 M1 + 9 / 22 = 40.9% Wave 7 M2 landed!) completed, visually verified (360px/1440px Playwright), independently cross-family reviewed (`pi-claude-sonnet-5-5` via `ai-ask pi`), verified in `delivery-ledger`, merged, checkpointed, and pushed to `origin/main` (`b4fa649`):**
- **Wave 0–6 (85/85 — 100% M1):** All 85 M1 tasks including `TASK-063` Integration Checkpoint M1 (`086b018`, plus additive M2 migration forward-compatibility `36e9f2a`).
- **Wave 7 M2 Landed (9/22):** `TASK-074` (`5bc711e`, AI Writing Suggestions, `platform/0029`), `TASK-072` (`967f25b`, First-Party Insights, `tenant/0022`), `TASK-075` (`c1eb1e4`, Tenant MCP Server + OAuth 2.1 PKCE/RFC 8707, `platform/0030`), `TASK-073` (`09867a0`, Google Maps Review Link & GBP Checklist), `TASK-083` (`e9e95f6`, Agency/Reseller Portal & Agency-Payer Billing, `platform/0028`), `TASK-109` (`305ca89`, Optional AI Draft Step in Onboarding), `TASK-064` (`90c7567`, Content Revision History & Draft-Only Restore, `tenant/0023`), `TASK-110` (`7839fcf`, Monthly Owner Performance Report Email), `TASK-019` (`b4fa649`, Offline Gerai Multi-Outlet Directory & Consent-Gated Maps).
- **Clean Mainline (`b4fa649`):** `94/94` unit test files PASS, `0` typecheck errors across `682` files, `delivery-ledger verify` PASS.

## Next

1. **Wave 7 (M2 — 13 remaining of 22; 4 active in parallel!):**
   - Active in isolated worktrees (4): `TASK-105` (WhatsApp Support Entry Point), `TASK-084` (Affiliate Enrollment & Attribution, `platform/0031`), `TASK-020` (Travel & Umrah Itinerary / DEC-042 `SK PPIU`), `TASK-071` (Preferred Schedule Fields for Inquiries, `tenant/0024`).
   - Queued dependency chains (9): Verticals (`TASK-035` -> `TASK-079` -> `TASK-066`), Affiliates (`TASK-085` -> `TASK-086`), Plugins (`TASK-098` -> `TASK-099`, `TASK-100`, `TASK-101`).
2. **Wave 8 (`TASK-078` ASVS L2 / ZAP / BOLA -> `TASK-038` Full Production Release Gate M1+M2).** (`TASK-062` deferred to Release 1.1 per DEC-035 C16.)

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
