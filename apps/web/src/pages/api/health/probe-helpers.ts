export const HEALTH_SERVICE_NAME = "punyasitus-web" as const;
export const DEFAULT_BACKUP_MAX_AGE_SECONDS = 26 * 3600;
export const DEFAULT_ADVICE_MAX_AGE_SECONDS = 2 * 3600;
const PLATFORM_BACKUP_LATEST_KEY = "platform-db/latest.json";
const PLATFORM_BACKUP_PREFIX = "platform-db/";

export const AUTOLARIS_ADVICE_TOPICS = [
  "cron.billing_advice_sweep",
  "billing.autolaris_advice",
] as const;

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

export interface LivenessProbeDeps {
  readonly nowMs?: number;
}

export interface DbHealthProbeDeps {
  readonly platformDb?: D1Database | null;
  readonly nowMs?: number;
}

export interface JobsHealthProbeDeps {
  readonly platformDb?: D1Database | null;
  readonly nowMs?: number;
  readonly maxAdviceAgeSeconds?: number;
}

export interface BackupHealthProbeDeps {
  readonly backupBucket?: HealthBackupBucketLike | null;
  readonly nowMs?: number;
  readonly maxAgeSeconds?: number;
}

function toIsoTimestamp(nowMs?: number): string {
  return new Date(Math.floor(nowMs ?? Date.now())).toISOString();
}

/**
 * Emits minimal, non-secret JSON health responses with strict caching and indexing guards.
 * Never reveals config, secrets, env vars, bindings, stack traces, or internal hostnames.
 */
