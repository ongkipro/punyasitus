/**
 * Atomic idempotent lead persistence and deduplication in `TenantStore` (PLAN §5.2, §6, REQ-038).
 *
 * Uses `lead_dedup` (`idempotency_key`, `payload_hash`, `lead_id`, `expires_at`, `created_at`)
 * alongside `sequences` and `leads` inside `TenantStore`'s synchronous `transactionSync` batch:
 * - First submission persists lead + dedup row atomically (`201`, `kind: "created"`).
 * - Matching retry (same key + same canonical SHA-256 payload hash, unexpired) replays
 *   the original `leadId` without creating a duplicate lead row (`201`, `kind: "replayed"`).
 * - Conflicting payload with the same active key returns `409 IDEMPOTENCY_CONFLICT`.
 * - Expired entries (`expires_at <= nowMs`) are pruned and replaced cleanly.
 * - Any datastore failure fails closed (`503 SERVICE_UNAVAILABLE`); never returns false success.
 */

export const DEFAULT_LEAD_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

export interface LeadInsertInput {
  readonly formId?: number | null;
  readonly formSnapshotJson?: string | null;
  readonly name: string;
  readonly phoneE164: string;
  readonly email?: string | null;
  readonly message: string;
  readonly preferredDate?: string | null;
  readonly preferredTime?: "pagi" | "siang" | "sore" | "malam" | null;
  readonly branchId?: number | null;
  readonly sourceCategory?: string;
  readonly utmJson?: string | null;
  readonly pagePath?: string | null;
}

export interface LeadDedupDatastoreUnavailable {
  readonly ok: false;
  readonly kind: "datastore_unavailable";
  readonly status: 503;
  readonly code: "SERVICE_UNAVAILABLE";
  readonly message: string;
}

export interface LeadDedupInvalidKey {
  readonly ok: false;
  readonly kind: "invalid_key";
  readonly status: 422;
  readonly code: "VALIDATION_ERROR";
  readonly message: string;
}

export interface LeadDedupReplayed {
  readonly ok: true;
  readonly kind: "replayed";
  readonly status: 201;
  readonly leadId: number;
  readonly payloadHash: string;
  readonly expiresAt: number;
}

export interface LeadDedupConflict {
  readonly ok: true;
  readonly kind: "conflict";
  readonly status: 409;
  readonly code: "IDEMPOTENCY_CONFLICT";
  readonly message: string;
}

export interface LeadDedupCreated {
  readonly ok: true;
  readonly kind: "created";
  readonly status: 201;
  readonly leadId: number;
  readonly payloadHash: string;
  readonly expiresAt: number;
}

export interface LeadDedupProceed {
  readonly ok: true;
  readonly kind: "proceed";
  readonly prunedExpired: boolean;
}

export type CheckLeadIdempotencyResult =
  | LeadDedupProceed
  | LeadDedupReplayed
  | LeadDedupConflict
  | LeadDedupInvalidKey
  | LeadDedupDatastoreUnavailable;

export type ExecuteIdempotentLeadWriteResult =
  | LeadDedupCreated
  | LeadDedupReplayed
  | LeadDedupConflict
  | LeadDedupInvalidKey
  | LeadDedupDatastoreUnavailable;

interface LeadDedupSqlRow {
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly lead_id: number;
  readonly expires_at: number;
  readonly created_at: number;
}

const DATASTORE_UNAVAILABLE_RESULT: LeadDedupDatastoreUnavailable = {
  ok: false,
  kind: "datastore_unavailable",
  status: 503,
  code: "SERVICE_UNAVAILABLE",
  message: "Layanan penyimpanan sementara tidak tersedia. Silakan coba lagi.",
};

const IDEMPOTENCY_CONFLICT_RESULT: LeadDedupConflict = {
  ok: true,
  kind: "conflict",
  status: 409,
  code: "IDEMPOTENCY_CONFLICT",
  message: "Idempotency-Key telah digunakan sebelumnya dengan isi permintaan yang berbeda.",
};

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function normalizeIdempotencyKey(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return null;
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f) {
      return null;
    }
  }
  return trimmed.toLowerCase();
}

