# Status — punyasitus

Updated: 2026-11-22
Status: Active
State: PLANNED
Review-Risk: R0
Independent-Review: PENDING
Primary-Worker: UNSET
Independent-Reviewer: UNSET
Independent-Review-Head: UNSET

## Delivery state machine

Allowed forward path:

`PLANNED -> READY -> IMPLEMENTING -> VERIFYING -> REVIEWING -> INTEGRATING -> PRODUCTION_READY -> AWAITING_DEPLOY_APPROVAL -> DEPLOYED -> SMOKE_TESTING -> VERIFIED`

Use `BLOCKED` only as an interruption state. Record the blocker and exact state to resume. Do not skip verification/review/integration states. `production-gate` proves the transition from `INTEGRATING` to `PRODUCTION_READY`; it never deploys.

`RELEASE.md` owns release-specific truth: release ID, base, declared risk, rollback reference/command, backup proof, and readiness status. `Review-Risk` is the highest semantic risk found during review. `production-gate` computes effective release risk as max(`RELEASE.md` Declared-Risk, deterministic `diff-risk`, `Review-Risk`). R3/R4 require `Independent-Review: PASS`, a reviewer distinct from `Primary-Worker`, and `Independent-Review-Head` bound to the reviewed release content. Only review-attestation files may change after that commit.

`OBSERVABILITY.md` owns post-deploy verification probes. After deployment, transition to `SMOKE_TESTING` and run `release-check`. Every configured observability probe must pass before transition to `VERIFIED`.

## Current state

Restarted from zero on 2026-11-17 by Paduka Ongki (`DEC-033`). Old September 2026 worktrees, database volume, and stale `.delivery` (`volumcms-v2` `RUN-20260925...`) artifacts have been removed/reset after full backup (a local owner backup (location in the private history repository)). Every task in `TASKS.md` (`TASK-001` through `TASK-110`, organized into Wave 0 -> Wave 8) is unstarted (`State: PLANNED`).

Specification consolidation, Cloudflare alignment & Frozen-Core Theme/Plugin ecosystem **complete** (2026-11-18):

- **`DEC-035` (Merged PunyaSitus + CMSPRO):** All 20 conflict answers (`C1..C20`) and CMSPRO capabilities are unified into `PRD.md`, `PLAN.md`, `DESIGN.md`, and `TASKS.md`.
- **`ADR-0009` & `DEC-036` (100% Cloudflare `adsbook.id`-aligned runtime + `base-nova` UI):**
  - Two-tier 100% Cloudflare persistence: `PLATFORM_DB` (Cloudflare D1, 10 GB) + per-tenant `TenantStore` (SQLite Durable Object, 10 GB/site, `locationHint: "apac-se"`, `D1Database`-compatible RPC adapter, PITR bookmark migrations) — zero Supabase or external PostgreSQL, and **no 1-Worker-per-client overhead** (`caches.default` enabled, 3s fleet-wide updates).
  - Cloudflare for SaaS on `situsku.click` + Custom Domains on `punyasitus.com` (`punyasitus.com`, `app.punyasitus.com`, `console.punyasitus.com`) -> one Astro SSR Worker (`@astrojs/cloudflare`, `session: false`), Step 0 HTTP DCV pass-through, O2O create-before-CNAME, `<= 64`-char hostname check, HTTPS tenant-marker probe, and 7-day stale hostname reaper (`punyasitus-*` resource prefix isolation).
  - Media & PDFs: R2 + Cloudflare Images binding (`<= 5 MB` JPG/PNG/WebP/HEIC/GIF/TIFF + client-side AVIF conversion; BMP & SVG rejected) + scale-to-zero `VideoTranscoder` Cloudflare Container (`ffmpeg` for MOV/WebM, JS box rewrite for H.264 MP4) + `pdf-lib` receipts + stateless static-IP AutoLaris relay.
  - Admin UI locked to **`shadcn/ui` v4 preset `base-nova`** (`@base-ui/react` only, `rsc: false`, `render` prop composition, zero Radix/`asChild`, Lucide, Tailwind v4) with desktop sidebar and `< 768px` 5-slot mobile web-app bottom-bar shells.
