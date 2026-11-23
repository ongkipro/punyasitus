# Status — punyasitus

Updated: 2026-11-23
Status: Active
State: IMPLEMENTING
Review-Risk: R3
Independent-Review: PASS
Primary-Worker: agy-supervisor
Independent-Reviewer: pi-claude-sonnet-5-5
Independent-Review-Head: f024858232dbc1ca4171eb852b679610bdccf94a

## Now

**75 / 110 roadmap tasks (68.2% total; 75 / 85 = 88.2% of M1) completed, visually verified (360px/1440px Playwright for UI tasks), independently cross-family reviewed (`pi-claude-sonnet-5-5` via `ai-ask pi`), verified in `delivery-ledger`, merged, checkpointed, and pushed to `origin/main` (`f024858`):**
- **Wave 0 (1/1 — 100%):** `TASK-023`
- **Wave 1 (5/5 — 100%):** `TASK-001`, `TASK-010`, `TASK-011`, `TASK-024`, `TASK-032`
- **Wave 2 (12/12 — 100%):** `TASK-002`, `TASK-025`, `TASK-028`, `TASK-029`, `TASK-030`, `TASK-031`, `TASK-037`, `TASK-045`, `TASK-049`, `TASK-067`, `TASK-077`, `TASK-090`
- **Wave 3 (16/16 — 100%):** `TASK-004`, `TASK-005`, `TASK-006`, `TASK-007`, `TASK-008`, `TASK-009`, `TASK-012`, `TASK-013`, `TASK-014`, `TASK-015`, `TASK-016`, `TASK-017`, `TASK-027`, `TASK-050`, `TASK-051`, `TASK-089`
- **Wave 4 (11/11 — 100%):** `TASK-055`, `TASK-048`, `TASK-026`, `TASK-059`, `TASK-056`, `TASK-003`, `TASK-058`, `TASK-057`, `TASK-095`, `TASK-081`, `TASK-082`
- **Wave 5 (30/39 landed — 76.9%):** `TASK-018`, `TASK-021`, `TASK-034`, `TASK-036`, `TASK-033`, `TASK-022`, `TASK-087`, `TASK-108`, `TASK-042`, `TASK-039`, `TASK-106`, `TASK-041`, `TASK-104`, `TASK-060`, `TASK-070`, `TASK-097`, `TASK-040`, `TASK-044`, `TASK-068`, `TASK-046`, `TASK-091`, `TASK-061`, `TASK-043`, `TASK-052`, `TASK-076`, `TASK-094`, `TASK-088`, `TASK-080`, `TASK-047`, `TASK-107`.
- **Paused cleanly (2026-11-23 21:02 WIB):** Zero open worktrees, zero running background jobs, `delivery-ledger verify` PASS, 75/75 unit test files PASS, synced with `origin/main`.

## Next

Resume Wave 5 Final Batch (only 9 Wave 5 tasks remaining!):
- Unblocked immediately (6): `TASK-069` (Terima Beres setup service), `TASK-092` (Blog authors/TOC), `TASK-053` (Local entity schema & crawlable content), `TASK-065` (Analytics event dedup M1), `TASK-093` (Six-theme catalog & onboarding checklist), `TASK-103` (Shared-domain protection & Trust+ watch).
- Final Wave 5 tail (3): `TASK-054` (SEO crawl regression, after `053`), `TASK-096` (Theme style variants & store, after `093`), `TASK-102` (`seo-ai-autopilot` plugin wiring, after `053` & `093`).
- Then Wave 6 (`TASK-063` M1 Integration Gate — also owns central `PLATFORM_MIGRATIONS`/`TENANT_MIGRATIONS` registration + `tests/task-001` checksum update + `<AnalyticsHead />` & `SectionBranches` mounting), Wave 7 (M2), and Wave 8 (Security Assurance & Production Release Gate). Next migration numbers: `platform/0024_...sql`, `tenant/0018_...sql`.

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
