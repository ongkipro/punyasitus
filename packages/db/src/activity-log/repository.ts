import { REDACTED_VALUE } from "@punyasitus/core/jobs/redact";
import {
  LeadNotFoundError,
  LeadStaleVersionError,
  LeadStorageError,
  LeadValidationError,
} from "../leads/index.ts";
import {
  redactAuditMetadata,
  redactAuditText,
  serializeAuditMetadata,
} from "../platform/audit.ts";

/**
 * Tenant Single-Lead Permanent Deletion & Read-Only Tenant Activity Log Repository
 * (REQ-094, REQ-032, REQ-039; PLAN §5.2, §6, §19.5; TASK-094).
 *
 * Privacy & atomicity invariants:
 * - Permanent single-lead deletion executes inside ONE atomic `TenantStore` batch:
 *   1. `DELETE FROM leads WHERE id = ?` (with optional `AND version = ?` optimistic guard)
 *   2. Conditional PII-free `INSERT INTO tenant_activity_log ... SELECT ... WHERE changes() = 1`
 *   3. `DELETE FROM lead_dedup WHERE lead_id = ?` so zero answer/dedup trace remains
 * - Neither `summary` nor `metadata_json` EVER stores visitor name, phone, email, message,
 *   form answers, consent payload, or internal notes.
 * - Read-side queries over `tenant_activity_log` apply defense-in-depth redaction so legacy
 *   or unexpected rows never expose secrets, tokens, emails, or phone numbers.
 */

export const DEFAULT_ACTIVITY_LOG_LIMIT = 20 as const;
export const MAX_ACTIVITY_LOG_LIMIT = 100 as const;

const SAFE_FILTER_RE = /^[a-z0-9._-]{1,80}$/i;

export class ActivityLogError extends Error {
  readonly status: 404 | 409 | 422 | 503;
  readonly code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "SERVICE_UNAVAILABLE";
  readonly fields: readonly { readonly field: string; readonly code: string; readonly message: string }[];

