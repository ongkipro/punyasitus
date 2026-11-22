# Build Log — punyasitus

Record only durable implementation changes, validation evidence, and gotchas that the next maintainer needs. Temporary task narration belongs in neither this file nor global memory.

## 2026-09-26 — Development contract initialized

- Added repository-local project context files.
- Bootstrap source state: native generator: none.
- Selected stack: `Existing repository (detected by project-check)`; database: `none`; authentication:
  `none`; deployment target: `none`.
- Capability selections are not operational claims. Their implementation and
  verification remain future requirement-linked work.

## 2026-09-26 — Specification pack promoted

- `project-init --repo . --stack existing-repository --package-manager pnpm --no-install --from-docs <filtered stage>` promoted PRD.md, PLAN.md, TASKS.md and ADR-0001..0007; SHA-256 of the filtered copy matched the staged files before promotion.
- DESIGN.md and scripts/check-spec.py, scripts/test-check-spec.py copied from staging (destination absent). Staged DECISIONS.md merged into the repository register by ID (ADR rows plus DEC-005..DEC-014); staged README content merged into README.md and AGENTS.md.
- Repository headers updated: repository copy is canonical; staging folder is a non-authoritative snapshot. PRD title no longer says "Edge" or "Commerce".
- Checks: `python3 scripts/check-spec.py` 65 requirements, 61 tasks, 0 structural errors; `python3 scripts/test-check-spec.py` 9 tests pass.
- Gotcha: `project-init --stack existing-repository` accepts only database/auth/deploy `none`; actual choices are recorded in DECISIONS.md and ARCHITECTURE.md instead.
- Gotcha: whole-folder `--from-docs` rejects DESIGN.md; promote a filtered core+ADR copy and copy companions separately.

## 2026-09-26 — Global specification audit

- Three read-only audits (cross-document consistency, scope/over-engineering, technical correctness) produced ~90 findings; verified findings were applied to PRD, PLAN, TASKS, DESIGN, ADRs and repository docs. Over-engineering findings were reported to the product owner for decision rather than cut.
- Verified external limits used (retrieved 2026-09-26): Cloudflare for SaaS custom origin sends the customer hostname as Host and SNI, SNI rewrite and apex proxying are Enterprise features (developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/ and .../start/advanced-settings/custom-origin/); R2 presigned POST is unsupported and single PUT allows up to 5 GiB (developers.cloudflare.com/r2/api/s3/presigned-urls/, /r2/platform/limits/); Astro checkOrigin covers only form content types (docs.astro.build/en/reference/configuration-reference/); Better Auth Astro handler path and organization membershipLimit (better-auth.com/docs/integrations/astro, /docs/plugins/organization).
- Added: docs/themes/THEME-DEVELOPMENT.md, PLAN section 15.7 (WordPress + AIOSEO parity), REQ-066/067, TASK-062, DEC-015..017, platform_settings, domain-separation gate.
- Checks: `python3 scripts/check-spec.py` 67 requirements, 62 tasks, 0 structural errors; `python3 scripts/test-check-spec.py` 9 tests pass.
- Product decisions after the audit: separate admin domain (DEC-018), M1/M2 split with company-profile pilot and slimmer per-task test matrix (DEC-019, TASK-063..066), immediate trial lock (DEC-020). Final check: 67 requirements, 66 tasks, 0 structural errors; 9 checker tests pass.

## 2026-09-26 — Renamed to PunyaSitus

- Product renamed from VolumCMS-V2 to PunyaSitus; repository moved from `~/Projects/volumcms-v2` to `~/Projects/punyasitus` and the staging snapshot from `~/Documents/work/prd/volumcms-v2` to `~/Documents/work/prd/punyasitus`. Domains: admin `app.punyasitus.com`, tenant subdomains `*.situsku.click`.
- `.delivery/` ledger history (bootstrap run) still records the former project name `volumcms-v2`; ledger files are tool-owned and were not hand-edited.
- The older draft `~/Documents/work/prd/volum-cms/` (2026-09-24) is a superseded predecessor and was left untouched.


## 2026-11-14 — Consistency review and prototype alignment

