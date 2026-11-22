# PunyaSitus Backup, Restore Drill & Tombstone Replay Runbook

> Contract authority: `PRD.md` (`REQ-042`, `REQ-039`), `PLAN.md` (§9, §12), `DECISIONS.md` (`DEC-022`, `DEC-036`, `DEC-045`).
> Scope: Control-plane `PLATFORM_DB` backups, per-tenant `TenantStore` Durable Object PITR bookmarks, `punyasitus-media` R2 protection, isolated restore drill execution, and mandatory deletion tombstone replay.

---

## 1. Operational Recovery Targets (Initial Launch)

These targets are internal operational objectives for the initial launch — **not a customer SLA** and **not a 99.9% uptime claim** (availability depends on Cloudflare Workers, D1, Durable Objects, and R2):

| Objective | Target | Primary Backing Mechanism |
|---|---|---|
| **RPO (Recovery Point Objective)** | **`<= 24 hours`** | Daily `PLATFORM_DB` logical SQL export (`cron.daily_platform_backup`) to `punyasitus-backup` R2 + D1 30-day Time Travel (minute-level) + `TenantStore` DO 30-day SQLite PITR bookmarks (`migration_bookmarks`). |
| **RTO (Recovery Time Objective)** | **`<= 4 hours`** | Automated SQL replay into isolated/fresh D1, DO `restore(bookmark)` recovery, R2 media verification, and automated `replayDeletionTombstones` (`DEC-022`). |
| **Backup Retention Window** | **`30 days`** | R2 bucket lifecycle rule `expire-30-days` on `punyasitus-backup` + D1 30-day Time Travel + DO 30-day SQLite PITR + R2 `trash/` 30-day prefix lifecycle. |

---

## 2. Backup Architecture by Storage Layer (`DEC-036`)

### 2.1 Control-Plane Database — `PLATFORM_DB` (Cloudflare D1 `punyasitus-platform`)

1. **Primary continuous PITR:** Cloudflare D1 **30-day Time Travel** (enabled on Workers Paid) supports point-in-time restoration to any bookmark/timestamp within 30 days.
2. **Independent daily logical SQL export (`scripts/backup-restore/platform-backup.ts`):**
   - Triggered once per UTC day via hourly Cloudflare Cron (`7 * * * *`) -> durable queue topic `cron.daily_platform_backup` (`createDailyBackupQueueHandler()`).
   - `exportPlatformDbLogicalSql()` produces a deterministic, foreign-key-ordered SQLite logical dump (`CREATE TABLE IF NOT EXISTS` -> PK-ordered `INSERT INTO` rows -> `CREATE INDEX` -> `CREATE TRIGGER`), preventing `platform_audit` append-only triggers from blocking row loads while restoring trigger protection afterward.
   - Computes a Web Crypto **SHA-256** digest over the exact UTF-8 SQL bytes.
   - Writes atomically in strict order to the isolated private R2 bucket **`punyasitus-backup`** (configured with lifecycle rule `expire-30-days`):
     1. `platform-db/<YYYY-MM-DD>/snapshot.sql`
     2. `platform-db/<YYYY-MM-DD>/manifest.json` (format version, SHA-256, byte length, table/row counts, schema version)
     3. `platform-db/latest.json` (freshness marker written last so `/api/health/backup` never observes a partial backup).
   - **Freshness monitoring:** `GET /api/health/backup` reports `{ status, freshness: "ok" | "stale", ageSeconds }` without disclosing bucket names or object keys. Alert threshold: **`> 26 hours`** (`PLATFORM_BACKUP_STALE`).

### 2.2 Per-Tenant Database — `TenantStore` Durable Objects (SQLite DO)

- Each tenant website lives in its own physically isolated SQLite-backed `TenantStore` Durable Object (`locationHint: "apac-se"`, 10 GB per website).
- Cloudflare Durable Objects SQLite storage provides **30-day Point-in-Time Recovery (PITR) bookmarks**.
- **Pre-migration bookmark invariant (`ADR-0009`):** `orchestrateTenantMigration()` (`packages/db/src/connections/migrations.ts`) captures a PITR bookmark and persists it into `PLATFORM_DB.migration_bookmarks` (`status = 'pending'`) **before** executing any DDL inside `TenantStore`'s synchronous `ctx.storage.transactionSync()`.
- **Failure & operator recovery (`restore(bookmark)`):**
  - If any tenant DDL migration fails, the transaction rolls back atomically, `migration_bookmarks.status` becomes `'failed'`, `tenants.status` transitions to `'recovery'` (`cache_version + 1`), and public requests immediately serve neutral HTTP `503` (`Sedang dalam pemeliharaan`) with no automatic migration retries.
  - Operator recovery restores the Durable Object using the recorded bookmark (`restore(bookmark)`), verifies `schemaState()`, marks the bookmark `'restored'`, and explicitly releases `recovery` mode with an audited `platform_audit` entry.

### 2.3 Media Storage — `punyasitus-media` R2 Bucket