- **`ADR-0010`, `DEC-037` & `DEC-038` (B2B Compro Compass, Cloudflare Email Primary, Frozen-Core Themes & Plugins):**
  - Clear B2B Compro positioning: corporate profiles, sales compro & personal branding, travel/Umrah agency showcase (**not** an OTA or ticketing engine), offline multi-branch compro, and catalog-to-WhatsApp sites, plus Landing Page Focus Mode (`REQ-008`), optional Indonesian licences (`REQ-091`), and viral/affiliate footer badge (`REQ-084`).
  - Outbound transactional mail uses **Cloudflare Email Service (`env.EMAIL.send()` on Workers Paid: 3k free/mo + $0.35/1k, $0 fixed fee)** as primary behind `EmailPort` (Resend fallback, `REQ-077`).
  - Dedicated **`Tema`** and **`Plugin`** top-level sidebar menus with symmetric **Gratis**, **Berbayar (Store)**, and **Custom Dev (`custom_theme` & `custom_plugin`)** tiers, shipping 5 official Frozen-Core plugins (`seo-ai-autopilot` Zero-Config SEO & AI Indexing `DEC-039`, `bio-links`, `wa-cs-rotator`, `wp-importer`, `lead-notifier` with 1-click Telegram linking; `REQ-096..102`, `TASK-096..102`).
- **`DEC-042` & `DEC-043` (gap review 2026-11-18):** spec contradictions fixed (pillar P1, receipt email, owner new-lead email, Umrah gate, `seo-ai-autopilot` pre-installed, planned probes) and eight trust/support/retention items added as `REQ-103..REQ-110` / `TASK-103..TASK-110` (shared-domain protection, help center, WhatsApp support, status page and staged releases, export and deletion, QR codes, AI onboarding draft, monthly report).
- **`DEC-044` (repository split, 2026-11-22):** research, the frozen CMSPRO archive, the static HTML prototype and `MERGE-CMSPRO.md` moved to the private repository `punyasitus-docs` (`~/Projects/punyasitus-docs`, byte-identical copy verified with `diff -r`). This repository keeps code plus the whole development contract and is intended public; module boundary READMEs mark the TASK-023+ layout (no code, no dependencies).
- Validation: `python3 scripts/check-spec.py` -> `110 requirements; 110 tasks; 44 Markdown files; 0 structural errors`; `python3 scripts/test-check-spec.py` -> `12/12 OK` (adds an M1-must-not-depend-on-M2 check).

## Active work

None (`State: PLANNED`). Ready to start `TASK-023` (*Workspace Bootstrap & Runtime Compatibility Spike*) upon explicit owner authorization to begin development.

## Blockers

- **Development authorization** from Paduka Ongki before scaffolding code (`TASK-023`).
- **Remaining non-blocking M2 / pre-launch items:** AI writing provider selection (`TASK-074`, M2) and staging/production infrastructure & legal gates in `PLAN.md` §1 (Cloudflare `punyasitus-*` provisioning, Trust+ IP check on `situsku.click`, Google OAuth credentials, Cloudflare Email Service DNS on `notif.punyasitus.com`, Telegram `@BotFather` token for `lead-notifier`, AutoLaris merchant & static-IP relay whitelist, Terms/Privacy/PSE/PKP checks — none of these block local `workerd` development).

## Pending live verification

These were researched against official documentation on 2026-11-18 (see `BUILD-LOG.md`), but reading cannot prove them. Each is proven only by a live run with a real test domain and a real Cloudflare account. Until then, treat them as unverified and do not claim them in sales or launch material.

| Item | Why reading is not enough | Proven by | Needs |
|---|---|---|---|
| Certificate issuance through the Worker (HTTP DCV pass-through, zero-downtime migration with pre-issued certificate) | Cloudflare does not document how an originless Worker fallback passes validation paths through; `return fetch(request)` is an assumption also carried by `adsbook.id` | `TASK-023` spike, `TASK-045`, `TASK-003` | A disposable test domain, the staging SaaS zone with its own fallback origin |
| O2O with a real customer Cloudflare zone (routing, `301` primary redirect, interaction with the customer's own redirect rules) | Two zones run in sequence; behavior depends on the customer's zone settings, which no document can predict | `TASK-045`, `TASK-039` | A second Cloudflare account acting as the customer, with a proxied CNAME |
| Cloudflare Email Sending delivery (inbox placement, SPF/DKIM/DMARC alignment, behavior while the product is in beta) | Deliverability depends on reputation and receiving providers; the product is in public beta | `TASK-077` staging send | `notif.punyasitus.com` onboarded to Email Service; test inboxes at Gmail, Outlook and an Indonesian provider |
