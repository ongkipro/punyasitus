/**
 * Read-only platform operational health & overview summary readers from `PLATFORM_DB`
 * (PLAN §13; REQ-051, REQ-042).
 *
 * Core invariants:
 * - Strictly distinguishes `healthy`, `degraded`, `stale`, and `unknown` — NEVER fabricates
 *   `healthy` or `0` when a probe is unavailable or no heartbeat/evidence has been reported.
 * - Reads narrow `PLATFORM_DB` operational metadata ONLY; never opens `TenantStore` or
 *   reads customer content, leads, or PII.
 */

export const PLATFORM_HEALTH_STATUSES = [
  "healthy",
  "degraded",
  "stale",
  "unknown",
] as const;
export type PlatformHealthStatus = (typeof PLATFORM_HEALTH_STATUSES)[number];

export const DEFAULT_JOB_HEARTBEAT_MAX_AGE_SECONDS = 2 * 3600; // 2 hours
export const DEFAULT_BACKUP_HEALTH_MAX_AGE_SECONDS = 26 * 3600; // 26 hours
export const DEFAULT_RESTORE_DRILL_MAX_AGE_SECONDS = 35 * 24 * 3600; // 35 days
export const DEFAULT_DOMAIN_STALE_CHECK_SECONDS = 6 * 3600; // 6 hours

export const HEALTH_SETTINGS_KEYS = {
  lastBackup: "ops.health.last_backup",
  lastRestoreDrill: "ops.health.last_restore_drill",
  heartbeats: "ops.health.heartbeats",
} as const;

export interface HealthR2ObjectLike {
  readonly key?: string;
  readonly uploaded?: Date;
  text(): Promise<string>;
}