- Independent read-only review (reviewer agent, GPT-6.1 Sol) of all canonical documents and the `docs/html/` prototype: 28 findings plus 2 proposals. Applied:
  - AGENTS.md: root PRD.md is canonical (removed the nonexistent `docs/spec/02-PRD.md` pointer).
  - PRD: NG-7 narrowed per DEC-016; REQ-019 widget uses configured availability text, no live-presence badge; OG budget unified at 300 KiB.
  - PLAN: production gate is TASK-063 (M1) or TASK-038 (M2); quota reserves the declared source length and counts source bytes only (999 MB + 1 MB case); one Origin policy for public POSTs (present/null/missing); `content_modified_at` separates published lastmod from `updated_at`; redirect exclusions now point to REQ-067; proposals for operator MFA (section 13) and abandoned-tenant retention (section 17.4).
  - DECISIONS: ADR-0006 status clarified; new Open decisions table.
  - DESIGN: slug-change copy says 308 while published; video scope is decided; base tariff is accepted.
  - TASKS: allowed paths fixed for TASK-025/032/033/060/064/065; M1 TASK-053 limited to company-profile routes with vertical schema checks moved to TASK-019/020/035 and rerun by TASK-038; account management, owner transfer, second paid website and Origin cases added; TASK-043/044 renamed to their M1 scope; stray constraints removed from TASK-010/034.
  - `docs/html/`: renamed VolumCMS-V2/volum.app to PunyaSitus/situsku.click/punyasitus.com; fixed `../../` links; added a non-authoritative status and known-deviation table; removed the PPN line; no-refund and synthetic-fee copy; channel switch recalculates the total; Advice check replaces the invented webhook; DNS guide defaults to www with provider-derived values (no apex CNAME); signup verifies email first and defaults to the M1 company-profile preset; lead form has named fields, POST target and a success state; SEO limits are advisory; Plus Jakarta Sans replaces Inter.
- Checks: `python3 scripts/check-spec.py` 67 requirements, 66 tasks, 0 structural errors (was 4 broken links from `docs/html`); `python3 scripts/test-check-spec.py` 9 tests pass. Browser smoke (agent-browser, local http.server) on billing, domains and the public form: no page errors, total updates per channel.
- Not done: the prototype's neutral grey palette and 64px header still differ from DESIGN.md (listed in `docs/html/README.md`, resolved in TASK-032).
- External fact recheck (2026-11-14): the delegated researcher lane failed with a tool error and left no report; key claims were read directly from official pages and recorded in PLAN section 10. Changed: Google FAQ rich result discontinued 2026-05-07 (PRD REQ-022 and PLAN 15.4 now say FAQPage is semantic only); Astro checkOrigin now uses Sec-Fetch-Site. Confirmed: Cloudflare for SaaS plan limits, R2 presigned/limit facts, Better Auth membershipLimit/invitation default, Core Web Vitals thresholds, wa.me format. Unknown: WhatsApp 300 KB preview rule. Not checked: UU PDP, competitor pricing.

## 2026-11-14 — Operator MFA and locked-tenant retention decided

- DEC-021: mandatory 2FA for platform operators (Better Auth `twoFactor`, TOTP plus backup codes; plugin existence and default sign-in-route enforcement verified at better-auth.com/docs/plugins/2fa). Added REQ-068, TASK-067, PLAN section 13 contract.
- DEC-022: locked-tenant retention 30 days (never paid) and 60 days (had paid; owner changed the proposed 90 to 60), reminders, owner leads CSV export, tombstone on restore, 30-day handle cool-down. Added REQ-069, TASK-068, PLAN section 17.4 table; DESIGN locked-owner row; NG-7 notes the single export exception.
- TASK-063 now depends on TASK-067 and TASK-068.
- Checks: `python3 scripts/check-spec.py` 69 requirements, 68 tasks, 0 structural errors; `python3 scripts/test-check-spec.py` 9 tests pass.

## 2026-11-14 — Second review round (lifecycle and privacy)

- Two reviewer runs (GPT-6.1 Sol): a diff review (BLOCK: 2 High, 4 Medium, 4 Low) and a repository-only privacy/pricing inventory (5 P1 pre-pilot gaps, 3 P2). The second reviewer had no web tool; legal and market facts were read by the parent session.
- Fixed: offboarding is serialized under the tenant entitlement lock with an irreversible claim and explicit blocking payment states; operator holds pause the retention clock and release resumes it with at least 14 days; `locked_at` formulas per case (trial end, no-trial provisioning, paid_through + 72 h); leads CSV export added to the lockout allowlists in PRD REQ-005/REQ-060 and PLAN 17.4; section 5 deletion rule now names DEC-022 offboarding; ordinary lead/trash/backup retention continues while locked and "restore" means retained data; deletion reminders added to the 17.5 notification list; TASK-068 paths cover entitlement, billing, middleware and dispatch; TASK-029 Origin matrix covers Sec-Fetch-Site; TASK-025 points to PLAN 11.2; stale FAQ eligibility line updated; REQ-065 limits are unconditional; "monthly" wording replaced by 30-day.
- Privacy: PLAN section 5 now lists UU 27/2022 obligations from the official text (Art. 46 breach 3 x 24 h, Art. 30/32/40/41 request deadlines, Art. 51-52 processor duties, Art. 53 DPO, Art. 56 transfers, Art. 74 transition) with role allocation as a Proposal; TASK-031 documents the request procedure, breach runbook and subprocessor/location register. PP 33/2026 (effective 2027-01-16, agency not yet formed) and the UU KUP 10-year bookkeeping retention are from secondary sources and stay open for the privacy/tax review.
- Market desk check (vendor self-description): Hostinger Website Builder Rp23,900/month promo for 48 months, renews Rp84,900; Hostinger Single Rp12,900 promo, renews Rp54,900 (Niagahoster now redirects to Hostinger); Johan Software done-for-you company profile Rp150,000/month without setup fee; GoSocial from Rp75,000/month with 50% deposit. No product decision taken.
- Checks: `python3 scripts/check-spec.py` 69 requirements, 68 tasks, 0 structural errors; `python3 scripts/test-check-spec.py` 9 tests pass.