- Cloudflare R2 does **not** natively provide S3 object versioning or automated bucket replication (`PLAN.md` §9). Accidental deletion protection is therefore enforced at the application and bucket-policy layers:
  1. **Append-only versioned keys:** Published media objects use immutable tenant-scoped keys (`t/<tenantId>/media/...`) rather than overwriting live objects in place.
  2. **30-day `trash/` lifecycle:** Soft-deleted media moves under `t/<tenantId>/trash/...` and is purged only after 30 days by `runTenantRetentionSweep` (`docs/operations/privacy.md` §2).
  3. **Nightly backup sync:** Nightly operational sync mirrors active `punyasitus-media` objects into the isolated `punyasitus-backup` bucket (`expire-30-days` + bucket retention lock on production).

---

## 3. Isolated Restore Drill Procedure (`scripts/backup-restore/restore-drill.ts`)

An isolated restore drill **must** be executed:
- Before initial production launch, and
- After every major schema migration (`PLATFORM_DB` or `TenantStore`).

Never run a restore drill against the live production `PLATFORM_DB` or live `MEDIA_BUCKET`.

### Automated Drill Steps (`runIsolatedRestoreDrill`)

1. **Fetch & Verify Integrity:** Download `snapshot.sql` and `manifest.json` from `BACKUP_BUCKET` (using explicit `snapshotKey` or `platform-db/latest.json`), recompute SHA-256, and abort immediately on `BACKUP_CHECKSUM_MISMATCH`.
2. **Restore `PLATFORM_DB` into Isolated Target:** Split SQL via trigger-safe `splitMigrationStatements()` and execute in 50-statement atomic batches against the isolated `targetPlatformDb`. Verify restored table row counts match `manifest.tableRowCounts` 1:1.
3. **Mandatory Deletion Tombstone Replay (`DEC-022`, `REQ-039`):**
   - Sync any post-snapshot `authoritativeTombstones` into restored `PLATFORM_DB.deletion_tombstones`.
   - Execute `replayDeletionTombstones({ platformDb: targetPlatformDb, mediaBucket, nowMs })` (`packages/db/src/privacy/tombstones.ts`).
   - Verify post-replay invariants: every tombstoned tenant has `tenants.status = 'purged'`, every tombstoned host has `status = 'deleting'` and `is_primary = 0` with `quarantined_until` preserved, and **zero** R2 objects remain under `t/<tombstonedTenantId>/`.
4. **Verify `TenantStore` DO PITR Bookmarks & Live Records:**
   - For every non-purged tenant in restored `PLATFORM_DB`, confirm `migration_bookmarks` metadata exists and matches expected PITR bookmark tokens (`verifyBookmarkRestore`).
   - Open the tenant's `TenantStore` stub (`TENANT_STORE_PROTOCOL`) and confirm `schemaState().recovery === false`, applied migrations > 0, and live records (`pages`, `posts`, `offerings`, `media_items`) are readable.
5. **Verify Referenced R2 Media Objects:**
   - Collect all active `ready` `media_items` keys (`r2_key`, `poster_r2_key`, `captions_r2_key`) from each active `TenantStore` and verify `mediaBucket.head(key)` succeeds for every referenced object (`missingKeys.length === 0`).
6. **Emit Safe Telemetry:** Record a redacted `backup.isolated_restore_drill` structured telemetry event with table/row/tenant/media/tombstone counts and elapsed `durationMs`.

---

## 4. Recorded Restore Drill & RPO/RTO Measurements

| Environment | Drill Runner | Date (UTC) | Backup Export Size / Checksum | Measured Drill Duration | Tombstone Replay Verified | Status |
|---|---|---|---|---|---|---|
| Local `workerd` CI (`tests/task-037/workerd.integration.test.ts`) | `vitest` (`@cloudflare/vitest-plugin`) | Verified on every `pnpm test:integration` run | Deterministic `PLATFORM_DB` SQL + SHA-256 verified | Sub-second on synthetic fixture (well within `RTO <= 4h` budget) | Yes — resurrected `active` tenant + host + R2 object re-purged automatically while live tenant, PITR bookmark & media remain coherent | **Automated CI Gate** |
| Staging (`staging.punyasitus.com`) | Authorized operator drill | Pending authorized staging deploy | Recorded during pre-launch staging drill | Target `<= 4h` (recorded in `RELEASE.md`) | Required before production launch | **Pending Staging Provisioning** |

---

## 5. Compatible Rollback Rules (`PLAN.md` §9)

- **Additive migrations only:** Never deploy destructive automatic down-migrations (`DROP TABLE`, `DROP COLUMN`, narrowing constraints) in automated release pipelines.
- **Separate credentials:** Migration execution uses dedicated migration credentials/tooling separated from runtime Worker app bindings.
- **Application rollback boundary:** Roll back the Worker application revision **only** while the prior Worker code remains schema-compatible with the already-applied `PLATFORM_DB` and `TenantStore` additive schema.
- **Forward-fix on incompatible schema:** If a deployed schema change cannot be safely read by the previous Worker version, do **not** run a destructive down-migration; deploy an audited forward-fix or restore from verified backup + PITR bookmark + tombstone replay under maintenance mode (`503`).
- **External side effects:** SQL/DO rollback never undoes external provider effects (Cloudflare Custom Hostnames, AutoLaris payment settlements, transactional emails). Reconcile external state through `PLATFORM_DB.job_ledger` durable jobs (`apps/web/src/worker/queues/consumer.ts`).

See also: [Telemetry, Alerting & Release Runbook](./telemetry-release.md) | [Privacy & Retention Runbook](./privacy.md) | [Observability Contract](../../OBSERVABILITY.md)