/**
 * Serializes any JSON-compatible value into a deterministic canonical string
 * (sorted object keys, `undefined` object properties omitted, array order preserved).
 */
export function canonicalizeLeadPayload(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => canonicalizeLeadPayload(item));
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const prop = record[key];
      if (prop === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${canonicalizeLeadPayload(prop)}`);
    }
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * Computes a deterministic lowercase hex SHA-256 digest over the canonical JSON
 * representation of a lead payload.
 */
export async function hashLeadPayload(payload: unknown): Promise<string> {
  const canonical = canonicalizeLeadPayload(payload);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return bytesToHex(new Uint8Array(digest));
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed|SQLITE_CONSTRAINT/i.test(
    err.message,
  );
}

export interface CheckLeadIdempotencyInput {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly nowMs?: number;
}

/**
 * Checks whether an active `lead_dedup` entry exists for `idempotencyKey`.
 * Prunes an expired entry (`expires_at <= nowMs`) cleanly so the key can be reused.
 */
export async function checkOrClaimLeadIdempotency(
  db: D1Database | null | undefined,
  input: CheckLeadIdempotencyInput,
): Promise<CheckLeadIdempotencyResult> {
  const normalizedKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (!normalizedKey) {
    return {
      ok: false,
      kind: "invalid_key",
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Idempotency-Key tidak valid.",
    };
  }
  const payloadHash = input.payloadHash.trim().toLowerCase();
  if (!payloadHash) {
    throw new RangeError("INVALID_PAYLOAD_HASH: payloadHash must be non-empty");
  }

  if (!db) {
    return DATASTORE_UNAVAILABLE_RESULT;
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());

  try {
    const existing = await db
      .prepare(
        `SELECT idempotency_key, payload_hash, lead_id, expires_at, created_at
         FROM lead_dedup
         WHERE idempotency_key = ?`,
      )
      .bind(normalizedKey)
      .first<LeadDedupSqlRow>();

    if (!existing) {
      return { ok: true, kind: "proceed", prunedExpired: false };
    }

    const expiresAt = Number(existing.expires_at);
    if (expiresAt <= nowMs) {
      await db
        .prepare("DELETE FROM lead_dedup WHERE idempotency_key = ? AND expires_at <= ?")
        .bind(normalizedKey, nowMs)
        .run();
      return { ok: true, kind: "proceed", prunedExpired: true };
    }

    if (existing.payload_hash === payloadHash) {
      return {
        ok: true,
        kind: "replayed",
        status: 201,
        leadId: Number(existing.lead_id),
        payloadHash: existing.payload_hash,
        expiresAt,
      };
    }

    return IDEMPOTENCY_CONFLICT_RESULT;
  } catch {
    return DATASTORE_UNAVAILABLE_RESULT;
  }
}

export interface ExecuteIdempotentLeadWriteInput {
  readonly idempotencyKey: string;
  readonly lead: LeadInsertInput;
  /**
   * Optional raw payload to hash for conflict comparison. Defaults to `lead`.
   */
  readonly payload?: unknown;
  /**
   * Optional pre-computed SHA-256 hex payload hash.
   */
  readonly payloadHash?: string;
  readonly ttlMs?: number;
  readonly nowMs?: number;
}

/**
 * Atomically executes an idempotent lead submission against `TenantStore`:
 * 1. Replays active matching `(idempotency_key, payload_hash)` without inserting a new row.
 * 2. Rejects active mismatched `payload_hash` with `409 IDEMPOTENCY_CONFLICT`.
 * 3. Prunes expired entry, allocates sequential `leads` ID, inserts `leads`, and inserts
 *    `lead_dedup` in a single atomic `db.batch()` (`transactionSync` in `TenantStore`).
 * 4. If a parallel race hits `UNIQUE constraint failed` on `lead_dedup.idempotency_key`,
 *    SQLite rolls back the entire duplicate batch cleanly and re-reads the winning row.
 * 5. Any datastore outage fails closed (`503 SERVICE_UNAVAILABLE`).
 */
export async function executeIdempotentLeadWrite(
  db: D1Database | null | undefined,
  input: ExecuteIdempotentLeadWriteInput,
): Promise<ExecuteIdempotentLeadWriteResult> {
  const normalizedKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (!normalizedKey) {
    return {
      ok: false,
      kind: "invalid_key",
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Idempotency-Key tidak valid.",
    };
  }

  const ttlMs = input.ttlMs ?? DEFAULT_LEAD_DEDUP_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000) {
    throw new RangeError("INVALID_DEDUP_TTL: ttlMs must be an integer >= 1000");
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const expiresAt = nowMs + ttlMs;
  const payloadHash = input.payloadHash
    ? input.payloadHash.trim().toLowerCase()
    : await hashLeadPayload(input.payload ?? input.lead);

  if (!db) {
    return DATASTORE_UNAVAILABLE_RESULT;
  }

  const precheck = await checkOrClaimLeadIdempotency(db, {
    idempotencyKey: normalizedKey,
    payloadHash,
    nowMs,
  });
  if (!precheck.ok || precheck.kind !== "proceed") {
    return precheck;
  }

  const lead = input.lead;

  try {
    const results = await db.batch<{ id?: number }>([
      db
        .prepare("DELETE FROM lead_dedup WHERE idempotency_key = ? AND expires_at <= ?")
        .bind(normalizedKey, nowMs),
      db
        .prepare(
          `INSERT INTO sequences (kind, next)
           VALUES ('leads', 1)
           ON CONFLICT(kind) DO UPDATE SET next = next + 1`,
        ),
      db
        .prepare(
          `INSERT INTO leads (
             id,
             form_id,
             form_snapshot_json,
             name,
             phone_e164,
             email,
             message,
             preferred_date,
             preferred_time,
             branch_id,
             source_category,
             utm_json,
             page_path,
             status,
             internal_notes,
             version,
             created_at,
             updated_at
           )
           VALUES (
             (SELECT next FROM sequences WHERE kind = 'leads'),
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, 1, ?, ?
           )
           RETURNING id`,
        )
        .bind(
          lead.formId ?? null,
          lead.formSnapshotJson ?? null,
          lead.name,
          lead.phoneE164,
          lead.email ?? null,
          lead.message,
          lead.preferredDate ?? null,
          lead.preferredTime ?? null,
          lead.branchId ?? null,
          lead.sourceCategory ?? "direct",
          lead.utmJson ?? null,
          lead.pagePath ?? null,
          nowMs,
          nowMs,
        ),
      db
        .prepare(
          `INSERT INTO lead_dedup (
             idempotency_key,
             payload_hash,
             lead_id,
             expires_at,
             created_at
           )
           VALUES (
             ?,
             ?,
             (SELECT next FROM sequences WHERE kind = 'leads'),
             ?,
             ?
           )`,
        )
        .bind(normalizedKey, payloadHash, expiresAt, nowMs),
    ]);

    const insertedRow = results[2]?.results?.[0];
    const leadId = Number(insertedRow?.id ?? 0);
    if (!Number.isInteger(leadId) || leadId < 1) {
      return DATASTORE_UNAVAILABLE_RESULT;
    }

    return {
      ok: true,
      kind: "created",
      status: 201,
      leadId,
      payloadHash,
      expiresAt,
    };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const winner = await checkOrClaimLeadIdempotency(db, {
        idempotencyKey: normalizedKey,
        payloadHash,
        nowMs,
      });
      if (!winner.ok) return winner;
      if (winner.kind === "replayed" || winner.kind === "conflict") {
        return winner;
      }
    }
    return DATASTORE_UNAVAILABLE_RESULT;
  }
}

/**
 * Deletes expired entries (`expires_at <= nowMs`) from `lead_dedup`.
 */
export async function pruneExpiredLeadDedup(
  db: D1Database | null | undefined,
  nowMs: number = Date.now(),
): Promise<{ readonly ok: true; readonly deleted: number } | LeadDedupDatastoreUnavailable> {
  if (!db) {
    return DATASTORE_UNAVAILABLE_RESULT;
  }
  try {
    const res = await db
      .prepare("DELETE FROM lead_dedup WHERE expires_at <= ?")
      .bind(Math.floor(nowMs))
      .run();
    return { ok: true, deleted: res.meta?.changes ?? 0 };
  } catch {
    return DATASTORE_UNAVAILABLE_RESULT;
  }
}