export function createHealthJsonResponse(
  body: Record<string, unknown>,
  status: 200 | 503,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

/**
 * `GET /api/health` — Worker liveness probe.
 */
export function handleLivenessProbe(deps: LivenessProbeDeps = {}): Response {
  return createHealthJsonResponse(
    {
      status: "ok",
      service: HEALTH_SERVICE_NAME,
      timestamp: toIsoTimestamp(deps.nowMs),
    },
    200,
  );
}

/**
 * `GET /api/health/db` — `PLATFORM_DB` connectivity check (`SELECT 1`).
 * Never leaks SQL errors, binding names, or stack traces.
 */
export async function handleDbHealthProbe(deps: DbHealthProbeDeps): Promise<Response> {
  const timestamp = toIsoTimestamp(deps.nowMs);
  if (!deps.platformDb) {
    return createHealthJsonResponse(
      {
        status: "degraded",
        service: HEALTH_SERVICE_NAME,
        timestamp,
      },
      503,
    );
  }

  try {
    const row = await deps.platformDb
      .prepare("SELECT 1 AS ok")
      .first<{ ok: number }>();
    if (Number(row?.ok) === 1) {
      return createHealthJsonResponse(
        {
          status: "ok",
          service: HEALTH_SERVICE_NAME,
          timestamp,
        },
        200,
      );
    }
  } catch {
    // Intentionally swallow internal error details so no config/stack leaks.
  }

  return createHealthJsonResponse(
    {
      status: "degraded",
      service: HEALTH_SERVICE_NAME,
      timestamp,
    },
    503,
  );
}

/**
 * `GET /api/health/jobs` — checks `job_ledger` dead-letter and stale-running counts
 * plus AutoLaris Advice sweep freshness without leaking payloads or tenant metadata.
 */
export async function handleJobsHealthProbe(deps: JobsHealthProbeDeps): Promise<Response> {
  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const timestamp = toIsoTimestamp(nowMs);
  const maxAdviceAgeSeconds = Math.max(
    60,
    Math.floor(deps.maxAdviceAgeSeconds ?? DEFAULT_ADVICE_MAX_AGE_SECONDS),
  );

  if (!deps.platformDb) {
    return createHealthJsonResponse(
      {
        status: "degraded",
        service: HEALTH_SERVICE_NAME,
        timestamp,
      },
      503,
    );
  }

  try {
    const countsRow = await deps.platformDb
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count,
           SUM(CASE WHEN status = 'running' AND lease_until IS NOT NULL AND lease_until <= ? THEN 1 ELSE 0 END) AS stale_running_count
         FROM job_ledger`,
      )
      .bind(nowMs)
      .first<{ dead_letter_count: number | null; stale_running_count: number | null }>();

    const adviceRow = await deps.platformDb
      .prepare(
        `SELECT
           COUNT(*) AS total_runs,
           MAX(CASE WHEN status = 'completed' THEN updated_at ELSE NULL END) AS last_completed_at
         FROM job_ledger
         WHERE topic IN (?, ?)`,
      )
      .bind(AUTOLARIS_ADVICE_TOPICS[0], AUTOLARIS_ADVICE_TOPICS[1])
      .first<{ total_runs: number | null; last_completed_at: number | null }>();

    const deadLetterCount = Number(countsRow?.dead_letter_count ?? 0);
    const staleRunningCount = Number(countsRow?.stale_running_count ?? 0);
    const adviceTotalRuns = Number(adviceRow?.total_runs ?? 0);
    const lastAdviceCompletedAt =
      typeof adviceRow?.last_completed_at === "number" ? adviceRow.last_completed_at : null;

    let adviceStatus: "ok" | "stale" | "unscheduled";
    let adviceAgeSeconds: number | null;

    if (lastAdviceCompletedAt !== null) {
      adviceAgeSeconds = Math.max(0, Math.floor((nowMs - lastAdviceCompletedAt) / 1000));
      adviceStatus = adviceAgeSeconds <= maxAdviceAgeSeconds ? "ok" : "stale";
    } else if (adviceTotalRuns > 0) {
      adviceAgeSeconds = null;
      adviceStatus = "stale";
    } else {
      adviceAgeSeconds = null;
      adviceStatus = "unscheduled";
    }

    const overallStatus =
      deadLetterCount === 0 && staleRunningCount === 0 && adviceStatus !== "stale"
        ? "ok"
        : "degraded";

    return createHealthJsonResponse(
      {
        status: overallStatus,
        service: HEALTH_SERVICE_NAME,
        deadLetterCount,
        staleRunningCount,
        advice: {
          status: adviceStatus,
          ageSeconds: adviceAgeSeconds,
        },
        timestamp,
      },
      200,
    );
  } catch {
    return createHealthJsonResponse(
      {
        status: "degraded",
        service: HEALTH_SERVICE_NAME,
        timestamp,
      },
      503,
    );
  }
}

async function resolveLatestBackupTimestampMs(
  bucket: HealthBackupBucketLike,
): Promise<number | null> {
  const latestObj = await bucket.get(PLATFORM_BACKUP_LATEST_KEY);
  if (latestObj) {
    try {
      const parsed = JSON.parse(await latestObj.text()) as {
        createdAtMs?: unknown;
        createdAt?: unknown;
      };
      if (typeof parsed.createdAtMs === "number" && Number.isFinite(parsed.createdAtMs)) {
        return parsed.createdAtMs;
      }
      if (typeof parsed.createdAt === "string") {
        const ms = Date.parse(parsed.createdAt);
        if (!Number.isNaN(ms)) return ms;
      }
    } catch {
      // Fall through to object listing fallback
    }
    if (latestObj.uploaded instanceof Date && !Number.isNaN(latestObj.uploaded.getTime())) {
      return latestObj.uploaded.getTime();
    }
  }

  // Fallback: inspect `platform-db/` object upload timestamps without exposing any key names
  let newestMs: number | null = null;
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix: PLATFORM_BACKUP_PREFIX, cursor, limit: 100 });
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
 * `GET /api/health/backup` — checks latest daily `PLATFORM_DB` logical export freshness.
 * Never reveals bucket names, object keys, or error details.
 */
export async function handleBackupHealthProbe(deps: BackupHealthProbeDeps): Promise<Response> {
  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const timestamp = toIsoTimestamp(nowMs);
  const maxAgeSeconds = Math.max(
    60,
    Math.floor(deps.maxAgeSeconds ?? DEFAULT_BACKUP_MAX_AGE_SECONDS),
  );

  if (!deps.backupBucket) {
    return createHealthJsonResponse(
      {
        status: "degraded",
        service: HEALTH_SERVICE_NAME,
        freshness: "stale",
        ageSeconds: null,
        timestamp,
      },
      503,
    );
  }

  try {
    const lastBackupMs = await resolveLatestBackupTimestampMs(deps.backupBucket);
    if (lastBackupMs === null) {
      return createHealthJsonResponse(
        {
          status: "degraded",
          service: HEALTH_SERVICE_NAME,
          freshness: "stale",
          ageSeconds: null,
          timestamp,
        },
        200,
      );
    }

    const ageSeconds = Math.max(0, Math.floor((nowMs - lastBackupMs) / 1000));
    const isFresh = ageSeconds <= maxAgeSeconds;

    return createHealthJsonResponse(
      {
        status: isFresh ? "ok" : "degraded",
        service: HEALTH_SERVICE_NAME,
        freshness: isFresh ? "ok" : "stale",
        ageSeconds,
        timestamp,
      },
      200,
    );
  } catch {
    return createHealthJsonResponse(
      {
        status: "degraded",
        service: HEALTH_SERVICE_NAME,
        freshness: "stale",
        ageSeconds: null,
        timestamp,
      },
      503,
    );
  }
}
