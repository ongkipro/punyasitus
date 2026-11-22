import {
  DEFAULT_JOB_LEASE_MS,
  DEFAULT_MAX_JOB_ATTEMPTS,
  sanitizeErrorCode,
  type JobStatus,
} from "@punyasitus/core/jobs/index";

interface JobLedgerSqlRow {
  readonly idempotency_key: string;
  readonly topic: string;
  readonly tenant_id: string | null;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly lease_until: number | null;
  readonly last_error_code: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface JobLedgerRecord {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly leaseUntil: number | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SanitizedFailedJobRow {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly status: "failed" | "dead_letter";
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function mapLedgerRow(row: JobLedgerSqlRow): JobLedgerRecord {
  return {
    idempotencyKey: row.idempotency_key,
    topic: row.topic,
    tenantId: row.tenant_id,
    status: row.status,
    attempts: row.attempts,
    leaseUntil: row.lease_until,
    lastErrorCode: row.last_error_code ? sanitizeErrorCode(row.last_error_code) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface EnqueueDurableJobInput {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly tenantId: string | null;
  readonly payload?: Record<string, unknown> | null;
  readonly nowMs?: number;
}

export interface EnqueueDurableJobResult {
  readonly enqueued: boolean;
  readonly idempotencyKey: string;
}

/**
 * Atomically inserts a durable job row into `PLATFORM_DB.job_ledger` using `INSERT OR IGNORE`.
 * Duplicate idempotency keys are a safe no-op returning `{ enqueued: false }`.
 */
export async function enqueueDurableJob(
  db: D1Database,
  input: EnqueueDurableJobInput,
): Promise<EnqueueDurableJobResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  const topic = input.topic.trim();
  if (!idempotencyKey) {
    throw new RangeError("INVALID_IDEMPOTENCY_KEY: idempotencyKey must be non-empty");
  }
  if (!topic) {
    throw new RangeError("INVALID_TOPIC: topic must be non-empty");
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const tenantId = input.tenantId ? input.tenantId.trim() : null;
  const payloadJson =
    input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload);

  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO job_ledger (
         idempotency_key,
         topic,
         tenant_id,
         status,
         attempts,
         lease_until,
         last_error_code,
         payload_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, ?)`,
    )
    .bind(idempotencyKey, topic, tenantId, payloadJson, nowMs, nowMs)
    .run();

  return {
    enqueued: (res.meta?.changes ?? 0) === 1,
    idempotencyKey,
  };
}

/**
 * Removes an untouched queued row when publishing to Cloudflare Queues fails before delivery.
 */
export async function releaseUnstartedQueuedJob(
  db: D1Database,
  idempotencyKey: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `DELETE FROM job_ledger
       WHERE idempotency_key = ?
         AND status = 'queued'
         AND attempts = 0`,
    )
    .bind(idempotencyKey)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export interface AcquireJobLeaseInput {
  readonly idempotencyKey: string;
  readonly nowMs?: number;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
}

export type AcquireJobLeaseResult =
  | {
      readonly outcome: "acquired";
      readonly record: JobLedgerRecord;
      readonly attempts: number;
      readonly leaseUntil: number;
      readonly tenantId: string | null;
    }
  | {
      readonly outcome: "already_completed";
      readonly record: JobLedgerRecord;
    }
  | {
      readonly outcome: "lease_active";
      readonly record: JobLedgerRecord;
      readonly leaseUntil: number;
    }
  | {
      readonly outcome: "dead_letter";
      readonly record: JobLedgerRecord;
      readonly transitionedToDeadLetter: boolean;
    }
  | {
      readonly outcome: "not_found";
    };

/**
 * Atomically claims a durable job lease for `queued`/`failed` jobs or expired `running` leases
 * (`status = 'running' AND lease_until <= nowMs`), incrementing `attempts` in SQL.
 */
export async function acquireJobLease(
  db: D1Database,
  input: AcquireJobLeaseInput,
): Promise<AcquireJobLeaseResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new RangeError("INVALID_IDEMPOTENCY_KEY: idempotencyKey must be non-empty");
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const leaseDurationMs = Math.max(1, Math.floor(input.leaseDurationMs ?? DEFAULT_JOB_LEASE_MS));
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS));
  const leaseUntil = nowMs + leaseDurationMs;

  const claimed = await db
    .prepare(
      `UPDATE job_ledger
       SET status = 'running',
           attempts = attempts + 1,
           lease_until = ?,
           updated_at = ?
       WHERE idempotency_key = ?
         AND (
           status IN ('queued', 'failed')
           OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
         )
         AND attempts < ?
       RETURNING
         idempotency_key,
         topic,
         tenant_id,
         status,
         attempts,
         lease_until,
         last_error_code,
         created_at,
         updated_at`,
    )
    .bind(leaseUntil, nowMs, idempotencyKey, nowMs, maxAttempts)
    .first<JobLedgerSqlRow>();

  if (claimed) {
    const record = mapLedgerRow(claimed);
    return {
      outcome: "acquired",
      record,
      attempts: record.attempts,
      leaseUntil,
      tenantId: record.tenantId,
    };
  }

  const existing = await db
    .prepare(
      `SELECT
         idempotency_key,
         topic,
         tenant_id,
         status,
         attempts,
         lease_until,
         last_error_code,
         created_at,
         updated_at
       FROM job_ledger
       WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .first<JobLedgerSqlRow>();

  if (!existing) {
    return { outcome: "not_found" };
  }

  const existingRecord = mapLedgerRow(existing);

  if (existingRecord.status === "completed") {
    return { outcome: "already_completed", record: existingRecord };
  }

  if (existingRecord.status === "dead_letter") {
    return {
      outcome: "dead_letter",
      record: existingRecord,
      transitionedToDeadLetter: false,
    };
  }

  if (
    existingRecord.status === "running" &&
    existingRecord.leaseUntil !== null &&
    existingRecord.leaseUntil > nowMs
  ) {
    return {
      outcome: "lease_active",
      record: existingRecord,
      leaseUntil: existingRecord.leaseUntil,
    };
  }

  // Row has exhausted attempts (e.g. final attempt crashed and its lease expired) -> transition to dead_letter
  if (existingRecord.attempts >= maxAttempts) {
    const deadLettered = await db
      .prepare(
        `UPDATE job_ledger
         SET status = 'dead_letter',
             lease_until = NULL,
             last_error_code = COALESCE(last_error_code, 'LEASE_EXPIRED_MAX_ATTEMPTS'),
             updated_at = ?
         WHERE idempotency_key = ?
           AND status NOT IN ('completed', 'dead_letter')
           AND attempts >= ?
         RETURNING
           idempotency_key,
           topic,
           tenant_id,
           status,
           attempts,
           lease_until,
           last_error_code,
           created_at,
           updated_at`,
      )
      .bind(nowMs, idempotencyKey, maxAttempts)
      .first<JobLedgerSqlRow>();

    if (deadLettered) {
      return {
        outcome: "dead_letter",
        record: mapLedgerRow(deadLettered),
        transitionedToDeadLetter: true,
      };
    }

    const refreshed = await getJobLedgerRecord(db, idempotencyKey);
    if (refreshed?.status === "completed") {
      return { outcome: "already_completed", record: refreshed };
    }
    return {
      outcome: "dead_letter",
      record: refreshed ?? existingRecord,
      transitionedToDeadLetter: false,
    };
  }

  return {
    outcome: "lease_active",
    record: existingRecord,
    leaseUntil: existingRecord.leaseUntil ?? nowMs,
  };
}

export interface CompleteJobInput {
  readonly idempotencyKey: string;
  readonly nowMs?: number;
}

/**
 * Marks a job `completed` and clears its active lease.
 */
export async function completeJob(
  db: D1Database,
  input: CompleteJobInput,
): Promise<{ readonly completed: boolean }> {
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const res = await db
    .prepare(
      `UPDATE job_ledger
       SET status = 'completed',
           lease_until = NULL,
           last_error_code = NULL,
           updated_at = ?
       WHERE idempotency_key = ?
         AND status != 'completed'`,
    )
    .bind(nowMs, input.idempotencyKey.trim())
    .run();

  return { completed: (res.meta?.changes ?? 0) > 0 };
}

export interface FailJobInput {
  readonly idempotencyKey: string;
  readonly errorCode: unknown;
  readonly maxAttempts: number;
  readonly forceDeadLetter?: boolean;
  readonly nowMs?: number;
}

export interface FailJobResult {
  readonly status: "failed" | "dead_letter";
  readonly attempts: number;
  readonly lastErrorCode: string;
  readonly tenantId: string | null;
}

/**
 * Records a sanitized error code, releases the lease, and transitions the job to
 * `failed` (when `attempts < maxAttempts`) or `dead_letter` (when capped or forced).
 */
export async function failJob(db: D1Database, input: FailJobInput): Promise<FailJobResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
  const forceDeadLetter = input.forceDeadLetter ? 1 : 0;
  const sanitizedError = sanitizeErrorCode(input.errorCode);

  const updated = await db
    .prepare(
      `UPDATE job_ledger
       SET status = CASE
             WHEN ? = 1 OR attempts >= ? THEN 'dead_letter'
             ELSE 'failed'
           END,
           lease_until = NULL,
           last_error_code = ?,
           updated_at = ?
       WHERE idempotency_key = ?
         AND status != 'completed'
       RETURNING
         idempotency_key,
         topic,
         tenant_id,
         status,
         attempts,
         lease_until,
         last_error_code,
         created_at,
         updated_at`,
    )
    .bind(forceDeadLetter, maxAttempts, sanitizedError, nowMs, idempotencyKey)
    .first<JobLedgerSqlRow>();

  if (!updated) {
    throw new Error(`JOB_LEDGER_NOT_UPDATABLE: job ${idempotencyKey} not found or already completed`);
  }

  return {
    status: updated.status === "dead_letter" ? "dead_letter" : "failed",
    attempts: updated.attempts,
    lastErrorCode: sanitizedError,
    tenantId: updated.tenant_id,
  };
}

/**
 * Reads a single sanitized `job_ledger` row (excluding raw `payload_json`).
 */
export async function getJobLedgerRecord(
  db: D1Database,
  idempotencyKey: string,
): Promise<JobLedgerRecord | null> {
  const row = await db
    .prepare(
      `SELECT
         idempotency_key,
         topic,
         tenant_id,
         status,
         attempts,
         lease_until,
         last_error_code,
         created_at,
         updated_at
       FROM job_ledger
       WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey.trim())
    .first<JobLedgerSqlRow>();

  return row ? mapLedgerRow(row) : null;
}

export interface ListFailedJobsOptions {
  readonly tenantId?: string;
  readonly topic?: string;
  readonly statuses?: readonly ("failed" | "dead_letter")[];
  readonly limit?: number;
}

const ALLOWED_FAILED_STATUSES = new Set<"failed" | "dead_letter">(["failed", "dead_letter"]);

/**
 * Operator failed-job view returning sanitized metadata rows for `failed` / `dead_letter` jobs.
 * Never selects or returns raw `payload_json`.
 */
export async function listFailedJobs(
  db: D1Database,
  options?: ListFailedJobsOptions,
): Promise<SanitizedFailedJobRow[]> {
  const requestedStatuses = options?.statuses?.filter((s) => ALLOWED_FAILED_STATUSES.has(s));
  const statuses: readonly ("failed" | "dead_letter")[] =
    requestedStatuses && requestedStatuses.length > 0
      ? Array.from(new Set(requestedStatuses))
      : ["failed", "dead_letter"];

  const limit = Math.min(200, Math.max(1, Math.floor(options?.limit ?? 50)));
  const clauses: string[] = [`status IN (${statuses.map(() => "?").join(", ")})`];
  const binds: (string | number)[] = [...statuses];

  if (options?.tenantId !== undefined) {
    clauses.push("tenant_id = ?");
    binds.push(options.tenantId.trim());
  }
  if (options?.topic !== undefined) {
    clauses.push("topic = ?");
    binds.push(options.topic.trim());
  }
  binds.push(limit);

  const query = `
    SELECT
      idempotency_key,
      topic,
      tenant_id,
      status,
      attempts,
      lease_until,
      last_error_code,
      created_at,
      updated_at
    FROM job_ledger
    WHERE ${clauses.join(" AND ")}
    ORDER BY updated_at DESC, idempotency_key ASC
    LIMIT ?
  `;

  const result = await db
    .prepare(query)
    .bind(...binds)
    .all<JobLedgerSqlRow>();

  return result.results.map((row) => ({
    idempotencyKey: row.idempotency_key,
    topic: row.topic,
    tenantId: row.tenant_id,
    status: row.status === "dead_letter" ? "dead_letter" : "failed",
    attempts: row.attempts,
    lastErrorCode: row.last_error_code ? sanitizeErrorCode(row.last_error_code) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