## 2026-11-14 — Trial, storage location, data roles; value research

- DEC-023 trial 7 days (PRD, PLAN, TASKS, DESIGN, README, prototype; grace stays 72 hours; trial reminders at 3 days and 24 hours). DEC-024 single-location storage, billing records 10 years, no separate in-country archive. DEC-025 controller/processor roles.
- Value-proposition research (researcher agent, report kept in the session artifacts; vendor pages are self-description): BPS Statistik E-Commerce 2024 via Kemendag shows only 1.36% of online-selling businesses use a website versus 94.76% instant messaging; Google ended Business Profile websites in 2024. Candidate gaps listed for owner decision; nothing added to scope yet.
- Checks: `python3 scripts/check-spec.py` 69 requirements, 68 tasks, 0 structural errors.

## 2026-11-14 — Approved value additions, easy GTM, MCP server

- DEC-026 (owner approved B, D, F, G, H, J): REQ-070 Terima Beres setup service (TASK-069, M1), REQ-071 domain/email guide (TASK-070, M1), REQ-072 schedule fields (TASK-071, M2), REQ-073 first-party insights (TASK-072, M2), REQ-074 Google Maps review link (TASK-073, M2), REQ-075 AI writing (TASK-074, M2; provider/quota is an open decision).
- DEC-027: GTM is a tenant-owned, easy-setup option in M1 (owner clarified: make GTM setup easy for clients). REQ-027 and NG-6 amended; PLAN 18.1; TASK-076 with container template under docs/gtm/; ADR-0006 item 5 marked superseded; TASK-065 reduced to event dedup.
- ADR-0008: remote MCP server for customer AI agents (REQ-076, TASK-075, M2). Verified 2026-11-14: ChatGPT custom MCP servers (OAuth, SSE/streaming HTTP), Claude custom connectors (OAuth or static credential), Grok custom connectors (public URL; auth not documented), MCP OAuth 2.1 + RFC 9728, Better Auth MCP plugin (OAuth 2.1 provider, DCR off by default, CIMD recommended), GTM container import (Overwrite/Merge), Cloudflare Email Routing requires Cloudflare DNS.
- Checks: `python3 scripts/check-spec.py` 76 requirements, 76 tasks, 0 structural errors; `python3 scripts/test-check-spec.py` 9 tests pass.
- DEC-028 AI writing quota 100 suggestions per website per 30 days (provider still open); DEC-029 ADR-0006 items 2-4 accepted (ADR-0006 status, PLAN, PRD, TASKS, ADR-0001/0003/0005 notes updated).

## 2026-11-14 — Third review round (two model families)

- Reviewers: GPT-6.1 Sol (security/consistency, BLOCK: 3 High, 8 Medium, 1 Low) and Gemini 4 Carbon high (product/consistency, CHANGES REQUESTED: 5 High, 4 Medium, 2 Low, 3 M1-load proposals). Both independently found the stale 259,200-second trial constant and the MCP/OAuth versus admin Origin conflict.
- Fixed: trial constant 604,800 s; MCP/OAuth transport exception (bearer only, no session cookies, 404 on tenant hosts) in PLAN 2/4/18.3, AGENTS, ADR-0007 note; ADR-0008 OAuth hardening (RFC 8707 resource binding, code/redirect/PKCE binding, refresh rotation, CSRF-bound consent, CIMD SSRF limits, DCR off) and server-side publish approval instead of relying on tool annotations; Grok made conditional, live client checks moved to staging evidence with local conformance tests as the gate; GTM CSP profile with nonce and template vendors, owner risk acknowledgement, platform guarantees limited to platform-generated events, NG-6 reworded; insights source from `document.referrer` host plus UTM token, "Langsung / tidak diketahui" bucket, UTC storage, cookie-less pre-consent page_view, dedup key separation; schedule fields added to the section 6 lead schema with enumerated time bands and empty-token handling; AI writing PII block, plain-text output, failed calls free, trailing 720 h quota, locked denial, provider terms; setup service owner-approved staff editor, removal on every terminal state, no theme grant for setup; Google Maps URL host+path rules; task boundaries (TASK-065 depends on TASK-076 and lost stale platform paths, TASK-069/070/072/073/076 paths, deps and risk); DECISIONS evidence pointers, ADR index wording and order; Indonesian UI strings; README open-decision note; PRD revision date.
- Not applied (owner decision): proposals to move TASK-068 offboarding job, TASK-069 setup service or TASK-076 GTM from M1 to M2.
- Checks: `python3 scripts/check-spec.py` 76 requirements, 76 tasks, 0 structural errors; `python3 scripts/test-check-spec.py` 9 tests pass.

