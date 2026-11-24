# Release Manifest — punyasitus

Release-ID: punyasitus-v1.0.0-rc1
Base: f02e4c582a0a0b82020b7f46cead93fed10cd176
Environment: production
Declared-Risk: R3
Rollback-Ref: f02e4c582a0a0b82020b7f46cead93fed10cd176
Rollback-Command: ./scripts/verify/backup-restore-drill.mjs --verify-rollback-plan
Backup-Proof: backup://punyasitus-backup/local-drill-20261124-verified
Status: READY

> [!CAUTION]
> ## Pre-Deploy Hard Blockers (Local Release-Candidate Gate Only — DO NOT DEPLOY LIVE)
>
> `Status: READY` satisfies the repository `release-manifest` / `production-gate` schema contract for local/CI release-candidate verification ONLY. **All local/CI code security findings (`SEC-001`..`SEC-006`) and the mobile CLS breach (`M1-FU-08`) are now `RESOLVED_VERIFIED`** (commits `5cb5de1`, `1da5819`, `04e885a`; **0 DAST header/CSP alerts `PASS`**, strict **0-waiver `CLS = 0.0000 <= 0.10`**). **Live production deployment remains strictly BLOCKED until external provider, legal & staging gates below are completed with owner authorization:**
> 1. **External Provider, Legal & Live Staging Gates (`EXT-01`..`EXT-10`):** All 10 external gates remain `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION` (Cloudflare Paid/SaaS/DCV/O2O, Trust+/Komdigi, live Google OAuth, Email Service `notif.punyasitus.com`, AutoLaris live merchant relay, UU PDP & PSE/Komdigi legal counsel sign-offs, GSC/Bing, and live staging OWASP ZAP full scan + production pre-launch R2 backup snapshot).
> 2. **Optional Pre-Staging Integration Polish (`M1-FU-01`, `M1-FU-02`, `M1-FU-04`, `M1-FU-05`, `M1-FU-06`):** Non-blocking repository polish items tracked transparently in `docs/operations/release-checklist.md` §4.2 (plus secondary low-priority publish screening endpoints noted in `docs/security/findings-register.md` §1.1).
> 3. **Resolved Local Hardening Items (Audit Trail):**
>    - **`SEC-001` (`M1-FU-03`, High):** `RESOLVED_VERIFIED` (`04e885a`) — all 4 direct dashboard publish endpoints routed through `publishResourceWithScreening`.
>    - **`SEC-002` (`M1-FU-07`), `SEC-003`, `SEC-005`, `SEC-006` + `M1-FU-08`:** `RESOLVED_VERIFIED` (`1da5819`) — streaming media upload CSRF exemption, central HTML/JSON security headers & per-response nonced CSP (`0` DAST alerts), central CSRF prefix parity, and strict mobile `CLS p50=0 / p95=0 / max=0` (waiver removed from CI & `tests/task-038/e2e.mjs`).
>    - **`SEC-004` (`TASK-086`, Medium):** `RESOLVED_VERIFIED` (`5cb5de1`) — 10-minute 2FA step-up, bounded pagination & explicit truncation headers on console affiliate CSV export.

## Contract

This file defines the current release boundary. It is repository truth for release-specific metadata and MUST describe only the release currently being prepared (`PRD.md` `REQ-041`, `PLAN.md` §9, `DEC-030`, `TASK-038`).

- `Base` (`f02e4c582a0a0b82020b7f46cead93fed10cd176`) is the accepted Wave 7 M2 complete checkpoint commit (strict ancestor of `HEAD` covering the Wave 8 security assurance `TASK-078` + full production release gate `TASK-038` delta).
- `Declared-Risk` is `R3` (production release gate, CI/workflow hardening, and pre-launch security assurance boundary).
- `Rollback-Ref` (`f02e4c582a0a0b82020b7f46cead93fed10cd176`) is the strict pre-release reference commit.
- `Rollback-Command` executes the non-destructive isolated backup/restore + `DEC-022` tombstone replay verification drill (`./scripts/verify/backup-restore-drill.mjs --verify-rollback-plan`).
- `Backup-Proof` (`backup://punyasitus-backup/local-drill-20261124-verified`) is a **local pre-launch drill proof** (not yet a live production R2 backup) backed by two complementary executed verifications recorded in `docs/operations/release-checklist.md`:
  - **(a) Standalone Node SQLite restore/checksum harness (`scripts/verify/backup-restore-drill.mjs`):** Verifies deterministic SQL export, archive manifest + platform + tenant SHA-256 tamper rejection, isolated SQLite restore (`rtoMs`), and `DEC-022` tombstone replay; reports uploaded in CI artifact `release-gate-evidence`.
  - **(b) Real product-code `workerd` integration proof (`tests/task-038/workerd.integration.test.ts`):** Directly executes `exportPlatformDbLogicalSql` + `runDailyPlatformBackup` (`scripts/backup-restore/platform-backup.ts`), `runIsolatedRestoreDrill` (`scripts/backup-restore/restore-drill.ts`), and `recordDeletionTombstone` + `replayDeletionTombstones` (`packages/db/src/privacy/tombstones.ts`) against real `workerd` `PLATFORM_DB` D1, `TenantStore` DO, `BACKUP_BUCKET`, and `MEDIA_BUCKET`.
  Live production pre-launch R2 snapshot creation remains gated under `EXT-01` / `EXT-10` until owner authorization.