  constructor(
    status: 404 | 409 | 422 | 503,
    code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "SERVICE_UNAVAILABLE",
    message: string,
    fields: readonly { readonly field: string; readonly code: string; readonly message: string }[] = [],
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ActivityLogError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface DeleteSingleLeadInput {
  readonly leadId: number;
  readonly expectedVersion?: number;
  readonly actorUserId: string | null;
  readonly actorRole: string;
  readonly nowMs?: number;
}

export interface DeleteSingleLeadResult {
  readonly deletedLeadId: number;
  readonly previousStatus: string;
  readonly deletedAtMs: number;
  readonly activityRecorded: boolean;
}

interface RawLeadMetaRow {
  readonly id: number;
  readonly status: string;
  readonly version: number;
}

/**
 * Permanently deletes a single lead (along with its answers, consent snapshot, and dedup row)
 * from the tenant's isolated `TenantStore` while atomically recording a strictly PII-free
 * audit row in `tenant_activity_log` (`WHERE changes() = 1`).
 */
export async function deleteSingleLeadPermanently(
  tenantDb: D1Database,
  input: DeleteSingleLeadInput,
): Promise<DeleteSingleLeadResult> {
  if (!Number.isSafeInteger(input.leadId) || input.leadId < 1 || input.leadId > 2_147_483_647) {
    throw new LeadValidationError("ID pesan masuk harus berupa bilangan bulat positif.", [
      { field: "leadId", code: "INVALID_LEAD_ID", message: "leadId must be a positive integer." },
    ]);
  }

  if (
    input.expectedVersion !== undefined &&
    (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
  ) {
    throw new LeadValidationError("Versi pesan masuk tidak valid.", [
      { field: "version", code: "INVALID_VERSION", message: "version must be a positive integer." },
    ]);
  }

  let current: RawLeadMetaRow | null;
  try {
    // Deliberately select ONLY non-PII columns so deleted PII is never even loaded into memory!
    current = await tenantDb
      .prepare("SELECT id, status, version FROM leads WHERE id = ? LIMIT 1")
      .bind(input.leadId)
      .first<RawLeadMetaRow>();
  } catch {
    throw new LeadStorageError();
  }

  if (!current) {
    throw new LeadNotFoundError(input.leadId);
  }

  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    throw new LeadStaleVersionError(input.leadId, input.expectedVersion, current.version);
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const actorRole = redactAuditText(input.actorRole || "admin").slice(0, 64) || "admin";
  const summary = `Pesan masuk #${input.leadId} dihapus secara permanen`;
  const metadataJson = serializeAuditMetadata({
    leadId: input.leadId,
    previousStatus: current.status,
    permanent: true,
  });

  const deleteLeadStmt =
    input.expectedVersion !== undefined
      ? tenantDb
          .prepare("DELETE FROM leads WHERE id = ? AND version = ? RETURNING id")
          .bind(input.leadId, input.expectedVersion)
      : tenantDb.prepare("DELETE FROM leads WHERE id = ? RETURNING id").bind(input.leadId);

  const auditStmt = tenantDb
    .prepare(
      `INSERT INTO tenant_activity_log (
         actor_user_id, actor_role, action, resource_type, resource_id,
         summary, metadata_json, created_at
       )
       SELECT ?, ?, 'lead.deleted', 'lead', ?, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      input.actorUserId ?? null,
      actorRole,
      String(input.leadId),
      summary,
      metadataJson,
      nowMs,
    );

  // Explicit cleanup of lead_dedup in the same atomic batch in case PRAGMA foreign_keys is off
  const deleteDedupStmt = tenantDb
    .prepare("DELETE FROM lead_dedup WHERE lead_id = ? AND NOT EXISTS (SELECT 1 FROM leads WHERE id = ?)")
    .bind(input.leadId, input.leadId);

  let results: D1Result[];
  try {
    results = await tenantDb.batch([deleteLeadStmt, auditStmt, deleteDedupStmt]);
  } catch (err) {
    if (
      err instanceof LeadValidationError ||
      err instanceof LeadNotFoundError ||
      err instanceof LeadStaleVersionError ||
      err instanceof LeadStorageError
    ) {
      throw err;
    }
    throw new LeadStorageError();
  }

  const deletedRows = results[0]?.results ?? [];
  const auditChanges = results[1]?.meta?.changes ?? 0;

  if (deletedRows.length !== 1) {
    const latest = await tenantDb
      .prepare("SELECT id, status, version FROM leads WHERE id = ? LIMIT 1")
      .bind(input.leadId)
      .first<RawLeadMetaRow>();
    if (!latest) {
      throw new LeadNotFoundError(input.leadId);
    }
    if (input.expectedVersion !== undefined) {
      throw new LeadStaleVersionError(input.leadId, input.expectedVersion, latest.version);
    }
    throw new LeadStorageError();
  }

  return {
    deletedLeadId: input.leadId,
    previousStatus: current.status,
    deletedAtMs: nowMs,
    activityRecorded: auditChanges === 1,
  };
}

export interface TenantActivityLogEntry {
  readonly id: number;
  readonly actorUserId: string | null;
  readonly actorRole: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly createdAtMs: number;
}

export interface ListTenantActivityLogFilter {
  readonly action?: string;
  readonly resourceType?: string;
  readonly actorRole?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface ListTenantActivityLogResult {
  readonly items: readonly TenantActivityLogEntry[];
  readonly totalCount: number;
  readonly page: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

interface RawTenantActivityRow {
  readonly id: number;
  readonly actor_user_id: string | null;
  readonly actor_role: string;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly summary: string;
  readonly metadata_json: string | null;
  readonly created_at: number;
}

function encodeActivityCursor(createdAtMs: number, id: number): string {
  const json = JSON.stringify({ c: createdAtMs, i: id });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeActivityCursor(raw: string): { readonly c: number; readonly i: number } | null {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (padded.length % 4)) % 4;
    const binary = atob(padded + "=".repeat(padLen));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { c?: unknown; i?: unknown };
    if (
      typeof parsed.c === "number" &&
      Number.isFinite(parsed.c) &&
      typeof parsed.i === "number" &&
      Number.isSafeInteger(parsed.i) &&
      parsed.i >= 1
    ) {
      return { c: Math.trunc(parsed.c), i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Defense-in-depth read-side redaction for `tenant_activity_log` records.
 * Guarantees ZERO secrets, emails, phone numbers, or raw deleted lead PII are ever returned.
 */
export function redactTenantActivityRow(row: RawTenantActivityRow): TenantActivityLogEntry {
  let metadata: Readonly<Record<string, unknown>> | null = null;
  if (row.metadata_json) {
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = redactAuditMetadata(parsed as Record<string, unknown>);
      }
    } catch {
      metadata = { malformed: REDACTED_VALUE };
    }
  }

  const normalizedRole = redactAuditText(row.actor_role);
  const isPlatformOperator = normalizedRole.trim().toLowerCase() === "platform_operator";

  return {
    id: Number(row.id),
    actorUserId: isPlatformOperator
      ? null
      : row.actor_user_id
        ? redactAuditText(row.actor_user_id)
        : null,
    actorRole: normalizedRole,
    action: redactAuditText(row.action),
    resourceType: redactAuditText(row.resource_type),
    resourceId: row.resource_id ? redactAuditText(row.resource_id) : null,
    summary: redactAuditText(row.summary),
    metadata,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    createdAtMs: Number(row.created_at),
  };
}

/**
 * Lists read-only, redacted tenant activity log entries from the tenant's isolated `TenantStore`
 * ordered newest-first (`created_at DESC, id DESC`).
 */
export async function listTenantActivityLog(
  tenantDb: D1Database,
  filter: ListTenantActivityLogFilter = {},
): Promise<ListTenantActivityLogResult> {
  const limit = filter.limit ?? DEFAULT_ACTIVITY_LOG_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_LOG_LIMIT) {
    throw new ActivityLogError(
      422,
      "VALIDATION_ERROR",
      `Parameter limit harus berupa bilangan bulat antara 1 hingga ${MAX_ACTIVITY_LOG_LIMIT}.`,
      [{ field: "limit", code: "INVALID_LIMIT", message: "Invalid limit." }],
    );
  }

  const clauses: string[] = [];
  const bindings: (string | number)[] = [];

  if (filter.action && filter.action.trim().length > 0 && filter.action.trim() !== "all") {
    const clean = filter.action.trim();
    if (!SAFE_FILTER_RE.test(clean)) {
      throw new ActivityLogError(422, "VALIDATION_ERROR", "Filter aksi tidak valid.", [
        { field: "action", code: "INVALID_ACTION", message: "Invalid action filter." },
      ]);
    }
    clauses.push("action = ?");
    bindings.push(clean);
  }

  if (
    filter.resourceType &&
    filter.resourceType.trim().length > 0 &&
    filter.resourceType.trim() !== "all"
  ) {
    const clean = filter.resourceType.trim();
    if (!SAFE_FILTER_RE.test(clean)) {
      throw new ActivityLogError(422, "VALIDATION_ERROR", "Filter jenis sumber daya tidak valid.", [
        { field: "resourceType", code: "INVALID_RESOURCE_TYPE", message: "Invalid resourceType filter." },
      ]);
    }
    clauses.push("resource_type = ?");
    bindings.push(clean);
  }

  if (filter.actorRole && filter.actorRole.trim().length > 0 && filter.actorRole.trim() !== "all") {
    const clean = filter.actorRole.trim();
    if (!SAFE_FILTER_RE.test(clean)) {
      throw new ActivityLogError(422, "VALIDATION_ERROR", "Filter peran aktor tidak valid.", [
        { field: "actorRole", code: "INVALID_ACTOR_ROLE", message: "Invalid actorRole filter." },
      ]);
    }
    clauses.push("actor_role = ?");
    bindings.push(clean);
  }

  const countWhereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const countBindings = [...bindings];

  if (filter.cursor && filter.cursor.trim().length > 0) {
    const parsedCursor = decodeActivityCursor(filter.cursor.trim());
    if (!parsedCursor) {
      throw new ActivityLogError(422, "VALIDATION_ERROR", "Parameter cursor tidak valid.", [
        { field: "cursor", code: "INVALID_CURSOR", message: "Invalid cursor." },
      ]);
    }
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    bindings.push(parsedCursor.c, parsedCursor.c, parsedCursor.i);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const [rowsRes, countRes] = await Promise.all([
      tenantDb
        .prepare(
          `SELECT id, actor_user_id, actor_role, action, resource_type, resource_id,
                  summary, metadata_json, created_at
           FROM tenant_activity_log
           ${whereSql}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .bind(...bindings, limit + 1)
        .all<RawTenantActivityRow>(),
      tenantDb
        .prepare(`SELECT COUNT(*) AS cnt FROM tenant_activity_log ${countWhereSql}`)
        .bind(...countBindings)
        .first<{ readonly cnt: number }>(),
    ]);

    const rawRows = rowsRes.results ?? [];
    const hasMore = rawRows.length > limit;
    const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
    const items = pageRows.map(redactTenantActivityRow);
    const last = items[items.length - 1];

    return {
      items,
      totalCount: Number(countRes?.cnt ?? 0),
      page: {
        limit,
        hasMore,
        nextCursor: hasMore && last ? encodeActivityCursor(last.createdAtMs, last.id) : null,
      },
    };
  } catch (err) {
    if (err instanceof ActivityLogError) throw err;
    throw new ActivityLogError(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memuat log aktivitas situs.",
      [],
      err,
    );
  }
}

/**
 * Appends a sanitized, PII-free activity entry into `tenant_activity_log`.
 */
export async function appendTenantActivityLog(
  tenantDb: D1Database,
  input: {
    readonly actorUserId: string | null;
    readonly actorRole: string;
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId?: string | null;
    readonly summary: string;
    readonly metadata?: Readonly<Record<string, unknown>> | null;
    readonly nowMs?: number;
  },
): Promise<void> {
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const normalizedRole = redactAuditText(input.actorRole).slice(0, 64) || "system";
  const safeActorUserId =
    normalizedRole.toLowerCase() === "platform_operator" ? null : (input.actorUserId ?? null);
  await tenantDb
    .prepare(
      `INSERT INTO tenant_activity_log (
         actor_user_id, actor_role, action, resource_type, resource_id,
         summary, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      safeActorUserId,
      normalizedRole,
      redactAuditText(input.action).slice(0, 120),
      redactAuditText(input.resourceType).slice(0, 64),
      input.resourceId ? redactAuditText(input.resourceId).slice(0, 128) : null,
      redactAuditText(input.summary).slice(0, 500),
      serializeAuditMetadata(input.metadata),
      nowMs,
    )
    .run();
}
