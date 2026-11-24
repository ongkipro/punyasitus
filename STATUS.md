# Status — punyasitus

Updated: 2026-11-24
Status: Active
State: INTEGRATING
Review-Risk: R3
Independent-Review: PASS
Primary-Worker: agy-supervisor
Independent-Reviewer: pi-claude-sonnet-5-5
Independent-Review-Head: 5a5ad9c

## Now

**109 / 110 roadmap tasks (99.1% total — 100.0% of all M1 + M2 Launch Scope!) + Pre-Live Security & CLS Hardening Batch (`SEC-001..SEC-006`, `M1-FU-03`/`07`/`08`) completed, visually verified (360px/768px/1440px Playwright), independently cross-family reviewed (`pi-claude-sonnet-5-5` via `ai-ask pi`), verified in `delivery-ledger`, merged, checkpointed, and pushed to `origin/main` (`5a5ad9c`):**
- **Wave 0–6 (85/85 — 100% M1):** Complete core multi-tenant SaaS platform (`TASK-063` M1 Integration Checkpoint `086b018`).
- **Wave 7 (22/22 — 100% M2):** Complete M2 verticals, AI writing/onboarding, Insights, Tenant MCP + OAuth 2.1, Agency Portal, Affiliate program, Plugin Store, Vehicle Showroom, M2 Vertical Presets, and all 5 Frozen-Core official plugins (`seo-ai-autopilot`, `bio-links`, `wa-cs-rotator`, `wp-importer`, `lead-notifier`).
- **Wave 8 (2/2 — 100% Security & Release Gates):** `TASK-078` (`5faaa13`, R3 — OWASP ASVS 5.0 L2, 375-route surface enumeration, `workerd` BOLA suite, hardened `.github/workflows/security.yml`) and `TASK-038` (`65439cb`, R3 — Full Production Release Gate M1+M2, 5-run mobile lab, 12-route No-JS + Schema.org E2E gate, standalone SQLite + `workerd` product-code backup/restore & `DEC-022` tombstone replay proof, `.github/workflows/release-gate.yml`, valid `RELEASE.md`).
- **Pre-Live Hardening Complete (`5cb5de1`, `1da5819`, `04e885a`, `5a5ad9c`):** Resolved all 6 tracked security findings (`SEC-001` dashboard publish screening on `pages`/`posts`/`catalog`/`identity`, `SEC-002` exact-`Origin` streaming media upload CSRF, `SEC-003` baseline HTML & JSON `nosniff`/`Referrer-Policy`/`X-Frame-Options`/platform CSP, `SEC-004` console affiliate CSV 2FA step-up + truncation headers, `SEC-005` central `/api/agency`+`/api/affiliate`+`/api/onboarding` CSRF prefixes, `SEC-006` per-response 128-bit CSP nonces with zero `'unsafe-inline'` in `script-src` + warm cache-HIT nonce rotation) and `M1-FU-08` (compositor-only `FloatingWhatsApp` transform eliminating cold mobile CLS `0.1118 -> 0.0000`). **Waiver permanently removed from CI & `tests/task-038/e2e.mjs`!**
- **Clean Mainline (`5a5ad9c`):** `110/110` unit test files (`1,098/1,098` tests PASS), `0` typecheck errors across `750` files, `0` built-Worker DAST header/CSP alerts (`run-security-suite.mjs` `PASS`), strict zero-waiver 5-run mobile lab `CLS p50=0 / p95=0 / max=0`, `LCP p50=508ms`, `JS 3.52 KiB`, `spec:check` + `lint` + `actionlint` (4/4 workflows) + `release-manifest` `VALID` + `rollback-check` `PASS`.

## Next

1. **External Staging, Provider & Legal Gates (`EXT-01..EXT-10` — ONLY remaining pre-launch gates):** Execute only with explicit owner authorization against live Cloudflare Workers Paid, SaaS zone (`situsku.click` DCV/O2O/Trust+), Google OAuth, Cloudflare Email Sending (`notif.punyasitus.com`), AutoLaris relay, Indonesian legal/PSE/UU PDP review (`DEC-047`), CI Firefox/WebKit matrix run, and staging ZAP full scan.
2. **Optional Pre-Staging Polish (Non-Blocking):** `M1-FU-01`, `M1-FU-02`, `M1-FU-04`, `M1-FU-05`, `M1-FU-06`, and secondary publish routes noted in `docs/security/findings-register.md` §1.1.
3. **Release 1.1 (`TASK-062`):** Owner Redirect Manager & 404 Monitor remains explicitly deferred to Release 1.1 per `DEC-035 C16`.

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