export interface HealthBackupBucketLike {
  get(key: string): Promise<HealthR2ObjectLike | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    readonly objects: readonly { readonly key: string; readonly uploaded?: Date }[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

export interface PlatformHealthComponent {
  readonly id: string;
  readonly label: string;
  readonly status: PlatformHealthStatus;
  readonly summary: string;
  readonly lastReportedAt: string | null;
  readonly ageSeconds: number | null;
  readonly thresholdSeconds: number | null;
}

export interface PlatformHealthSnapshot {
  readonly status: PlatformHealthStatus;
  readonly checkedAt: string;
  readonly components: readonly PlatformHealthComponent[];
  readonly metrics: {
    readonly failedJobsCount: number | null;
    readonly deadLetterJobsCount: number | null;
    readonly staleRunningJobsCount: number | null;
    readonly stuckDomainsCount: number | null;
    readonly failedDomainsCount: number | null;
    readonly lastBackupAt: string | null;
    readonly lastRestoreDrillAt: string | null;
  };
}

export interface ReadPlatformHealthOptions {
  readonly backupBucket?: HealthBackupBucketLike | null;
  readonly nowMs?: number;
  readonly maxJobAgeSeconds?: number;
  readonly maxBackupAgeSeconds?: number;
  readonly maxRestoreDrillAgeSeconds?: number;
  readonly maxDomainCheckAgeSeconds?: number;
}

export interface PlatformOverviewSummary {
  readonly generatedAt: string;
  readonly healthStatus: PlatformHealthStatus;
  readonly tenantsByStatus: Readonly<Record<string, number>>;
  readonly totalTenants: number;
  readonly failedJobsCount: number | null;
  readonly deadLetterJobsCount: number | null;
  readonly stuckDomainsCount: number | null;
  readonly openAbuseReportsCount: number | null;
  readonly activeOperatorsCount: number;
  readonly revokedOperatorsCount: number;
  readonly auditEntriesLast24h: number;
}

interface StoredHeartbeatEntry {
  readonly id?: unknown;
  readonly label?: unknown;
  readonly reportedAtMs?: unknown;
  readonly reportedAt?: unknown;
  readonly maxAgeSeconds?: unknown;
  readonly healthy?: unknown;
  readonly summary?: unknown;
}

function toIsoOrNull(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(Math.trunc(ms)).toISOString();
}

function parseTimestampMs(msField: unknown, isoField?: unknown): number | null {
  if (typeof msField === "number" && Number.isFinite(msField) && msField > 0) {
    return Math.trunc(msField);
  }
  if (typeof isoField === "string" && isoField.trim().length > 0) {
    const parsed = Date.parse(isoField);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

/**
 * Evaluates a single heartbeat/evidence timestamp against a freshness ceiling.
 * Pure helper shared across health checks and unit tests.
 */
export function evaluateHeartbeatStatus(params: {
  readonly nowMs: number;
  readonly reportedAtMs: number | null;
  readonly maxAgeSeconds: number;
  readonly healthy?: boolean;
  readonly probeError?: boolean;
}): { readonly status: PlatformHealthStatus; readonly ageSeconds: number | null } {
  if (params.probeError) {
    return { status: "degraded", ageSeconds: null };
  }
  if (params.reportedAtMs === null) {
    return { status: "unknown", ageSeconds: null };
  }
  const ageSeconds = Math.max(0, Math.floor((params.nowMs - params.reportedAtMs) / 1000));
  if (params.healthy === false) {
    return { status: "degraded", ageSeconds };
  }
  if (ageSeconds > params.maxAgeSeconds) {
    return { status: "stale", ageSeconds };
  }
  return { status: "healthy", ageSeconds };
}

/**
 * Aggregates individual component statuses into an overall platform health status.
 * Priority: `degraded` > `stale` > `unknown` > `healthy`.
 * Never returns `healthy` if any required check is unmeasured (`unknown`) or `stale`.
 */
export function aggregatePlatformHealthStatus(
  statuses: readonly PlatformHealthStatus[],
): PlatformHealthStatus {
  if (statuses.length === 0) return "unknown";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("unknown")) return "unknown";
  return "healthy";
}

async function resolveBackupTimestampFromBucket(
  bucket: HealthBackupBucketLike,
): Promise<number | null> {
  const latestObj = await bucket.get("platform-db/latest.json");
  if (latestObj) {
    try {
      const parsed = JSON.parse(await latestObj.text()) as {
        createdAtMs?: unknown;
        createdAt?: unknown;
      };
      const ms = parseTimestampMs(parsed.createdAtMs, parsed.createdAt);
      if (ms !== null) return ms;
    } catch {
      // Fall through to object metadata / list fallback
    }
    if (latestObj.uploaded instanceof Date && !Number.isNaN(latestObj.uploaded.getTime())) {
      return latestObj.uploaded.getTime();
    }
  }

  let newestMs: number | null = null;
  let cursor: string | undefined;
  for (let i = 0; i < 10; i += 1) {
    const page = await bucket.list({ prefix: "platform-db/", cursor, limit: 100 });
    for (const obj of page.objects) {
      if (!obj.key.endsWith("/snapshot.sql")) continue;
      if (obj.uploaded instanceof Date && !Number.isNaN(obj.uploaded.getTime())) {
        const ts = obj.uploaded.getTime();
        if (newestMs === null || ts > newestMs) {
          newestMs = ts;
        }
      }
    }
    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }
  return newestMs;
}

/**
 * Produces a real-time, read-only health snapshot of `PLATFORM_DB`, durable jobs/crons,
 * backups, restore drills, custom domains, and recorded dependency heartbeats.
 */
export async function readPlatformHealthSnapshot(
  platformDb: D1Database | null | undefined,
  options: ReadPlatformHealthOptions = {},
): Promise<PlatformHealthSnapshot> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const checkedAt = new Date(nowMs).toISOString();
  const maxJobAgeSeconds = Math.max(
    60,
    Math.trunc(options.maxJobAgeSeconds ?? DEFAULT_JOB_HEARTBEAT_MAX_AGE_SECONDS),
  );
  const maxBackupAgeSeconds = Math.max(
    60,
    Math.trunc(options.maxBackupAgeSeconds ?? DEFAULT_BACKUP_HEALTH_MAX_AGE_SECONDS),
  );
  const maxRestoreDrillAgeSeconds = Math.max(
    60,
    Math.trunc(options.maxRestoreDrillAgeSeconds ?? DEFAULT_RESTORE_DRILL_MAX_AGE_SECONDS),
  );
  const maxDomainCheckAgeSeconds = Math.max(
    60,
    Math.trunc(options.maxDomainCheckAgeSeconds ?? DEFAULT_DOMAIN_STALE_CHECK_SECONDS),
  );

  if (!platformDb) {
    const components: PlatformHealthComponent[] = [
      {
        id: "database",
        label: "Basis Data Platform (PLATFORM_DB)",
        status: "degraded",
        summary: "Binding PLATFORM_DB tidak tersedia pada runtime saat ini.",
        lastReportedAt: null,
        ageSeconds: null,
        thresholdSeconds: null,
      },
      {
        id: "jobs",
        label: "Antrean & Jadwal Pekerjaan",
        status: "unknown",
        summary: "Tidak dapat membaca job_ledger saat basis data tidak tersedia.",
        lastReportedAt: null,
        ageSeconds: null,
        thresholdSeconds: maxJobAgeSeconds,
      },
      {
        id: "backup",
        label: "Cadangan Harian PLATFORM_DB",
        status: "unknown",
        summary: "Status cadangan tidak dapat dipastikan.",
        lastReportedAt: null,
        ageSeconds: null,
        thresholdSeconds: maxBackupAgeSeconds,
      },
      {
        id: "restore_drill",
        label: "Uji Pemulihan (Restore Drill)",
        status: "unknown",
        summary: "Bukti uji pemulihan belum tersedia.",
        lastReportedAt: null,
        ageSeconds: null,
        thresholdSeconds: maxRestoreDrillAgeSeconds,
      },
    ];

    return {
      status: "degraded",
      checkedAt,
      components,
      metrics: {
        failedJobsCount: null,
        deadLetterJobsCount: null,
        staleRunningJobsCount: null,
        stuckDomainsCount: null,
        failedDomainsCount: null,
        lastBackupAt: null,
        lastRestoreDrillAt: null,
      },
    };
  }

  const components: PlatformHealthComponent[] = [];

  // 1. PLATFORM_DB liveness probe
  let dbHealthy: boolean;
  try {
    const ping = await platformDb.prepare("SELECT 1 AS ok").first<{ readonly ok: number }>();
    dbHealthy = Number(ping?.ok) === 1;
  } catch {
    dbHealthy = false;
  }

  components.push({
    id: "database",
    label: "Basis Data Platform (PLATFORM_DB)",
    status: dbHealthy ? "healthy" : "degraded",
    summary: dbHealthy
      ? "Koneksi D1 PLATFORM_DB aktif dan merespons kueri baca."
      : "Kueri pemeriksaan D1 PLATFORM_DB gagal merespons.",
    lastReportedAt: dbHealthy ? checkedAt : null,
    ageSeconds: dbHealthy ? 0 : null,
    thresholdSeconds: null,
  });

  if (!dbHealthy) {
    return {
      status: "degraded",
      checkedAt,
      components,
      metrics: {
        failedJobsCount: null,
        deadLetterJobsCount: null,
        staleRunningJobsCount: null,
        stuckDomainsCount: null,
        failedDomainsCount: null,
        lastBackupAt: null,
        lastRestoreDrillAt: null,
      },
    };
  }

  // 2. Durable Jobs & Cron Ledger (`job_ledger`)
  let failedJobsCount: number | null = null;
  let deadLetterJobsCount: number | null = null;
  let staleRunningJobsCount: number | null = null;
  try {
    const jobRow = await platformDb
      .prepare(
        `SELECT
           COUNT(*) AS total_jobs,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
           SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count,
           SUM(CASE WHEN status = 'running' AND lease_until IS NOT NULL AND lease_until <= ? THEN 1 ELSE 0 END) AS stale_running_count,
           MAX(CASE WHEN status = 'completed' THEN updated_at ELSE NULL END) AS last_completed_at
         FROM job_ledger`,
      )
      .bind(nowMs)
      .first<{
        readonly total_jobs: number | null;
        readonly failed_count: number | null;
        readonly dead_letter_count: number | null;
        readonly stale_running_count: number | null;
        readonly last_completed_at: number | null;
      }>();

    const totalJobs = Number(jobRow?.total_jobs ?? 0);
    failedJobsCount = Number(jobRow?.failed_count ?? 0);
    deadLetterJobsCount = Number(jobRow?.dead_letter_count ?? 0);
    staleRunningJobsCount = Number(jobRow?.stale_running_count ?? 0);
    const lastCompletedAtMs =
      typeof jobRow?.last_completed_at === "number" ? jobRow.last_completed_at : null;

    let jobStatus: PlatformHealthStatus;
    let jobSummary: string;
    let jobAgeSeconds: number | null = null;

    if (deadLetterJobsCount > 0 || failedJobsCount > 0 || staleRunningJobsCount > 0) {
      jobStatus = "degraded";
      jobSummary = `Ditemukan ${deadLetterJobsCount} dead-letter, ${failedJobsCount} gagal, dan ${staleRunningJobsCount} lease kedaluwarsa.`;
      if (lastCompletedAtMs !== null) {
        jobAgeSeconds = Math.max(0, Math.floor((nowMs - lastCompletedAtMs) / 1000));
      }
    } else if (totalJobs === 0) {
      jobStatus = "unknown";
      jobSummary = "Belum ada catatan eksekusi antrean atau cron di job_ledger.";
    } else if (lastCompletedAtMs === null) {
      jobStatus = "stale";
      jobSummary = "Ada pekerjaan terdaftar tetapi belum ada penyelesaian sukses yang tercatat.";
    } else {
      const evaluated = evaluateHeartbeatStatus({
        nowMs,
        reportedAtMs: lastCompletedAtMs,
        maxAgeSeconds: maxJobAgeSeconds,
        healthy: true,
      });
      jobStatus = evaluated.status;
      jobAgeSeconds = evaluated.ageSeconds;
      jobSummary =
        jobStatus === "healthy"
          ? "Antrean dan cron terakhir selesai dalam batas kesegaran normal."
          : `Penyelesaian pekerjaan terakhir sudah usang (${jobAgeSeconds ?? 0} detik, batas ${maxJobAgeSeconds} detik).`;
    }

    components.push({
      id: "jobs",
      label: "Antrean & Jadwal Pekerjaan",
      status: jobStatus,
      summary: jobSummary,
      lastReportedAt: toIsoOrNull(lastCompletedAtMs),
      ageSeconds: jobAgeSeconds,
      thresholdSeconds: maxJobAgeSeconds,
    });
  } catch {
    components.push({
      id: "jobs",
      label: "Antrean & Jadwal Pekerjaan",
      status: "degraded",
      summary: "Gagal membaca tabel job_ledger.",
      lastReportedAt: null,
      ageSeconds: null,
      thresholdSeconds: maxJobAgeSeconds,
    });
  }

  // Load health metadata rows from `platform_settings` once
  const settingsMap = new Map<string, Record<string, unknown>>();
  try {
    const settingsRows = await platformDb
      .prepare("SELECT key, value_json FROM platform_settings WHERE key IN (?, ?, ?)")
      .bind(
        HEALTH_SETTINGS_KEYS.lastBackup,
        HEALTH_SETTINGS_KEYS.lastRestoreDrill,
        HEALTH_SETTINGS_KEYS.heartbeats,
      )
      .all<{ readonly key: string; readonly value_json: string }>();

    for (const row of settingsRows.results ?? []) {
      try {
        const parsed = JSON.parse(row.value_json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          settingsMap.set(row.key, parsed as Record<string, unknown>);
        }
      } catch {
        // Ignore malformed JSON rather than throwing on health page
      }
    }
  } catch {
    // Non-fatal; backup/restore checks will report unknown/degraded cleanly
  }

  // 3. Daily Backup Freshness (`BACKUP_BUCKET` primary, `platform_settings['ops.health.last_backup']` fallback)
  let lastBackupMs: number | null = null;
  let backupProbeError = false;
  if (options.backupBucket) {
    try {
      lastBackupMs = await resolveBackupTimestampFromBucket(options.backupBucket);
    } catch {
      backupProbeError = true;
    }
  }
  if (lastBackupMs === null && !backupProbeError) {
    const storedBackup = settingsMap.get(HEALTH_SETTINGS_KEYS.lastBackup);
    if (storedBackup) {
      lastBackupMs = parseTimestampMs(
        storedBackup.createdAtMs ?? storedBackup.completedAtMs,
        storedBackup.createdAt ?? storedBackup.completedAt,
      );
    }
  }

  const backupEval = evaluateHeartbeatStatus({
    nowMs,
    reportedAtMs: lastBackupMs,
    maxAgeSeconds: maxBackupAgeSeconds,
    probeError: backupProbeError,
  });
  components.push({
    id: "backup",
    label: "Cadangan Harian PLATFORM_DB",
    status: backupEval.status,
    summary:
      backupEval.status === "degraded"
        ? "Pemeriksaan bucket cadangan gagal diakses."
        : backupEval.status === "unknown"
          ? "Belum ada bukti cadangan harian yang tercatat atau bucket belum terpasang."
          : backupEval.status === "stale"
            ? `Cadangan terakhir melebihi batas kesegaran (${backupEval.ageSeconds ?? 0} detik).`
            : "Cadangan harian PLATFORM_DB segar dan terverifikasi.",
    lastReportedAt: toIsoOrNull(lastBackupMs),
    ageSeconds: backupEval.ageSeconds,
    thresholdSeconds: maxBackupAgeSeconds,
  });

  // 4. Restore Drill Evidence (`platform_settings['ops.health.last_restore_drill']`)
  const storedRestore = settingsMap.get(HEALTH_SETTINGS_KEYS.lastRestoreDrill);
  const lastRestoreMs = storedRestore
    ? parseTimestampMs(
        storedRestore.completedAtMs ?? storedRestore.drilledAtMs,
        storedRestore.completedAt ?? storedRestore.drilledAt,
      )
    : null;
  const restoreOk = storedRestore ? storedRestore.ok !== false : undefined;
  const restoreEval = evaluateHeartbeatStatus({
    nowMs,
    reportedAtMs: lastRestoreMs,
    maxAgeSeconds: maxRestoreDrillAgeSeconds,
    healthy: restoreOk,
  });
  components.push({
    id: "restore_drill",
    label: "Uji Pemulihan (Restore Drill)",
    status: restoreEval.status,
    summary:
      restoreEval.status === "unknown"
        ? "Belum ada bukti uji pemulihan terisolasi yang tercatat."
        : restoreEval.status === "degraded"
          ? "Uji pemulihan terakhir tercatat gagal — perlu tindak lanjut operasional."
          : restoreEval.status === "stale"
            ? "Bukti uji pemulihan terakhir sudah melewati jadwal berkala."
            : "Uji pemulihan terisolasi tercatat berhasil dan masih berlaku.",
    lastReportedAt: toIsoOrNull(lastRestoreMs),
    ageSeconds: restoreEval.ageSeconds,
    thresholdSeconds: maxRestoreDrillAgeSeconds,
  });

  // 5. Custom Domains Monitoring (`tenant_hosts`)
  let stuckDomainsCount: number | null = null;
  let failedDomainsCount: number | null = null;
  try {
    const staleCutoffMs = nowMs - maxDomainCheckAgeSeconds * 1000;
    const domainRow = await platformDb
      .prepare(
        `SELECT
           COUNT(*) AS total_custom,
           SUM(CASE WHEN status = 'failed' OR ssl_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
           SUM(CASE WHEN status = 'pending' AND (last_checked_at IS NULL OR last_checked_at < ?) THEN 1 ELSE 0 END) AS stuck_count,
           MAX(last_checked_at) AS latest_checked_at
         FROM tenant_hosts
         WHERE kind = 'custom'`,
      )
      .bind(staleCutoffMs)
      .first<{
        readonly total_custom: number | null;
        readonly failed_count: number | null;
        readonly stuck_count: number | null;
        readonly latest_checked_at: number | null;
      }>();

    const totalCustom = Number(domainRow?.total_custom ?? 0);
    failedDomainsCount = Number(domainRow?.failed_count ?? 0);
    stuckDomainsCount = Number(domainRow?.stuck_count ?? 0);
    const latestCheckedMs =
      typeof domainRow?.latest_checked_at === "number" ? domainRow.latest_checked_at : null;

    let domainStatus: PlatformHealthStatus;
    let domainSummary: string;
    if (failedDomainsCount > 0) {
      domainStatus = "degraded";
      domainSummary = `Terdapat ${failedDomainsCount} domain kustom gagal verifikasi/SSL.`;
    } else if (stuckDomainsCount > 0) {
      domainStatus = "stale";
      domainSummary = `Terdapat ${stuckDomainsCount} domain kustom tertahan tanpa pemeriksaan terbaru.`;
    } else if (totalCustom === 0) {
      domainStatus = "unknown";
      domainSummary = "Belum ada domain kustom terdaftar untuk dipantau.";
    } else {
      domainStatus = "healthy";
      domainSummary = `${totalCustom} domain kustom dalam kondisi normal.`;
    }

    components.push({
      id: "domains",
      label: "Domain Kustom & TLS (Cloudflare for SaaS)",
      status: domainStatus,
      summary: domainSummary,
      lastReportedAt: toIsoOrNull(latestCheckedMs),
      ageSeconds:
        latestCheckedMs !== null
          ? Math.max(0, Math.floor((nowMs - latestCheckedMs) / 1000))
          : null,
      thresholdSeconds: maxDomainCheckAgeSeconds,
    });
  } catch {
    components.push({
      id: "domains",
      label: "Domain Kustom & TLS (Cloudflare for SaaS)",
      status: "degraded",
      summary: "Gagal membaca status domain kustom dari tenant_hosts.",
      lastReportedAt: null,
      ageSeconds: null,
      thresholdSeconds: maxDomainCheckAgeSeconds,
    });
  }

  // 6. Optional additional dependency heartbeats stored in `platform_settings['ops.health.heartbeats']`
  const storedHeartbeats = settingsMap.get(HEALTH_SETTINGS_KEYS.heartbeats);
  if (storedHeartbeats && Array.isArray(storedHeartbeats.dependencies)) {
    for (const rawEntry of storedHeartbeats.dependencies.slice(0, 12)) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as StoredHeartbeatEntry;
      const id = typeof entry.id === "string" ? entry.id.trim().slice(0, 64) : "";
      const label = typeof entry.label === "string" ? entry.label.trim().slice(0, 120) : id;
      if (!id || !label) continue;
      const reportedAtMs = parseTimestampMs(entry.reportedAtMs, entry.reportedAt);
      const maxAge =
        typeof entry.maxAgeSeconds === "number" &&
        Number.isFinite(entry.maxAgeSeconds) &&
        entry.maxAgeSeconds >= 60
          ? Math.trunc(entry.maxAgeSeconds)
          : maxJobAgeSeconds;
      const healthyFlag = typeof entry.healthy === "boolean" ? entry.healthy : undefined;
      const evaluated = evaluateHeartbeatStatus({
        nowMs,
        reportedAtMs,
        maxAgeSeconds: maxAge,
        healthy: healthyFlag,
      });
      const defaultSummary =
        evaluated.status === "healthy"
          ? "Heartbeat dependensi aktif dan segar."
          : evaluated.status === "stale"
            ? `Heartbeat dependensi usang (${evaluated.ageSeconds ?? 0} detik, batas ${maxAge} detik).`
            : evaluated.status === "degraded"
              ? "Dependensi melaporkan kondisi menurun."
              : "Heartbeat dependensi belum pernah dilaporkan.";
      components.push({
        id,
        label,
        status: evaluated.status,
        summary:
          typeof entry.summary === "string" && entry.summary.trim().length > 0
            ? entry.summary.trim().slice(0, 200)
            : defaultSummary,
        lastReportedAt: toIsoOrNull(reportedAtMs),
        ageSeconds: evaluated.ageSeconds,
        thresholdSeconds: maxAge,
      });
    }
  }

  // Overall status aggregates core operational checks + custom dependencies
  // Note: `domains` being `unknown` simply means 0 custom domains yet (normal for a new platform),
  // whereas `database`, `jobs`, `backup`, `restore_drill`, and registered dependencies determine readiness.
  const coreStatuses = components
    .filter((c) => c.id !== "domains" || c.status === "degraded" || c.status === "stale")
    .map((c) => c.status);

  const overallStatus = aggregatePlatformHealthStatus(coreStatuses);

  return {
    status: overallStatus,
    checkedAt,
    components,
    metrics: {
      failedJobsCount,
      deadLetterJobsCount,
      staleRunningJobsCount,
      stuckDomainsCount,
      failedDomainsCount,
      lastBackupAt: toIsoOrNull(lastBackupMs),
      lastRestoreDrillAt: toIsoOrNull(lastRestoreMs),
    },
  };
}

/**
 * Reads narrow control-plane counts from `PLATFORM_DB` for `console.punyasitus.com/` overview.
 * Never accesses `TenantStore` or customer content/leads.
 */
export async function readPlatformOverviewSummary(
  platformDb: D1Database,
  options: ReadPlatformHealthOptions = {},
): Promise<PlatformOverviewSummary> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;

