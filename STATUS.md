# Status — punyasitus

Updated: 2026-11-22
Status: Active
State: IMPLEMENTING
Review-Risk: R2
Independent-Review: PENDING
Primary-Worker: agy-supervisor
Independent-Reviewer: UNSET
Independent-Review-Head: UNSET

## Now

Wave 0 (`TASK-023`, `19c2b0a`), Wave 1 Batch F1-A (`TASK-001`, `TASK-024`, `TASK-010`, `TASK-011`, `d6da1f5`), and Wave 1 Batch F1-B (`TASK-032`, `RUN-20261122T155522Z-30652a5c`) implemented. `TASK-032` locks `apps/web/components.json` to `shadcn/ui` v4 preset `base-nova` (`@base-ui/react` only, `rsc: false`, `lucide`, zero `@radix-ui/*` / `asChild` enforced in `scripts/dev/lint.mjs`), semantic Tailwind v4 tokens (`apps/web/src/styles/admin/globals.css`), `DashboardLayout.astro`, `ConsoleLayout.astro`, responsive `AdminShell` (256px desktop sidebar <= 9 items, 48px tablet icon rail, 5-slot mobile bottom bar + accessible Base UI `Sheet` drawer, agency client-context bar, mandatory Console Operasional Platform identity), lifecycle banners (`trial`/`grace`/`locked`/`suspended`), state panels (`loading`, `empty-first-run`, `empty-filtered`, retryable `error` preserving input, `permission-denied`, `409` conflict), and dev-only isolated synthetic fixtures (`/_dev/design-fixtures/*`, excluded from production `dist/`).

## Next

Obtain Product Owner visual ACC on `TASK-032` (`DESIGN.md` + 360/768/1440px rendered fixtures) and merge `feat/task-032` to `main`, then execute Foundation Step F2 (`TASK-028` Queues/Cron & `TASK-002` Host Routing Middleware) in parallel.

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
