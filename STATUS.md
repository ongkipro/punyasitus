# Status — punyasitus

Updated: 2026-11-24
Status: Active
State: IMPLEMENTING
Review-Risk: R3
Independent-Review: PASS
Primary-Worker: agy-supervisor
Independent-Reviewer: pi-claude-sonnet-5-5
Independent-Review-Head: 086b018

## Now

**85 / 110 roadmap tasks (77.3% total; 85 / 85 = 100.0% of Phase 1 M1 COMPLETE — Wave 0 through Wave 6 100% landed!) completed, visually verified (360px/768px/1440px Playwright), independently cross-family reviewed (`pi-claude-sonnet-5-5` via `ai-ask pi`), verified in `delivery-ledger`, merged, checkpointed, and pushed to `origin/main` (`086b018`):**
- **Wave 0–5 (84/84 — 100%):** All 84 M1 foundation, routing, auth, CMS, billing, theme, SEO, analytics, plugin runtime, and protection tasks merged & verified.
- **Wave 6 (`TASK-063` — 1/1 = 100% M1 Integration Gate, `086b018`, `REQ-041`, R3):** SHA-pinned `.github/workflows/ci.yml` (`actionlint` PASS), `scripts/verify/m1-gate.mjs` (per-job `contents: read`, broadened secret & deploy guards), `tests/performance/m1-budget.mjs` (`3.52 KiB` JS gzip, `17.66 KiB` assets, `504–596 ms` LCP; `M1-FU-08` cold CLS `0.1118` surfaced honestly), `tests/e2e-gate/m1-checkpoint.mjs` (`360`/`768`/`1440px`, `720x450 dpr=2` & `320x640` WCAG reflow, exact focus restoration, strict `404` A->B), and `docs/operations/release-checklist.md` (`DEC-030` non-release gate, `M1-FU-01..08` follow-up register, `EXT-01..10` `UNVERIFIED` external gates).
- **Clean M1 Mainline (`086b018`):** `85/85` unit test files (`809/809` tests) PASS, `73/73` `workerd` integration files (`375/375` tests) PASS, `0` typecheck errors across `617` files, `14.07 MiB / 64 MiB` Worker bundle (`77 ms` startup), `delivery-ledger verify` PASS.

## Next

1. **Wave 7 (M2 — 22 tasks, 0/22 landed — Batch M2-A in flight!):**
   - Active in isolated worktrees (4): `TASK-083` (Agency Portal, `platform/0028`), `TASK-072` (First-Party Insights, `tenant/0022`), `TASK-074` (AI Writing Suggestions, `platform/0029`), `TASK-075` (Tenant MCP Server, `platform/0030`).
   - Next M2 batches: `TASK-064`, `TASK-073`, `TASK-019` -> `020` -> `035` -> `079` -> `066`/`071`, `TASK-084` -> `085` -> `086`, `TASK-098` -> `099`/`100`/`101`, `TASK-105`, `TASK-109`, `TASK-110`.
2. **Wave 8 (`TASK-078` ASVS L2 / ZAP / BOLA -> `TASK-038` Full Production Release Gate).** (`TASK-062` deferred to Release 1.1 per DEC-035 C16.)

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