  const [health, tenantStatusRows, operatorCounts, abuseCount, audit24h] = await Promise.all([
    readPlatformHealthSnapshot(platformDb, { ...options, nowMs }),
    platformDb
      .prepare("SELECT status, COUNT(*) AS count FROM tenants GROUP BY status")
      .all<{ readonly status: string; readonly count: number }>(),
    platformDb
      .prepare(
        `SELECT
           SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active_count,
           SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked_count
         FROM platform_operators`,
      )
      .first<{ readonly active_count: number | null; readonly revoked_count: number | null }>(),
    platformDb
      .prepare("SELECT COUNT(*) AS count FROM abuse_reports WHERE status = 'open'")
      .first<{ readonly count: number | null }>(),
    platformDb
      .prepare("SELECT COUNT(*) AS count FROM platform_audit WHERE created_at >= ?")
      .bind(dayAgoMs)
      .first<{ readonly count: number | null }>(),
  ]);

  const tenantsByStatus: Record<string, number> = {};
  let totalTenants = 0;
  for (const row of tenantStatusRows.results ?? []) {
    const c = Number(row.count ?? 0);
    tenantsByStatus[row.status] = c;
    totalTenants += c;
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    healthStatus: health.status,
    tenantsByStatus,
    totalTenants,
    failedJobsCount: health.metrics.failedJobsCount,
    deadLetterJobsCount: health.metrics.deadLetterJobsCount,
    stuckDomainsCount:
      health.metrics.stuckDomainsCount !== null && health.metrics.failedDomainsCount !== null
        ? health.metrics.stuckDomainsCount + health.metrics.failedDomainsCount
        : null,
    openAbuseReportsCount: abuseCount ? Number(abuseCount.count ?? 0) : null,
    activeOperatorsCount: Number(operatorCounts?.active_count ?? 0),
    revokedOperatorsCount: Number(operatorCounts?.revoked_count ?? 0),
    auditEntriesLast24h: Number(audit24h?.count ?? 0),
  };
}