## 2026-11-14 — Full development instead of pilot (DEC-030)

- Owner: the goal is full development, not MVP/pilot. P1 (TASK-068), P2 (TASK-069) and P3 (TASK-076) stay in M1; TASK-065 moves to M1 with GTM. TASK-063 renamed to an internal phase 1 checkpoint; TASK-038 is the single production release gate. "Pilot" gates renamed to pre-launch/production-launch in PLAN, PRD, TASKS, DECISIONS, README, STATUS and ADR-0008. Historical PRD section 8 roadmap and accepted ADR-0007 wording left unchanged.

## 2026-11-14 — Whole-pack review after DEC-030

- Reviewers: GPT-6.1 Sol (launch readiness: BLOCK, 11 P1 + 4 P2) and Gemini 4 Carbon high (delivery plan: DAG valid, critical path 14 tasks, 25+ execution blockers, PRD fragmentation, 6 product gaps, 6 owner decisions).
- Fixed defects: TASK-065 in M1 in PLAN data model; admin navigation list; automated tombstone replay; TouristTrip verification owner TASK-020; custom-hostname cleanup for never-paid tenants; PRD market-study and price-list statements; THEME-DEVELOPMENT handle URL; prototype signup verticals enabled; 20 tasks raised to R3 because they touch protected paths; middleware and workflows protected on every task; shared OpenAPI schema/nav allowance in the execution contract; TASK-067 ordered before platform mutation tasks with a reusable recent-2FA guard; vertical tasks gained schema/katalog paths and TASK-015/036 deps; email paths for TASK-061/076; ARCHITECTURE/OBSERVABILITY/RELEASE ownership (TASK-023/037/038) with a first-release rollback definition; broad paths narrowed on TASK-023/052/053/038/063; TASK-063 slimmed to a Chromium checkpoint, full matrix/performance/restore run once in TASK-038; DESIGN section 12 for 2FA, AI writing, consent, connected apps, publish approval and GTM screens.
- Open for owner decision (not applied): launch service commitments and VPS sizing, staging environment, capacity test, pre-launch security assessment, legal publications, billing activation/reconciliation monitoring, email provider and deliverability, support process, marketing site at punyasitus.com, help content, onboarding go-live flow, WordPress migration policy, trial custom domains, new-lead email alert, task splits and PRD restructuring.
- Checks: `python3 scripts/check-spec.py` 76 requirements, 76 tasks, 0 structural errors; `python3 scripts/test-check-spec.py` 9 tests pass.

## 2026-11-15 — Launch-readiness research

- Researcher agent (sources retrieved 2026-11-15): Resend pricing/regions/webhooks, Amazon SES ap-southeast-1 pricing, Postmark, Cloudflare Email Sending (beta, Cloudflare DNS required), Brevo; Vultr sgp plan prices and +20% automatic backups; Coolify minimum 2 CPU/2 GB and production separation advice; R2 lacks versioning/replication (S3 API compatibility table), bucket locks, lifecycle, event notifications, rclone; OWASP ASVS 5.0 L2 incl. 8.4.1 cross-tenant control; ZAP baseline/full scan; two Indonesian pentest price pages (vendor self-description); UU 27/2022 Art. 21, PP 71/2019 Art. 14/48/49, Permenkominfo 5/2020 Art. 2/3/7 PSE Lingkup Privat registration via OSS; Healthchecks.io, Better Stack, Uptime Kuma limits.
- Applied: PLAN section 1 gains PSE registration and legal publication gates; section 9 backup line corrected (no R2 versioning; rclone copy, lock, trash lifecycle); section 12 gains a researched launch-defaults table marked Proposal. Owner's 2026-10-28 cross-project email note (Resend, SES upgrade) reused.
- Owner 2026-11-15: PSE registration and legal publications deferred (not urgent); kept as production-launch gates in PLAN section 1 so they are not forgotten.
- DEC-031 Resend for PunyaSitus only (REQ-077, TASK-077 M1; TASK-025/059/063 depend on it). DEC-032 internal security assurance option A (REQ-078, TASK-078 M2; TASK-038 depends on it). Subprocessor lists updated with Resend.

## 2026-11-17 — Restart from zero, Cloudflare-native rework, CMSPRO merge