- `Status: READY` marks the local/CI release candidate scope (`109 / 110` tasks: `85 M1 + 24 M2`; `TASK-062` explicitly deferred to Release 1.1 per `DEC-035 C16`) frozen for `production-gate` evaluation, subject to the Pre-Deploy Hard Blockers above.

## First-Release Rollback Plan (`REQ-041`, `REQ-042`, `DEC-022`)

Because `punyasitus-v1.0.0-rc1` is the **initial production release**, **no previous production application version exists to roll back to**. In the event of a launch-blocking defect, security incident, or incompatible state during initial launch:

1. **Disable Public & SaaS Routing Immediately:**
   - Place public tenant/SaaS routing into maintenance mode (`503 Service Unavailable`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`) and pause Cloudflare for SaaS custom-hostname traffic / Worker route bindings while keeping the standalone static status page (`apps/status/dist/`) live.
   - Do **not** run destructive down-migrations (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE` are strictly forbidden per `PLAN.md` §9 and `docs/operations/backup-restore.md`).
2. **Restore Pre-Launch Backup & Replay `DEC-022` Tombstones:**
   - Restore `PLATFORM_DB` from the SHA-256 verified pre-launch logical SQL backup (`platform-db/<YYYY-MM-DD>/snapshot.sql` + `manifest.json`) or Cloudflare D1 30-day Time Travel bookmark into a clean target database.
   - Restore any affected `TenantStore` Durable Objects via recorded 30-day SQLite PITR bookmarks (`PLATFORM_DB.migration_bookmarks`).
   - Execute mandatory **`DEC-022` deletion tombstone replay** (`replayDeletionTombstones` in `packages/db/src/privacy/tombstones.ts` / `scripts/backup-restore/restore-drill.ts`) before resuming any traffic so previously deleted/purged tenants, hosts, and `punyasitus-media` R2 objects can **never** resurrect from an older backup.
3. **Reconcile External Side Effects & Verify Health:**
   - Reconcile external provider jobs (Cloudflare Custom Hostnames, AutoLaris payment settlements, Cloudflare Email Sending) idempotently via `PLATFORM_DB.job_ledger`.
   - Confirm `/api/health`, `/api/health/db`, `/api/health/backup`, and `/api/health/jobs` pass before lifting maintenance mode.

## Pre-Deploy External & Security Gate Boundary (`UNVERIFIED` Until Authorized)

Marking `Status: READY` in this manifest prepares the repository release boundary for `production-gate`; **it does NOT authorize live Cloudflare deploys, remote D1 writes, DNS changes, or public launch.** Before any authorized live deployment:

1. **Security Reopen Register (`TASK-078` — `docs/security/findings-register.md`):**
   - All 6 code-level security findings (`SEC-001`..`SEC-006`) and `M1-FU-08` are **`RESOLVED_VERIFIED`** (`5cb5de1`, `1da5819`, `04e885a`; **0 local built-Worker DAST alerts `PASS`**, strict zero-waiver `CLS = 0.0000`). Optional pre-staging polish (`M1-FU-01`, `M1-FU-02`, `M1-FU-04`, `M1-FU-05`, `M1-FU-06`) remains tracked in `docs/operations/release-checklist.md`.
2. **External Provider, Legal & Live Staging Gates (`EXT-01`..`EXT-10` — `UNVERIFIED — REQUIRES EXTERNAL AUTHORIZATION`):**
   - `EXT-01`: Cloudflare Workers Paid account & isolated `punyasitus-*` bindings
   - `EXT-02`: Staging/production Cloudflare for SaaS zone, live HTTP DCV pass-through & O2O customer zone
   - `EXT-03`: Trust+ / Komdigi static-IP reputation check on live SaaS zones
   - `EXT-04`: Live Google OAuth client credentials & verified redirect URIs
   - `EXT-05`: Cloudflare Email Sending (Beta) DNS onboarding (`notif.punyasitus.com`) & inbox deliverability
   - `EXT-06`: AutoLaris merchant approval, static-IP relay host & live Advice webhook reconciliation
   - `EXT-07`: Indonesian legal counsel review of Bahasa Indonesia Terms & Privacy Policy (`UU 27/2022` UU PDP)
   - `EXT-08`: PSE Lingkup Privat registration, `UU KUP Art. 28(11)` tax retention & `Kepmen Komdigi 127/128` compliance text
   - `EXT-09`: Manual Google Search Console & Bing Webmaster live verification
   - `EXT-10`: Live staging OWASP ZAP full active scan, live staging Chromium/Firefox/WebKit 5-run lab & production pre-launch R2 backup snapshot
