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

Foundation Spine (`F0`–`F4`) and Wave 2 Closing Batch A (`TASK-045` Cloudflare SaaS Topology & `TASK-049` Platform Grant/Bootstrap/Audit, `RUN-20261122T180337Z-af4e28aa`) implemented via 2 parallel child worktrees (`w2-topology`, `w2-platform-ops`). `TASK-045` adds declarative Cloudflare two-zone SaaS topology (`infra/cloudflare/topology.json`, `wrangler.jsonc` `preview_urls: false`, `Markdown for Agents` on / Free Bot Fight Mode off, O2O + `workers.dev`/preview 404 verification, `scripts/verify/routes.mjs`, `docs/operations/hosting.md`). `TASK-049` adds verified-account operator bootstrap, live session + active grant guard, atomic `platform_audit` + state rollback on audit failure, concurrent final-operator revocation protection, `scripts/platform-operator.mjs`, and `docs/operations/platform-access.md`.

## Next

Complete independent cross-family R3 review and `delivery-ledger finish` for `TASK-045` + `TASK-049`, commit/push to `main`, then finish Wave 2 security gates (`TASK-067` Operator Mandatory 2FA -> `TASK-090` Primary Google Sign-In & Turnstile) and fan out M1 feature waves in parallel.

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