- Owner (Paduka Ongki): start from zero, remove the PunyaSitus development, research and perfect the documents first, rework multi-tenancy around Cloudflare for SaaS, and use CMSPRO to research and merge everything into PunyaSitus.
- Removed worktrees `~/Projects/punyasitus-dev` (`dev/m1`) and `~/Projects/punyasitus-dev-b` (`dev/m1-b`) and Docker volume `punyasitus-dev_punyasitus_pgdata` after backup to a local owner backup (location in the private history repository) (bundle verified). Uncommitted worktree changes were stashed first (stash@{0}, stash@{1}). Branch deletion was blocked by the safety guard and is left for explicit authorization. DEC-033.
- CMSPRO pack copied to `docs/archive/cmspro/` (spec, ADRs, decisions, tasks, NEXT, admin contract, 18 wireframes), its design research to `docs/research/cmspro/`, and the 2026-11-15 PunyaSitus research notes to `docs/research/market-and-migration/`. Adoption ledger `docs/MERGE-CMSPRO.md`. `scripts/check-spec.py` skips `docs/archive/`. DEC-034.
- Research `docs/research/2026-11-17-cloudflare-saas-runtime.md` (official Cloudflare, Astro, Better Auth docs retrieved 2026-11-17; AutoLaris docs in `~/Projects/autolaris-payment-gateway`). Blocking findings: AutoLaris whitelists at most 5 egress IPs and Workers have no static egress; D1 has no RLS and a 10 GB per-database cap; Workers cannot run ffmpeg; wildcard hostnames, custom metadata and apex proxying are Enterprise only.
- ADR-0009 proposed; DEC-005 and DEC-011 remux marked superseded on acceptance; ADR-0006/ADR-0007 carry amendment notes. PLAN sections 1, 2, 3, 9, 12 and 16, PRD stack and REQ-062, TASK-007/023/028/037/045/060 and every `apps/jobs` path moved to the Worker model. Video: ffmpeg remux replaced by a pure-JavaScript MP4 box rewrite so location metadata is still stripped (privacy).

## 2026-11-18 — Merged PRD (PunyaSitus + CMSPRO)

- Owner answers to conflicts C1..C20 (2026-11-15) and "CMSPRO features in scope now" recorded as DEC-035. PRD.md: vision and pillars P0..P6 (section 0), commercial terms and lifecycle rewritten (sections 14-15), REQ-010/012/013/016/018/019/020/024/029/043/049/056/058/059/060/062/064/067/069 amended, NG-2/NG-3/NG-7 adjusted, new section 18 with REQ-079..REQ-095 (vehicle type, tenant forms, receipts, yearly plan and coupons, agencies, affiliates and payouts, marketing site and funnel, branches, YouTube, Google sign-in, business profile, blog structure, onboarding, abuse queue and lead deletion, AI and search visibility).
- TASK-079 added as the planning task that owns synchronising PLAN/TASKS/DESIGN and breaking the new REQs into implementation tasks; sync notices placed at the top of PLAN.md, TASKS.md, DESIGN.md and THEME-DEVELOPMENT.md. README, STATUS, AGENTS and MERGE-CMSPRO updated; merge research note copied to docs/research/market-and-migration/.
- Checks: `python3 scripts/check-spec.py` 95 requirements, 79 tasks, 0 structural errors; `python3 scripts/test-check-spec.py` 9 tests pass. No independent review of this merge yet.

## 2026-11-18 — 100% Cloudflare (`adsbook.id`-aligned) runtime, `base-nova` UI & full spec sync (`DEC-036`)

- Owner (Paduka Ongki): approved aligning PunyaSitus's 100% Cloudflare multi-tenant SaaS & database architecture with `adsbook.id` (`~/Projects/adsbook.id-docs/docs/architecture/MULTI-TENANT-DESIGN.md`) with zero Supabase/external DB, plus Recommendation Package #2 (`shadcn/ui` `base-nova`, Cloudflare Images/Containers format rules, Cloudflare for SaaS O2O/DCV/probe/reaper hardening, stateless AutoLaris static-IP relay).
- Accepted `ADR-0009` and recorded `DEC-036` in `DECISIONS.md` (superseding the hosting/PostgreSQL/ffmpeg portions of `DEC-005` and `DEC-011`; clearing resolved open decisions D & E).
- Synchronized every canonical document and removed all temporary sync banners:
  - `PRD.md`: §6 Stack updated to `PLATFORM_DB` (D1) + `TenantStore` (SQLite Durable Object) + `VideoTranscoder` Cloudflare Container (`ffmpeg`) + `base-nova`; `REQ-001` physical DO isolation; `REQ-010` Cloudflare Images input formats (BMP & SVG rejected, AVIF converted client-side); `REQ-062` Worker MP4 box rewrite + scale-to-zero Container `ffmpeg` for MOV/WebM.
  - `DESIGN.md`: rewritten around `shadcn/ui` v4 preset `base-nova` (`@base-ui/react`, `rsc: false`, `render` prop, zero Radix), 4 host surfaces (`punyasitus.com`, `app.punyasitus.com`, `console.punyasitus.com`, tenant sites), desktop + `< 768px` 5-slot mobile web-app shells, 6 platform themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`), and the `DEC-035` billing/lifecycle matrix.
  - `PLAN.md`: synchronized §1–18 to `adsbook.id` D1 + `TenantStore` DO (`D1Database` RPC adapter, PITR bookmark migrations, `punyasitus-*` resource prefix, Trust+ check, Step 0 HTTP DCV pass-through, O2O, `<= 64`-char hostname rule, HTTPS marker probe, 7-day stale hostname reaper) + `DEC-035` commercial/lifecycle rules, and added §19 covering `REQ-079..REQ-095`.
  - `TASKS.md`: updated existing tasks to Cloudflare D1/`TenantStore`/Containers/`base-nova`/`console.punyasitus.com`/typed offerings and replaced the planning placeholder with 17 executable single-requirement tasks `TASK-079..TASK-095` wired into `TASK-063`, `TASK-078`, and `TASK-038`.
  - `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `docs/html/README.md`, `docs/themes/THEME-DEVELOPMENT.md`, and `docs/MERGE-CMSPRO.md` aligned to the same baseline.
  - Cleaned up stale September 2026 `.delivery` artifacts (`volumcms-v2` `RUN-20260925T172801Z-f1e032fc.jsonl` removed, `.delivery/current.json` reset to `punyasitus` `PLANNED`), hardened `.gitignore`, and added the **Ordered Development Waves (`Wave 0` -> `Wave 8`)** roadmap table to `TASKS.md`.
