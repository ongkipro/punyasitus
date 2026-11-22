# Status — punyasitus

Updated: 2026-11-23
Status: Active
State: IMPLEMENTING
Review-Risk: R3
Independent-Review: PENDING
Primary-Worker: agy-supervisor
Independent-Reviewer: UNSET
Independent-Review-Head: UNSET

## Now

Foundation Spine (`F0`–`F4`) and Wave 2 Closing (`TASK-045`, `TASK-049`, `TASK-067`, `TASK-090`) are implemented. `TASK-090` (`REQ-090`, `DEC-045`, `PLAN §4, §6, §17.2`, `DESIGN §4`) wires primary Google Sign-In (`Masuk dengan Google`) via Better Auth `1.7.27` `socialProviders.google` (with OIDC `iss`/`aud`/`exp` claim validation), strict verified-only account linking (anti-pre-hijacking `403 UNVERIFIED_EMAIL_ACCOUNT_LINK_DENIED`), `console.punyasitus.com` `CONSOLE_GOOGLE_ALLOWLIST` + active `platform_operators` enforcement (`403` + sanitized `platform_audit`, preserving `TASK-067` mandatory TOTP), live `DEC-045` idle and absolute session timeout ceilings with D1 revocation (tenant 8h/7d, agency & affiliate 60m/12h, superadmin/console 30m/8h), fail-closed action-bound Cloudflare Turnstile Siteverify + accessible honeypot guards (`@punyasitus/core/security/turnstile`, wired to auth password routes; downstream `/api/leads` and `/api/abuse-report` routes adopt it in `TASK-012`/`TASK-039`/`TASK-086`), `TASK-067` hygiene fixes, and Bahasa Indonesia `base-nova` `/auth/login`, `/auth/register`, and `/auth/reset-password` screens.

## Next

Complete independent cross-family R3 review and `delivery-ledger finish` for `TASK-090` to close Wave 2, then fan out M1 feature waves in parallel.

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