- Checks: `python3 scripts/check-spec.py` -> `95 requirements; 95 tasks; 40 Markdown files; 0 structural errors`; `python3 scripts/test-check-spec.py` -> `11 tests OK` (added automated R3 protected-path overlap and Release 1.1 gate separation invariants after full self-review & audit fixed stale `past_due` references in `REQ-005`/`PLAN.md`, a truncated line at `PLAN.md` §4->§5, R3 levels on `TASK-087/088/091/092`, `TASK-062` Release 1.1 gate exclusion, `TenantStore` RPC/bookmark rules, Better Auth per-request Workers rules, and `DECISIONS`/`ADR-0006/0007` amendment markers).

## 2026-11-18 — Frozen-Core Theme Store & Modular First-Party Plugin Ecosystem (`ADR-0010`, `DEC-037`)

- Owner (Paduka Ongki): approved the Frozen-Core extension model on the single shared Cloudflare Worker + per-tenant `TenantStore` DO (rather than 1 Worker per regular client via Workers for Platforms) so client-specific themes and bespoke functional features ship via Themes + Plugins without modifying base CMS code, and reusable plugins/themes can be shared free or sold as add-ons.
- Recorded `ADR-0010` (`docs/adr/ADR-0010-frozen-core-themes-and-modular-plugins.md`), `DEC-037` in `DECISIONS.md` (narrowing `NG-1` and `NG-5` / `DEC-026`), `docs/plugins/PLUGIN-DEVELOPMENT.md`, `PRD.md` §19 (`REQ-096..REQ-099`), `PLAN.md` §19.7, `DESIGN.md` §7 (Style Variants, Theme Store & Plugin Store UX), and executable tasks `TASK-096..TASK-099` in `TASKS.md`.
- Checks: `python3 scripts/check-spec.py` -> `99 requirements; 99 tasks; 42 Markdown files; 0 structural errors`; `python3 scripts/test-check-spec.py` -> `11 tests OK`.

## 2026-11-18 — B2B Positioning Compass, Cloudflare Email Service Primary, `wp-importer` & `lead-notifier` (`DEC-038`)

- Owner (Paduka Ongki): reinforced B2B positioning (Compro, Sales Compro, Personal Branding, Travel Agency showcase — never OTA/ticketing — Offline Compro, and Catalog closing to WhatsApp), approved dedicated `Tema` & `Plugin` sidebar menus (`Gratis` / `Berbayar` / `Custom Dev`), and asked to adopt Cloudflare Email Sending and evaluate 1-click Telegram lead webhooks + WordPress import.
- Verified official Cloudflare Email Service docs (`developers.cloudflare.com/email-service/`, updated Jun–Nov 2026): outbound `env.EMAIL.send()` is in public beta on Workers Paid (`3,000` emails/month included, then `$0.35 / 1,000` emails, Base64 attachments up to `25 MiB`, built-in suppression list). Adopted as primary `EmailPort` provider (`DEC-038`, amending `DEC-031`; Resend retained as optional fallback).
- Added Landing Page Focus Mode (`REQ-008`), contextual Indonesian licences (`REQ-091`), viral/affiliate footer badge (`REQ-084`), **7 primary-researched Zero-Guesswork B2B Conversion Blueprints** (`docs/research/cmspro/04-b2b-conversion-blueprints.md` -> `REQ-093`, `PLAN.md` §19.8, `TASK-093`), `REQ-100` / `TASK-100` (`wp-importer` safe draft importer) and `REQ-101` / `TASK-101` (`lead-notifier` 1-click Telegram bot linking + signed webhook).
- Checks: `python3 scripts/check-spec.py` -> `101 requirements; 101 tasks; 43 Markdown files; 0 structural errors`; `python3 scripts/test-check-spec.py` -> `11 tests OK`.

## 2026-11-18 — Zero-Config SEO & AI Indexing Packaged as Official Free Plugin `seo-ai-autopilot` (`DEC-039`)

- Owner (Paduka Ongki): decided after Google Search Central *Snippets* & Ghost / The SEO Framework research to package the entire SEO & AI Indexing engine (`sitemap.xml`, `robots.txt`, programmatic Blueprint meta/OG, Schema `@graph`, `IndexNow`, GBP + Bing Places copy card, and collapsed optional manual overrides) as the official free plugin **`seo-ai-autopilot` (`REQ-102`, `TASK-102`)** rather than mandatory default editor clutter — keeping base editors 100% clean when uninstalled and working 100% automatically with zero required settings on 1-click install.
- Checks: `python3 scripts/check-spec.py` -> `102 requirements; 102 tasks; 43 Markdown files; 0 structural errors`; `python3 scripts/test-check-spec.py` -> `11 tests OK`.

## 2026-11-18 — CNAME connect system (`DEC-040`)

- Owner asked for the CNAME system and a review. The base flow already existed (PLAN 3.1, TASK-003, TASK-039). Reading Cloudflare's pre-validation, zero-downtime-migration, Delegated DCV, TXT and HTTP pages showed the spec only used TXT as a repair step, so the promise "old site stays live until cutover" had no technical flow. Added PLAN 3.2 (three modes, cutover gate, renewal watch), REQ-043 and TASK-003/TASK-039 acceptance, DESIGN wizard row and domain gates. No new REQ or TASK. Not read: the DCV token validity page (recorded as a TASK-003 duty). Public Suffix List registration and per-zone fallback origin remain unverified.

## 2026-11-18 — Routing, state pages and account email (`DEC-041`)

- Owner clarified the topic was routing. Dotfiles hold no product email or auth code; the reference is `adsbook.id`. Read its gate, host, state-pages, seller-email, signup-verification, recovery and login code plus spec 08 section 7. Added PLAN 3.3 (routing order and state pages) and 17.4 (sender, no-blind-retry, code verification, three-layer recovery). Owner approved recovery in three layers and verification by code. Repaired one path damaged by an earlier bulk replace (`packages/db/src/platform/**`). Not verified: Cloudflare `send_email` restriction behavior beyond the docs excerpt already read, and whether `301` for host canonicalization matches Cloudflare for SaaS behavior on O2O hostnames.

## 2026-11-18 — Verification of open items from DEC-040 and DEC-041

Read from primary sources on 2026-11-18:
- Cloudflare `email-service/configuration/send-bindings`: `allowed_sender_addresses` confirmed; sends from other addresses fail with `E_SENDER_NOT_VERIFIED`; before domain onboarding only verified destination addresses work. Confirmed, no design change.
- Cloudflare `ssl/edge-certificates/changing-dcv-method/validation-backoff-schedule`: DCV token validity Let's Encrypt 7 days, Google Trust Services 14, SSL.com 14; retry `min(60*1.05^n s, 4 h)`; a custom-hostname `PATCH` with current `ssl` settings resets the backoff. Added to PLAN 3.2 and TASK-003.
- Cloudflare `saas-customers/how-it-works`: O2O runs the customer's zone first, then ours, and sets `cf-connecting-o2o: 1`; no restriction on redirect codes. `301` kept; residual risk is the customer's own redirect rules, covered by guidance and the HTTPS probe.
- Cloudflare API `custom_hostnames/fallback_origin` (`PUT /zones/{zone_id}/...`): fallback origin is per zone, one origin value. Staging needs its own SaaS zone. Confirmed.
- Public Suffix List wiki `guidelines`: PRIVATE section fits the use case, but projects not serving more than thousands of users are likely declined and two years of registration are required. The "breaking cookie/login functions" factor came from a search excerpt of the `Third-Party-Diffusion` page, not a full read. Changed the plan: no PSL dependency in v1. Corrected my first draft, which only stopped our server from setting `Domain=` cookies and missed client-side cookie tossing by a tenant's GTM script; the consent cookie now uses the `__Host-` prefix, which browsers refuse to set with a `Domain` attribute, and tenant-host code reads no other cookie (general web-security knowledge, RFC 6265bis cookie prefixes, not re-read this session).

Still unverified (needs a live run, not more reading): actual certificate issuance through the Worker, O2O behavior with a real customer zone, Email Sending delivery rates. These belong to TASK-023, TASK-045 and TASK-077.

## 2026-11-18 — Gap review, spec consistency fixes and trust/support/retention scope (`DEC-042`, `DEC-043`)

- Gap review written to `docs/research/2026-11-18-gap-review.md` (contradictions, system gaps, selling gaps, research and recommendations). The competitor-research subagent failed (provider unavailable); competitor evidence is limited to Hostinger, pusatweb and musiweb pages. `black-magic` was not used because no shipped binary or live app needed reverse engineering.
- `DEC-042` fixed six spec contradictions. `DEC-043` added REQ-103..REQ-110 and TASK-103..TASK-110 after the owner approved all eight researched items.
- New evidence: Katadata 2024-08-04 (WordPress.com and Weebly blocked over gambling subdomains, restored next day); CNN Indonesia 2026-11-04 (Kepmen Komdigi 127/128 of 2026: urgent content, 1 x 12 hour notification reply, 4-hour order deadline; decree text not read); `adsbook.id` runbook section 6 and `trust-watch.ts` (Trust+ IP list URL and daily watch); Jagoan Hosting normalisation guide; Cloudflare gradual deployments page (one Durable Object version at a time, `wrangler deploy` for DO migrations, last 100 versions); Wix Studio monthly client reports (30-session threshold).
- Caught my own ordering error before commit: TASK-105 and TASK-110 were M1 but depended on M2 tasks (TASK-083, TASK-072). Moved both to M2 and added a validator rule with a regression test, so this class of error now fails `check-spec.py`.

## 2026-11-22 — Repository split before development (`DEC-044`)

- Owner approved a hybrid split: code and the development contract stay in `ongkipro/punyasitus` (intended public); research and history go to a new private repository `punyasitus-docs`.
- Moved `docs/archive/`, `docs/research/`, `docs/html/` and `docs/MERGE-CMSPRO.md` to `~/Projects/punyasitus-docs/docs/` with the same relative layout, so links inside the frozen archive still resolve. `diff -r` showed identical copies before `git rm`.
- Living documents (AGENTS, PRD, PLAN, TASKS, DESIGN, DECISIONS, ADR-0009) now cite `punyasitus-docs/docs/...` in backticks: 23 references. Two Markdown links became code spans because they would break for public readers. Earlier entries in this log keep their original paths as history.
- In `punyasitus-docs`, 10 back-links into PRD, PLAN, DESIGN and ADR-0009 now point to `../../../punyasitus/...` (sibling clone).
- Added README boundary notes for `apps/web`, `packages/{core,db,auth,integrations,plugins}`, `infra/cloudflare` and `tests`, derived from the `Allowed Paths` of TASKS.md. No `package.json`, no dependencies, no scaffold: TASK-023 is still unstarted.
- `scripts/check-spec.py` keeps its `docs/archive` exclusion: the planning-artifacts policy archives finished tasks to `docs/archive/TASKS-<date>.md` in this repository.
- Gotcha: the frozen CMSPRO `DECISIONS.md` has 24 dead ADR links (they pointed at CMSPRO's own `docs/adr/`, never copied). Pre-existing; the archive is not rewritten.


## 2026-11-22 — Public repository, final decisions and hot-file layout (`DEC-045`..`DEC-048`)

- Public repository: the old `ongkipro/punyasitus` was renamed to private `ongkipro/punyasitus-history` (main `9a0f9bb`, branch `dev/m1` and all specification history intact; local branch `legacy-main`). A new public `ongkipro/punyasitus` starts from one clean commit `7edb63a`. No force-push, nothing deleted. Before publishing: secret-pattern scan of the tree, internal backup path replaced with "local owner backup", and the prototype's real-domain dummy contact replaced in `punyasitus-docs`. GitHub secret scanning and push protection enabled; no workflow exists, so no Actions minutes are used. `.gitignore` now ignores `.env*` and `.dev.vars*`.
- `delivery-ledger checkpoint` moved `observedHead` to the new baseline; `delivery-ledger verify` VERIFIED.
- An Explore agent swept the documents for open items (18 found). The owner settled the open product items: DEC-045 (tenant domain `situsku.click` and every "Proposal" value), DEC-046 (Workers AI for AI writing and onboarding), DEC-047 (legal and tax are pre-launch gates before TASK-038). "Open decisions" is now empty. Fixed the contradictions it found: PRD "Resend first" and AGENTS "Resend email" now say Cloudflare Email Service primary. Annotated the status of the stale rows DEC-007, DEC-017, DEC-024, DEC-025 and DEC-030 without rewriting their text. Added an amendment banner to ADR-0001.
- DEC-048: `TASKS.md` was 257 KB, five times the dotfiles 50 KB hot-file limit. It is now a 33 KB index: one `### TASK-` record per task with requirement, risk, milestone, dependencies and a link. Full contracts moved byte-for-byte to `docs/tasks/wave-N.md`; wave 5 and wave 7 are split a/b, and every file is under 50 KB. The dependency graph read from the index matches the original. `check-spec.py` now reads the contract files, fails when an index record and its contract differ or a file exceeds 50 KB, and has 3 new tests (15 total). The new rules were mutation-checked: disabling either one makes a test fail.
- `STATUS.md` rewritten to the dotfiles template (Now / Next / Blockers first, 4.7 KB). `dev-ready` reads the 110 index records; `resume-brief` lists TASK-023 as the only READY task.
