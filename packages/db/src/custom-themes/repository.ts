import {
  CUSTOM_THEME_DAILY_REQUEST_LIMIT,
  CUSTOM_THEME_TERMINAL_STATUSES,
  CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL,
  SETUP_SERVICE_SEAT_FULL_EXPLANATION,
  computeCustomThemeDayBucket,
  formatCustomThemeStartingPriceLabel,
  isAllowedCustomThemeStatusTransition,
  type ContactPreference,
  type CustomThemePackageRecord,
  type CustomThemeRequestRecord,
  type CustomThemeRequestStatus,
  type ServiceKind,
  type StaffAccessState,
  type ValidatedCreateCustomThemePackageInput,
  type ValidatedCreateCustomThemeRequestInput,
  type ValidatedTransitionCustomThemeRequestInput,
  type ValidatedUpdateCustomThemePackageInput,
} from "@punyasitus/core/custom-themes/index";
import { buildPlatformAuditStatement, type PlatformAuditRecord } from "../platform/audit.ts";

const MAX_TENANT_SEAT_CAP = 5 as const;

/**
 * Authoritative `PLATFORM_DB` repository for Custom Theme Service Packages & Requests
 * (REQ-063, REQ-070, PLAN §5.1, §11.4, §13, TASK-061).
 *
 * Security & Concurrency Invariants:
 * - ZERO runtime DDL: assumes `0016_custom_theme_service.sql` is applied via migrations.
 * - Tenant queries ALWAYS scope by `WHERE tenant_id = ?`.
 * - Request submission enforces atomic 3-requests-per-day-per-tenant cap inside a single SQLite
 *   statement (`WHERE (SELECT COUNT(*) ...) < 3`) and idempotent replay via
 *   `UNIQUE (tenant_id, service_kind, idempotency_key)`.
 * - Console package CRUD and request status transitions require optimistic `expectedVersion`,
 *   mandatory 10–500 char audit reason, and commit `platform_audit` inside the SAME `db.batch([...])`
 *   with `WHERE changes() = 1` (`onlyIfPreviousChanged: true`).
 * - Marking a request `delivered` atomically verifies an active custom `theme_catalog` +
 *   `tenant_theme_entitlements` row for that exact `tenant_id`.
 * - Deactivating packages sets `active = 0` and NEVER deletes referenced rows.
 */

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateUlid(nowMs: number = Date.now()): string {
  const timeChars = new Array<string>(10);
  let t = Math.max(0, Math.trunc(nowMs));
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = CROCKFORD_BASE32[t % 32] ?? "0";
    t = Math.floor(t / 32);
  }
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const randChars = new Array<string>(16);
  for (let i = 0; i < 16; i += 1) {
    randChars[i] = CROCKFORD_BASE32[(randomBytes[i] ?? 0) & 31] ?? "0";
  }
  return `${timeChars.join("")}${randChars.join("")}`;
}

export type CustomThemeRepositoryErrorCode =
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "PACKAGE_SLUG_EXISTS"
  | "PACKAGE_INACTIVE"
  | "INVALID_PACKAGE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "DAILY_REQUEST_LIMIT_REACHED"
  | "INVALID_STATUS_TRANSITION"
  | "THEME_GRANT_REQUIRED"
  | "STAFF_USER_NOT_FOUND"
  | "STAFF_NOT_ACTIVE_OPERATOR"
  | "STAFF_ALREADY_MEMBER"
  | "STAFF_ALREADY_ASSIGNED"
  | "STAFF_NOT_ASSIGNED"
  | "INVALID_STAFF_ACCESS_STATE";

export class CustomThemeRepositoryError extends Error {
  readonly status: 404 | 409 | 422 | 429;
  readonly code: CustomThemeRepositoryErrorCode;

  constructor(
    status: 404 | 409 | 422 | 429,
    code: CustomThemeRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CustomThemeRepositoryError";
    this.status = status;
    this.code = code;
  }
}

interface PackageSqlRow {
  readonly id: string;
  readonly service_kind: ServiceKind;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly inclusions_json: string;
  readonly starting_price_idr: number | null;
  readonly estimated_duration: string;
  readonly sort_order: number;
  readonly active: number;
  readonly created_by_user_id: string | null;
  readonly updated_by_user_id: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RequestSqlRow {
  readonly id: string;
  readonly request_code: string;
  readonly service_kind: ServiceKind;
  readonly tenant_id: string;
  readonly tenant_handle: string;
  readonly package_id: string | null;
  readonly package_name_snapshot: string;
  readonly requested_by_user_id: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly day_bucket: string;
  readonly status: CustomThemeRequestStatus;
  readonly brand_name: string;
  readonly brief: string;
  readonly reference_urls_json: string;
  readonly budget_range: string | null;
  readonly contact_preference: ContactPreference;
  readonly delivered_theme_id: string | null;
  readonly delivered_theme_grant_id: string | null;
  readonly status_reason: string | null;
  readonly operator_notes: string | null;
  readonly staff_user_id: string | null;
  readonly staff_email_snapshot: string | null;
  readonly staff_name_snapshot: string | null;
  readonly staff_access_state: StaffAccessState | null;
  readonly staff_approved_by_user_id: string | null;
  readonly staff_approved_at: number | null;
  readonly staff_member_id: string | null;
  readonly staff_joined_at: number | null;
  readonly staff_revoked_at: number | null;
  readonly staff_wait_reason: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface TenantCustomThemeGrantSummary {
  readonly grantId: string;
  readonly tenantId: string;
  readonly themeId: string;
  readonly slug: string;
  readonly name: string;
  readonly grantedAtMs: number;
  readonly grantedAtIso: string;
}

interface RawCustomThemeGrantRow {
  readonly grant_id: string;
  readonly tenant_id: string;
  readonly theme_id: string;
  readonly slug: string;
  readonly name: string;
  readonly granted_at: number;
}

const PACKAGE_SELECT_COLUMNS = `
  id,
  service_kind,
  slug,
  name,
  description,
  inclusions_json,
  starting_price_idr,
  estimated_duration,
  sort_order,
  active,
  created_by_user_id,
  updated_by_user_id,
  version,
  created_at,
  updated_at
`.trim();

const REQUEST_SELECT_COLUMNS = `
  id,
  request_code,
  service_kind,
  tenant_id,
  tenant_handle,
  package_id,
  package_name_snapshot,
  requested_by_user_id,
  idempotency_key,
  request_hash,
  day_bucket,
  status,
  brand_name,
  brief,
  reference_urls_json,
  budget_range,
  contact_preference,
  delivered_theme_id,
  delivered_theme_grant_id,
  status_reason,
  operator_notes,
  staff_user_id,
  staff_email_snapshot,
  staff_name_snapshot,
  staff_access_state,
  staff_approved_by_user_id,
  staff_approved_at,
  staff_member_id,
  staff_joined_at,
  staff_revoked_at,
  staff_wait_reason,
  version,
  created_at,
  updated_at
`.trim();

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

function parseStringArrayJson(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    }
  } catch {
    // ignore malformed json
  }
  return [];
}

function mapPackageRow(row: PackageSqlRow): CustomThemePackageRecord {
  const startingPriceIdr =
    row.starting_price_idr === null || row.starting_price_idr === undefined
      ? null
      : Number(row.starting_price_idr);
  return {
    id: row.id,
    serviceKind: row.service_kind,
    slug: row.slug,
    name: row.name,
    description: row.description,
    inclusions: parseStringArrayJson(row.inclusions_json),
    startingPriceIdr,
    priceLabel: formatCustomThemeStartingPriceLabel(startingPriceIdr),
    estimatedDuration: row.estimated_duration,
    sortOrder: Number(row.sort_order),
    active: Number(row.active) === 1,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    version: Number(row.version),
    createdAtMs: Number(row.created_at),
    updatedAtMs: Number(row.updated_at),
    createdAtIso: new Date(Number(row.created_at)).toISOString(),
    updatedAtIso: new Date(Number(row.updated_at)).toISOString(),
  };
}

function mapRequestRow(row: RequestSqlRow): CustomThemeRequestRecord {
  const approvedAtMs =
    row.staff_approved_at === null || row.staff_approved_at === undefined
      ? null
      : Number(row.staff_approved_at);
  const joinedAtMs =
    row.staff_joined_at === null || row.staff_joined_at === undefined
      ? null
      : Number(row.staff_joined_at);
  const revokedAtMs =
    row.staff_revoked_at === null || row.staff_revoked_at === undefined
      ? null
      : Number(row.staff_revoked_at);

  return {
    id: row.id,
    requestCode: row.request_code,
    serviceKind: row.service_kind,
    tenantId: row.tenant_id,
    tenantHandle: row.tenant_handle,
    packageId: row.package_id,
    packageName: row.package_name_snapshot,
    requestedByUserId: row.requested_by_user_id,
    idempotencyKey: row.idempotency_key,
    dayBucket: row.day_bucket,
    status: row.status,
    brandName: row.brand_name,
    brief: row.brief,
    referenceUrls: parseStringArrayJson(row.reference_urls_json),
    budgetRange: row.budget_range,
    contactPreference: row.contact_preference,
    deliveredThemeId: row.delivered_theme_id,
    deliveredThemeGrantId: row.delivered_theme_grant_id,
    statusReason: row.status_reason,
    operatorNotes: row.operator_notes,
    staffUserId: row.staff_user_id ?? null,
    staffEmail: row.staff_email_snapshot ?? null,
    staffName: row.staff_name_snapshot ?? null,
    staffAccessState: (row.staff_access_state ?? "none") as StaffAccessState,
    staffApprovedByUserId: row.staff_approved_by_user_id ?? null,
    staffApprovedAtMs: approvedAtMs,
    staffApprovedAtIso: approvedAtMs !== null ? new Date(approvedAtMs).toISOString() : null,
    staffMemberId: row.staff_member_id ?? null,
    staffJoinedAtMs: joinedAtMs,
    staffJoinedAtIso: joinedAtMs !== null ? new Date(joinedAtMs).toISOString() : null,
    staffRevokedAtMs: revokedAtMs,
    staffRevokedAtIso: revokedAtMs !== null ? new Date(revokedAtMs).toISOString() : null,
    staffWaitReason: row.staff_wait_reason ?? null,
    version: Number(row.version),
    createdAtMs: Number(row.created_at),
    updatedAtMs: Number(row.updated_at),
    createdAtIso: new Date(Number(row.created_at)).toISOString(),
    updatedAtIso: new Date(Number(row.updated_at)).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Packages (Superadmin CRUD + Tenant Active Read)
// ---------------------------------------------------------------------------

export async function listCustomThemePackages(
  db: D1Database,
  options: {
    readonly serviceKind?: ServiceKind;
    readonly activeOnly?: boolean;
    readonly limit?: number;
  } = {},
): Promise<readonly CustomThemePackageRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (options.serviceKind) {
    conditions.push("service_kind = ?");
    binds.push(options.serviceKind);
  }
  if (options.activeOnly) {
    conditions.push("active = 1");
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db
    .prepare(
      `SELECT ${PACKAGE_SELECT_COLUMNS}
       FROM custom_theme_packages
       ${whereSql}
       ORDER BY sort_order ASC, created_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(...binds, safeLimit)
    .all<PackageSqlRow>();

  return (rows.results ?? []).map(mapPackageRow);
}

export async function getCustomThemePackageById(
  db: D1Database,
  packageId: string,
): Promise<CustomThemePackageRecord | null> {
  const cleanId = packageId.trim();
  if (!cleanId) return null;
  const row = await db
    .prepare(
      `SELECT ${PACKAGE_SELECT_COLUMNS}
       FROM custom_theme_packages
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(cleanId)
    .first<PackageSqlRow>();
  return row ? mapPackageRow(row) : null;
}

export async function createCustomThemePackage(
  db: D1Database,
  params: {
    readonly input: ValidatedCreateCustomThemePackageInput;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly requestId: string;
    readonly nowMs: number;
  },
): Promise<{ readonly pkg: CustomThemePackageRecord; readonly audit: PlatformAuditRecord }> {
  const nowMs = Math.trunc(params.nowMs);
  const pkgId = generateUlid(nowMs);
  const { input } = params;

  const insertStmt = db
    .prepare(
      `INSERT INTO custom_theme_packages (
         id,
         service_kind,
         slug,
         name,
         description,
         inclusions_json,
         starting_price_idr,
         estimated_duration,
         sort_order,
         active,
         created_by_user_id,
         updated_by_user_id,
         version,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      pkgId,
      input.serviceKind,
      input.slug,
      input.name,
      input.description,
      JSON.stringify(input.inclusions),
      input.startingPriceIdr,
      input.estimatedDuration,
      input.sortOrder,
      input.active ? 1 : 0,
      params.actorUserId,
      params.actorUserId,
      nowMs,
      nowMs,
    );

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "custom_theme.package.created",
      targetType: "custom_theme_package",
      targetId: pkgId,
      reason: input.reason,
      requireReason: true,
      outcome: "success",
      requestId: params.requestId,
      metadata: {
        serviceKind: input.serviceKind,
        slug: input.slug,
        name: input.name,
        startingPriceIdr: input.startingPriceIdr,
        sortOrder: input.sortOrder,
        active: input.active,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  try {
    await db.batch([insertStmt, auditStmt]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new CustomThemeRepositoryError(
        409,
        "PACKAGE_SLUG_EXISTS",
        `Slug paket "${input.slug}" sudah terdaftar.`,
      );
    }
    throw err;
  }

  const created = await getCustomThemePackageById(db, pkgId);
  if (!created) {
    throw new Error("CUSTOM_THEME_PACKAGE_INSERT_READBACK_FAILED");
  }
  return { pkg: created, audit };
}

export async function updateCustomThemePackage(
  db: D1Database,
  params: {
    readonly packageId: string;
    readonly input: ValidatedUpdateCustomThemePackageInput;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly requestId: string;
    readonly nowMs: number;
  },
): Promise<{ readonly pkg: CustomThemePackageRecord; readonly audit: PlatformAuditRecord }> {
  const existing = await getCustomThemePackageById(db, params.packageId);
  if (!existing) {
    throw new CustomThemeRepositoryError(404, "NOT_FOUND", "Paket tema kustom tidak ditemukan.");
  }
  if (existing.version !== params.input.expectedVersion) {
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Versi paket sudah berubah. Muat ulang data sebelum menyimpan perubahan.",
    );
  }

  const nowMs = Math.trunc(params.nowMs);
  const { input } = params;
  const nextName = input.name ?? existing.name;
  const nextDescription = input.description ?? existing.description;
  const nextInclusions = input.inclusions ?? existing.inclusions;
  const nextStartingPrice =
    input.startingPriceIdr !== undefined ? input.startingPriceIdr : existing.startingPriceIdr;
  const nextDuration = input.estimatedDuration ?? existing.estimatedDuration;
  const nextSortOrder = input.sortOrder ?? existing.sortOrder;
  const nextActive = input.active ?? existing.active;

  const updateStmt = db
    .prepare(
      `UPDATE custom_theme_packages
       SET name = ?,
           description = ?,
           inclusions_json = ?,
           starting_price_idr = ?,
           estimated_duration = ?,
           sort_order = ?,
           active = ?,
           updated_by_user_id = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND version = ?`,
    )
    .bind(
      nextName,
      nextDescription,
      JSON.stringify(nextInclusions),
      nextStartingPrice,
      nextDuration,
      nextSortOrder,
      nextActive ? 1 : 0,
      params.actorUserId,
      nowMs,
      existing.id,
      input.expectedVersion,
    );

  const action =
    input.active === false && existing.active
      ? "custom_theme.package.deactivated"
      : input.active === true && !existing.active
        ? "custom_theme.package.activated"
        : "custom_theme.package.updated";

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action,
      targetType: "custom_theme_package",
      targetId: existing.id,
      reason: input.reason,
      requireReason: true,
      outcome: "success",
      requestId: params.requestId,
      metadata: {
        slug: existing.slug,
        previousVersion: existing.version,
        nextVersion: existing.version + 1,
        startingPriceIdr: nextStartingPrice,
        sortOrder: nextSortOrder,
        active: nextActive,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const results = await db.batch([updateStmt, auditStmt]);
  const updatedChanges = results[0]?.meta?.changes ?? 0;
  if (updatedChanges !== 1) {
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Paket berubah secara bersamaan. Muat ulang dan coba lagi.",
    );
  }

  const updated = await getCustomThemePackageById(db, existing.id);
  if (!updated) {
    throw new Error("CUSTOM_THEME_PACKAGE_UPDATE_READBACK_FAILED");
  }
  return { pkg: updated, audit };
}

// ---------------------------------------------------------------------------
// Tenant Requests (Scoped Read, Atomic Daily Cap, Idempotent Submit)
// ---------------------------------------------------------------------------

export async function countTenantDailyCustomThemeRequests(
  db: D1Database,
  params: {
    readonly tenantId: string;
    readonly serviceKind?: ServiceKind;
    readonly dayBucket: string;
  },
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM custom_theme_requests
       WHERE tenant_id = ?
         AND service_kind = ?
         AND day_bucket = ?`,
    )
    .bind(params.tenantId, params.serviceKind ?? "custom_theme", params.dayBucket)
    .first<{ readonly cnt: number }>();
  return Number(row?.cnt ?? 0);
}

export async function listTenantCustomThemeRequests(
  db: D1Database,
  params: {
    readonly tenantId: string;
    readonly serviceKind?: ServiceKind;
    readonly limit?: number;
  },
): Promise<readonly CustomThemeRequestRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 50)));
  const rows = await db
    .prepare(
      `SELECT ${REQUEST_SELECT_COLUMNS}
       FROM custom_theme_requests
       WHERE tenant_id = ?
         AND service_kind = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(params.tenantId, params.serviceKind ?? "custom_theme", safeLimit)
    .all<RequestSqlRow>();

  return (rows.results ?? []).map(mapRequestRow);
}

export async function getTenantCustomThemeRequestById(
  db: D1Database,
  params: { readonly tenantId: string; readonly requestId: string },
): Promise<CustomThemeRequestRecord | null> {
  const cleanId = params.requestId.trim();
  if (!cleanId) return null;
  const row = await db
    .prepare(
      `SELECT ${REQUEST_SELECT_COLUMNS}
       FROM custom_theme_requests
       WHERE id = ?
         AND tenant_id = ?
       LIMIT 1`,
    )
    .bind(cleanId, params.tenantId)
    .first<RequestSqlRow>();
  return row ? mapRequestRow(row) : null;
}

async function computeCustomThemeRequestHash(
  input: ValidatedCreateCustomThemeRequestInput,
): Promise<string> {
  const canonical = JSON.stringify({
    serviceKind: input.serviceKind,
    packageId: input.packageId,
    brandName: input.brandName,
    brief: input.brief,
    referenceUrls: input.referenceUrls,
    budgetRange: input.budgetRange,
    contactPreference: input.contactPreference,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

async function getTenantCustomThemeRequestRowByIdempotencyKey(
  db: D1Database,
  params: {
    readonly tenantId: string;
    readonly serviceKind: ServiceKind;
    readonly idempotencyKey: string;
  },
): Promise<RequestSqlRow | null> {
  const row = await db
    .prepare(
      `SELECT ${REQUEST_SELECT_COLUMNS}
       FROM custom_theme_requests
       WHERE tenant_id = ?
         AND service_kind = ?
         AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(params.tenantId, params.serviceKind, params.idempotencyKey)
    .first<RequestSqlRow>();
  return row ?? null;
}

export interface SubmitCustomThemeRequestResult {
  readonly request: CustomThemeRequestRecord;
  readonly created: boolean;
  readonly dailyUsedCount: number;
  readonly dailyLimit: number;
}

/**
 * Atomically submits a tenant-scoped custom theme request enforcing:
 * 1. Idempotent replay per `(tenant_id, service_kind, idempotency_key)` with SHA-256
 *    payload verification (`200` on matching payload even at daily cap; `409 IDEMPOTENCY_KEY_REUSED`
 *    when the same key is reused with a different payload).
 * 2. Active package verification (when a specific package is selected).
 * 3. Atomic 3-requests-per-day-per-tenant cap enforced inside SQLite (`WHERE (SELECT COUNT(*) ...) < 3`).
 */
export async function submitTenantCustomThemeRequest(
  db: D1Database,
  params: {
    readonly tenantId: string;
    readonly tenantHandle: string;
    readonly requestedByUserId: string;
    readonly input: ValidatedCreateCustomThemeRequestInput;
    readonly nowMs: number;
  },
): Promise<SubmitCustomThemeRequestResult> {
  const nowMs = Math.trunc(params.nowMs);
  const dayBucket = computeCustomThemeDayBucket(nowMs);
  const { input } = params;
  const requestHash = await computeCustomThemeRequestHash(input);

  // 1. Fast-path idempotent replay with payload hash guard
  const existingReplayRow = await getTenantCustomThemeRequestRowByIdempotencyKey(db, {
    tenantId: params.tenantId,
    serviceKind: input.serviceKind,
    idempotencyKey: input.idempotencyKey,
  });
  if (existingReplayRow) {
    if (existingReplayRow.request_hash !== requestHash) {
      throw new CustomThemeRepositoryError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah digunakan untuk permintaan dengan isi yang berbeda. Gunakan kunci baru untuk permintaan baru.",
      );
    }
    const dailyUsedCount = await countTenantDailyCustomThemeRequests(db, {
      tenantId: params.tenantId,
      serviceKind: input.serviceKind,
      dayBucket,
    });
    return {
      request: mapRequestRow(existingReplayRow),
      created: false,
      dailyUsedCount,
      dailyLimit: CUSTOM_THEME_DAILY_REQUEST_LIMIT,
    };
  }

  // 2. Resolve optional package snapshot
  const serviceLabel =
    input.serviceKind === "setup" ? "Layanan Terima Beres" : "tema kustom";
  let packageNameSnapshot: string = CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL;
  if (input.packageId !== null) {
    const pkg = await getCustomThemePackageById(db, input.packageId);
    if (!pkg || pkg.serviceKind !== input.serviceKind) {
      throw new CustomThemeRepositoryError(
        422,
        "INVALID_PACKAGE",
        `Paket ${serviceLabel} yang dipilih tidak ditemukan.`,
      );
    }
    if (!pkg.active) {
      throw new CustomThemeRepositoryError(
        422,
        "PACKAGE_INACTIVE",
        `Paket ${serviceLabel} yang dipilih sudah tidak aktif. Pilih paket lain atau konsultasi.`,
      );
    }
    packageNameSnapshot = pkg.name;
  }

  // 3. Atomic conditional INSERT enforcing 3/day cap + active package inside a single SQLite batch
  const requestId = generateUlid(nowMs);
  const requestPrefix =
    input.serviceKind === "setup"
      ? "TBR"
      : input.serviceKind === "custom_plugin"
        ? "CPR"
        : "CTR";
  const requestCode = `${requestPrefix}-${dayBucket.replace(/-/g, "")}-${requestId.slice(-6)}`;

  const insertStmt = db
    .prepare(
      `INSERT INTO custom_theme_requests (
         id,
         request_code,
         service_kind,
         tenant_id,
         tenant_handle,
         package_id,
         package_name_snapshot,
         requested_by_user_id,
         idempotency_key,
         request_hash,
         day_bucket,
         status,
         brand_name,
         brief,
         reference_urls_json,
         budget_range,
         contact_preference,
         version,
         created_at,
         updated_at
       )
       SELECT ?, ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, 'new',
              ?, ?, ?, ?, ?,
              1, ?, ?
       WHERE (
         SELECT COUNT(*)
         FROM custom_theme_requests
         WHERE tenant_id = ?
           AND service_kind = ?
           AND day_bucket = ?
       ) < ?
         AND (
           ? IS NULL
           OR EXISTS (
             SELECT 1
             FROM custom_theme_packages
             WHERE id = ?
               AND service_kind = ?
               AND active = 1
           )
         )`,
    )
    .bind(
      requestId,
      requestCode,
      input.serviceKind,
      params.tenantId,
      params.tenantHandle,
      input.packageId,
      packageNameSnapshot,
      params.requestedByUserId,
      input.idempotencyKey,
      requestHash,
      dayBucket,
      input.brandName,
      input.brief,
      JSON.stringify(input.referenceUrls),
      input.budgetRange,
      input.contactPreference,
      nowMs,
      nowMs,
      // WHERE daily cap
      params.tenantId,
      input.serviceKind,
      dayBucket,
      CUSTOM_THEME_DAILY_REQUEST_LIMIT,
      // WHERE package active guard
      input.packageId,
      input.packageId,
      input.serviceKind,
    );

  let insertedChanges: number;
  try {
    const results = await db.batch([insertStmt]);
    insertedChanges = results[0]?.meta?.changes ?? 0;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const racedReplayRow = await getTenantCustomThemeRequestRowByIdempotencyKey(db, {
        tenantId: params.tenantId,
        serviceKind: input.serviceKind,
        idempotencyKey: input.idempotencyKey,
      });
      if (racedReplayRow) {
        if (racedReplayRow.request_hash !== requestHash) {
          throw new CustomThemeRepositoryError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Kunci idempotensi sudah digunakan untuk permintaan dengan isi yang berbeda. Gunakan kunci baru untuk permintaan baru.",
          );
        }
        const dailyUsedCount = await countTenantDailyCustomThemeRequests(db, {
          tenantId: params.tenantId,
          serviceKind: input.serviceKind,
          dayBucket,
        });
        return {
          request: mapRequestRow(racedReplayRow),
          created: false,
          dailyUsedCount,
          dailyLimit: CUSTOM_THEME_DAILY_REQUEST_LIMIT,
        };
      }
    }
    throw err;
  }

  const dailyUsedCount = await countTenantDailyCustomThemeRequests(db, {
    tenantId: params.tenantId,
    serviceKind: input.serviceKind,
    dayBucket,
  });

  if (insertedChanges !== 1) {
    if (dailyUsedCount >= CUSTOM_THEME_DAILY_REQUEST_LIMIT) {
      throw new CustomThemeRepositoryError(
        429,
        "DAILY_REQUEST_LIMIT_REACHED",
        `Batas maksimal ${CUSTOM_THEME_DAILY_REQUEST_LIMIT} permintaan ${serviceLabel} per hari untuk situs ini telah tercapai. Silakan coba lagi besok atau hubungi tim kami melalui WhatsApp.`,
      );
    }
    throw new CustomThemeRepositoryError(
      422,
      "PACKAGE_INACTIVE",
      `Paket ${serviceLabel} yang dipilih sudah tidak aktif. Pilih paket lain atau konsultasi.`,
    );
  }

  const created = await getTenantCustomThemeRequestById(db, {
    tenantId: params.tenantId,
    requestId,
  });
  if (!created) {
    throw new Error("CUSTOM_THEME_REQUEST_INSERT_READBACK_FAILED");
  }

  return {
    request: created,
    created: true,
    dailyUsedCount,
    dailyLimit: CUSTOM_THEME_DAILY_REQUEST_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// Console Requests Queue, Theme Grant Verification & Audited Status Transitions
// ---------------------------------------------------------------------------

export async function listTenantActiveCustomThemeGrants(
  db: D1Database,
  tenantId: string,
): Promise<readonly TenantCustomThemeGrantSummary[]> {
  const rows = await db
    .prepare(
      `SELECT tte.id AS grant_id,
              tte.tenant_id,
              tte.theme_id,
              tc.slug,
              tc.name,
              tte.granted_at
       FROM tenant_theme_entitlements tte
       INNER JOIN theme_catalog tc ON tc.id = tte.theme_id
       WHERE tte.tenant_id = ?
         AND tc.active = 1
         AND tc.tier = 'custom'
       ORDER BY tte.granted_at DESC`,
    )
    .bind(tenantId)
    .all<RawCustomThemeGrantRow>();

  return (rows.results ?? []).map((r) => ({
    grantId: r.grant_id,
    tenantId: r.tenant_id,
    themeId: r.theme_id,
    slug: r.slug,
    name: r.name,
    grantedAtMs: Number(r.granted_at),
    grantedAtIso: new Date(Number(r.granted_at)).toISOString(),
  }));
}

export async function listConsoleCustomThemeRequests(
  db: D1Database,
  options: {
    readonly serviceKind?: ServiceKind;
    readonly status?: CustomThemeRequestStatus;
    readonly tenantQuery?: string;
    readonly limit?: number;
  } = {},
): Promise<readonly CustomThemeRequestRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (options.serviceKind) {
    conditions.push("service_kind = ?");
    binds.push(options.serviceKind);
  }
  if (options.status) {
    conditions.push("status = ?");
    binds.push(options.status);
  }
  const cleanQuery = options.tenantQuery?.trim().toLowerCase();
  if (cleanQuery) {
    conditions.push(
      "(LOWER(tenant_handle) LIKE ? OR LOWER(tenant_id) = ? OR LOWER(request_code) LIKE ? OR LOWER(brand_name) LIKE ?)",
    );
    const like = `%${cleanQuery}%`;
    binds.push(like, cleanQuery, like, like);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db
    .prepare(
      `SELECT ${REQUEST_SELECT_COLUMNS}
       FROM custom_theme_requests
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...binds, safeLimit)
    .all<RequestSqlRow>();

  return (rows.results ?? []).map(mapRequestRow);
}

export async function getConsoleCustomThemeRequestById(
  db: D1Database,
  requestId: string,
): Promise<CustomThemeRequestRecord | null> {
  const cleanId = requestId.trim();
  if (!cleanId) return null;
  const row = await db
    .prepare(
      `SELECT ${REQUEST_SELECT_COLUMNS}
       FROM custom_theme_requests
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(cleanId)
    .first<RequestSqlRow>();
  return row ? mapRequestRow(row) : null;
}

export interface TransitionConsoleServiceRequestResult {
  readonly request: CustomThemeRequestRecord;
  readonly audit: PlatformAuditRecord;
  readonly staffMembershipRemoved?: boolean;
}

/**
 * Transitions a service request (`custom_theme` or `setup`) status in `console.punyasitus.com/custom-themes` with:
 * - Optimistic concurrency (`expectedVersion` -> `409 STALE_VERSION`)
 * - Valid forward-only state transition (`409 INVALID_STATUS_TRANSITION`)
 * - For `custom_theme`: mandatory active `tenant_theme_entitlements` + active custom `theme_catalog`
 *   grant when marking `delivered` (`409 THEME_GRANT_REQUIRED` if absent or revoked).
 * - For `setup` (`TASK-069` / `REQ-070`):
 *   - `delivered` NEVER requires a theme grant!
 *   - Operator may nominate a named staff `users` account (`staffUserEmail` / `staffUserId`) which
 *     enters `staff_access_state = 'awaiting_owner_approval'` (NEVER auto-joins without owner approval!).
 *   - Every terminal state (`delivered`, `declined`, `cancelled`) atomically & idempotently removes
 *     any `setup_staff` row from `members` inside the SAME `db.batch([...])`!
 * - Atomic `platform_audit` insert inside single `db.batch([...])` (`WHERE changes() = 1`).
 */
export async function transitionConsoleCustomThemeRequest(
  db: D1Database,
  params: {
    readonly requestId: string;
    readonly input: ValidatedTransitionCustomThemeRequestInput;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly httpRequestId: string;
    readonly nowMs: number;
  },
): Promise<TransitionConsoleServiceRequestResult> {
  const existing = await getConsoleCustomThemeRequestById(db, params.requestId);
  if (!existing) {
    throw new CustomThemeRepositoryError(
      404,
      "NOT_FOUND",
      "Permintaan layanan tidak ditemukan.",
    );
  }
  if (existing.version !== params.input.expectedVersion) {
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Versi permintaan sudah berubah. Muat ulang sebelum mengubah status.",
    );
  }

  const nowMs = Math.trunc(params.nowMs);
  const { input } = params;
  const isSetup = existing.serviceKind === "setup";
  const isTerminal = CUSTOM_THEME_TERMINAL_STATUSES.has(input.status);
  const hasStaffNomination =
    isSetup &&
    !isTerminal &&
    Boolean((input.staffUserEmail && input.staffUserEmail.trim()) || (input.staffUserId && input.staffUserId.trim()));

  // Allow forward-only transitions, plus nominating a staff account while already `in_progress` (if not active yet).
  const isStaffNominationInPlace =
    hasStaffNomination &&
    existing.status === "in_progress" &&
    input.status === "in_progress" &&
    existing.staffAccessState !== "active";

  if (!isStaffNominationInPlace && !isAllowedCustomThemeStatusTransition(existing.status, input.status)) {
    throw new CustomThemeRepositoryError(
      409,
      "INVALID_STATUS_TRANSITION",
      `Status tidak dapat diubah dari "${existing.status}" ke "${input.status}".`,
    );
  }

  const nextOperatorNotes =
    input.operatorNotes !== undefined ? input.operatorNotes : existing.operatorNotes;

  // -------------------------------------------------------------------------
  // Branch 1: `setup` (Terima Beres — REQ-070, TASK-069)
  // -------------------------------------------------------------------------
  if (isSetup) {
    const tenantOrgRow = await db
      .prepare("SELECT organization_id FROM tenants WHERE id = ? LIMIT 1")
      .bind(existing.tenantId)
      .first<{ readonly organization_id: string }>();

    if (!tenantOrgRow) {
      throw new CustomThemeRepositoryError(404, "NOT_FOUND", "Organisasi tenant tidak ditemukan.");
    }

    let nominatedStaff: {
      readonly id: string;
      readonly email: string;
      readonly name: string;
    } | null = null;

    if (hasStaffNomination) {
      if (input.status !== "in_progress") {
        throw new CustomThemeRepositoryError(
          409,
          "INVALID_STATUS_TRANSITION",
          "Penugasan akun Tim Setup hanya dapat dilakukan saat status permintaan adalah 'in_progress' (Dikerjakan).",
        );
      }

      const lookupByEmail = input.staffUserEmail?.trim().toLowerCase() || null;
      const lookupById = input.staffUserId?.trim() || null;
      const userRow = lookupById
        ? await db
            .prepare(
              `SELECT u.id, u.email, u.name, po.revoked_at AS operator_revoked_at, po.user_id AS operator_user_id
               FROM users u
               LEFT JOIN platform_operators po ON po.user_id = u.id
               WHERE u.id = ?
               LIMIT 1`,
            )
            .bind(lookupById)
            .first<{
              readonly id: string;
              readonly email: string;
              readonly name: string;
              readonly operator_user_id: string | null;
              readonly operator_revoked_at: number | null;
            }>()
        : await db
            .prepare(
              `SELECT u.id, u.email, u.name, po.revoked_at AS operator_revoked_at, po.user_id AS operator_user_id
               FROM users u
               LEFT JOIN platform_operators po ON po.user_id = u.id
               WHERE lower(u.email) = ?
               LIMIT 1`,
            )
            .bind(lookupByEmail)
            .first<{
              readonly id: string;
              readonly email: string;
              readonly name: string;
              readonly operator_user_id: string | null;
              readonly operator_revoked_at: number | null;
            }>();

      if (!userRow) {
        throw new CustomThemeRepositoryError(
          422,
          "STAFF_USER_NOT_FOUND",
          "Akun Tim Setup dengan email/ID tersebut tidak ditemukan. Gunakan akun operator platform aktif.",
        );
      }

      if (!userRow.operator_user_id || userRow.operator_revoked_at !== null) {
        throw new CustomThemeRepositoryError(
          422,
          "STAFF_NOT_ACTIVE_OPERATOR",
          "Akun yang ditugaskan sebagai Tim Setup wajib memiliki izin operator platform yang aktif.",
        );
      }

      // Refuse nominating ANY user who already holds an active membership on this tenant
      // (including an active `setup_staff` row) to prevent cross-request member collisions!
      const existingMemberRow = await db
        .prepare(
          "SELECT id, role FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1",
        )
        .bind(tenantOrgRow.organization_id, userRow.id)
        .first<{ readonly id: string; readonly role: string }>();

      if (existingMemberRow) {
        throw new CustomThemeRepositoryError(
          409,
          "STAFF_ALREADY_MEMBER",
          "Akun tersebut sudah terdaftar sebagai anggota aktif pada situs ini sehingga tidak dapat ditugaskan ulang sebagai Tim Setup.",
        );
      }

      // Refuse nominating a staff user already nominated on another open setup request for this tenant
      const otherOpenNomination = await db
        .prepare(
          `SELECT id
           FROM custom_theme_requests
           WHERE tenant_id = ?
             AND service_kind = 'setup'
             AND id != ?
             AND staff_user_id = ?
             AND status NOT IN ('delivered', 'declined', 'cancelled')
             AND staff_access_state != 'revoked'
           LIMIT 1`,
        )
        .bind(existing.tenantId, existing.id, userRow.id)
        .first<{ readonly id: string }>();

      if (otherOpenNomination) {
        throw new CustomThemeRepositoryError(
          409,
          "STAFF_ALREADY_ASSIGNED",
          "Akun Tim Setup tersebut sedang ditugaskan pada permintaan Terima Beres aktif lainnya di situs ini.",
        );
      }

      nominatedStaff = { id: userRow.id, email: userRow.email, name: userRow.name };
    }

    const nextStaffAccessState: StaffAccessState = isTerminal
      ? existing.staffAccessState === "none"
        ? "none"
        : "revoked"
      : nominatedStaff
        ? "awaiting_owner_approval"
        : existing.staffAccessState;

    const updateStmt = isTerminal
      ? db
          .prepare(
            `UPDATE custom_theme_requests
             SET status = ?,
                 status_reason = ?,
                 operator_notes = ?,
                 staff_access_state = ?,
                 staff_revoked_at = CASE WHEN staff_access_state = 'none' THEN staff_revoked_at ELSE ? END,
                 staff_wait_reason = NULL,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?
               AND version = ?`,
          )
          .bind(
            input.status,
            input.reason,
            nextOperatorNotes,
            nextStaffAccessState,
            nowMs,
            nowMs,
            existing.id,
            input.expectedVersion,
          )
      : nominatedStaff
        ? db
            .prepare(
              `UPDATE custom_theme_requests
               SET status = ?,
                   status_reason = ?,
                   operator_notes = ?,
                   staff_user_id = ?,
                   staff_email_snapshot = ?,
                   staff_name_snapshot = ?,
                   staff_access_state = 'awaiting_owner_approval',
                   staff_approved_by_user_id = NULL,
                   staff_approved_at = NULL,
                   staff_member_id = NULL,
                   staff_joined_at = NULL,
                   staff_revoked_at = NULL,
                   staff_wait_reason = NULL,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ?
                 AND version = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM members WHERE organization_id = ? AND user_id = ?
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM custom_theme_requests
                   WHERE tenant_id = ?
                     AND service_kind = 'setup'
                     AND id != ?
                     AND staff_user_id = ?
                     AND status NOT IN ('delivered', 'declined', 'cancelled')
                     AND staff_access_state != 'revoked'
                 )`,
            )
            .bind(
              input.status,
              input.reason,
              nextOperatorNotes,
              nominatedStaff.id,
              nominatedStaff.email,
              nominatedStaff.name,
              nowMs,
              existing.id,
              input.expectedVersion,
              tenantOrgRow.organization_id,
              nominatedStaff.id,
              existing.tenantId,
              existing.id,
              nominatedStaff.id,
            )
        : db
            .prepare(
              `UPDATE custom_theme_requests
               SET status = ?,
                   status_reason = ?,
                   operator_notes = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ?
                 AND version = ?`,
            )
            .bind(
              input.status,
              input.reason,
              nextOperatorNotes,
              nowMs,
              existing.id,
              input.expectedVersion,
            );

    const auditAction =
      input.status === "delivered"
        ? "setup_service.request.delivered"
        : nominatedStaff
          ? "setup_service.request.staff_assigned"
          : "setup_service.request.status_changed";

    const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
      db,
      {
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        action: auditAction,
        targetType: "custom_theme_request",
        targetId: existing.id,
        tenantId: existing.tenantId,
        reason: input.reason,
        requireReason: true,
        outcome: "success",
        requestId: params.httpRequestId,
        metadata: {
          serviceKind: "setup",
          requestCode: existing.requestCode,
          tenantHandle: existing.tenantHandle,
          previousStatus: existing.status,
          nextStatus: input.status,
          previousVersion: existing.version,
          nextVersion: existing.version + 1,
          previousStaffAccessState: existing.staffAccessState,
          nextStaffAccessState,
          ...(nominatedStaff
            ? { nominatedStaffUserId: nominatedStaff.id, nominatedStaffEmail: nominatedStaff.email }
            : {}),
          ...(isTerminal && existing.staffMemberId
            ? { cleanupStaffMemberId: existing.staffMemberId }
            : {}),
        },
        createdAtMs: nowMs,
      },
      { onlyIfPreviousChanged: true },
    );

    const batchStmts: D1PreparedStatement[] = [updateStmt, auditStmt];
    // STRICTLY scope `setup_staff` member deletion by exact `staff_member_id` (NEVER `OR user_id = ?`)!
    if (isTerminal && existing.staffMemberId) {
      batchStmts.push(
        db
          .prepare(
            `DELETE FROM members
             WHERE organization_id = ?
               AND id = ?
               AND role = 'setup_staff'
               AND EXISTS (
                 SELECT 1
                 FROM custom_theme_requests
                 WHERE id = ?
                   AND version = ?
                   AND status IN ('delivered', 'declined', 'cancelled')
               )`,
          )
          .bind(
            tenantOrgRow.organization_id,
            existing.staffMemberId,
            existing.id,
            input.expectedVersion + 1,
          ),
      );
    }

    const results = await db.batch(batchStmts);
    const updatedChanges = results[0]?.meta?.changes ?? 0;
    if (updatedChanges !== 1) {
      if (nominatedStaff) {
        const refreshed = await getConsoleCustomThemeRequestById(db, existing.id);
        if (refreshed && refreshed.version === input.expectedVersion) {
          const racedMember = await db
            .prepare("SELECT id FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
            .bind(tenantOrgRow.organization_id, nominatedStaff.id)
            .first<{ readonly id: string }>();
          if (racedMember) {
            throw new CustomThemeRepositoryError(
              409,
              "STAFF_ALREADY_MEMBER",
              "Akun tersebut sudah terdaftar sebagai anggota aktif pada situs ini.",
            );
          }
          throw new CustomThemeRepositoryError(
            409,
            "STAFF_ALREADY_ASSIGNED",
            "Akun Tim Setup tersebut sedang ditugaskan pada permintaan Terima Beres aktif lainnya di situs ini.",
          );
        }
      }
      throw new CustomThemeRepositoryError(
        409,
        "STALE_VERSION",
        "Permintaan berubah secara bersamaan. Muat ulang dan coba lagi.",
      );
    }

    const staffMembershipRemoved =
      isTerminal && batchStmts.length > 2 ? (results[2]?.meta?.changes ?? 0) > 0 : false;

    const updated = await getConsoleCustomThemeRequestById(db, existing.id);
    if (!updated) {
      throw new Error("SETUP_SERVICE_REQUEST_UPDATE_READBACK_FAILED");
    }
    return { request: updated, audit, staffMembershipRemoved };
  }

  // -------------------------------------------------------------------------
  // Branch 2: `custom_theme` (TASK-061 — unchanged delivery theme-grant invariant)
  // -------------------------------------------------------------------------
  let resolvedThemeId: string | null = existing.deliveredThemeId;
  let resolvedGrantId: string | null = existing.deliveredThemeGrantId;

  if (input.status === "delivered") {
    const targetTheme = input.deliveredThemeId?.trim().toLowerCase() ?? "";
    if (!targetTheme) {
      throw new CustomThemeRepositoryError(
        409,
        "THEME_GRANT_REQUIRED",
        "Status diserahkan (delivered) wajib menautkan tema kustom yang sudah memiliki izin aktif untuk tenant ini.",
      );
    }

    const grantRow = await db
      .prepare(
        `SELECT tte.id AS grant_id,
                tte.tenant_id,
                tte.theme_id,
                tc.slug,
                tc.name,
                tte.granted_at
         FROM tenant_theme_entitlements tte
         INNER JOIN theme_catalog tc ON tc.id = tte.theme_id
         WHERE tte.tenant_id = ?
           AND (tte.theme_id = ? OR tc.slug = ?)
           AND tc.active = 1
           AND tc.tier = 'custom'
         LIMIT 1`,
      )
      .bind(existing.tenantId, targetTheme, targetTheme)
      .first<RawCustomThemeGrantRow>();

    if (!grantRow) {
      throw new CustomThemeRepositoryError(
        409,
        "THEME_GRANT_REQUIRED",
        `Tenant "${existing.tenantHandle}" belum memiliki izin aktif untuk tema kustom "${targetTheme}". Berikan izin tema terlebih dahulu sebelum menandai selesai (delivered).`,
      );
    }

    resolvedThemeId = grantRow.theme_id;
    resolvedGrantId = grantRow.grant_id;
  }

  const updateStmt =
    input.status === "delivered"
      ? db
          .prepare(
            `UPDATE custom_theme_requests
             SET status = ?,
                 status_reason = ?,
                 operator_notes = ?,
                 delivered_theme_id = ?,
                 delivered_theme_grant_id = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?
               AND version = ?
               AND EXISTS (
                 SELECT 1
                 FROM tenant_theme_entitlements tte
                 INNER JOIN theme_catalog tc ON tc.id = tte.theme_id
                 WHERE tte.id = ?
                   AND tte.tenant_id = ?
                   AND tte.theme_id = ?
                   AND tc.active = 1
                   AND tc.tier = 'custom'
               )`,
          )
          .bind(
            input.status,
            input.reason,
            nextOperatorNotes,
            resolvedThemeId,
            resolvedGrantId,
            nowMs,
            existing.id,
            input.expectedVersion,
            resolvedGrantId,
            existing.tenantId,
            resolvedThemeId,
          )
      : db
          .prepare(
            `UPDATE custom_theme_requests
             SET status = ?,
                 status_reason = ?,
                 operator_notes = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ?
               AND version = ?`,
          )
          .bind(
            input.status,
            input.reason,
            nextOperatorNotes,
            nowMs,
            existing.id,
            input.expectedVersion,
          );

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action:
        input.status === "delivered"
          ? "custom_theme.request.delivered"
          : "custom_theme.request.status_changed",
      targetType: "custom_theme_request",
      targetId: existing.id,
      tenantId: existing.tenantId,
      reason: input.reason,
      requireReason: true,
      outcome: "success",
      requestId: params.httpRequestId,
      metadata: {
        requestCode: existing.requestCode,
        tenantHandle: existing.tenantHandle,
        previousStatus: existing.status,
        nextStatus: input.status,
        previousVersion: existing.version,
        nextVersion: existing.version + 1,
        ...(resolvedThemeId ? { deliveredThemeId: resolvedThemeId } : {}),
        ...(resolvedGrantId ? { deliveredThemeGrantId: resolvedGrantId } : {}),
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const results = await db.batch([updateStmt, auditStmt]);
  const updatedChanges = results[0]?.meta?.changes ?? 0;
  if (updatedChanges !== 1) {
    const refreshed = await getConsoleCustomThemeRequestById(db, existing.id);
    if (refreshed && refreshed.version !== input.expectedVersion) {
      throw new CustomThemeRepositoryError(
        409,
        "STALE_VERSION",
        "Permintaan berubah secara bersamaan. Muat ulang dan coba lagi.",
      );
    }
    if (input.status === "delivered") {
      throw new CustomThemeRepositoryError(
        409,
        "THEME_GRANT_REQUIRED",
        "Izin tema kustom untuk tenant ini sudah dicabut atau tidak aktif.",
      );
    }
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Permintaan tidak dapat diperbarui secara bersamaan.",
    );
  }

  const updated = await getConsoleCustomThemeRequestById(db, existing.id);
  if (!updated) {
    throw new Error("CUSTOM_THEME_REQUEST_UPDATE_READBACK_FAILED");
  }
  return { request: updated, audit };
}

// ---------------------------------------------------------------------------
// Terima Beres Setup Service — Seat Usage, Owner Approval & Idempotent Revoke
// (REQ-070, PLAN §18.2, TASK-069)
// ---------------------------------------------------------------------------

export interface TenantServiceSeatUsage {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly activeMembersCount: number;
  readonly pendingInvitationsCount: number;
  readonly seatsUsed: number;
  readonly seatsLimit: number;
  readonly seatsRemaining: number;
}

export async function getTenantSeatUsageForServiceRequest(
  db: D1Database,
  params: { readonly tenantId: string; readonly nowMs?: number },
): Promise<TenantServiceSeatUsage | null> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const tenantRow = await db
    .prepare("SELECT id, organization_id FROM tenants WHERE id = ? LIMIT 1")
    .bind(params.tenantId.trim())
    .first<{ readonly id: string; readonly organization_id: string }>();
  if (!tenantRow) return null;

  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM members WHERE organization_id = ?) AS active_members,
         (SELECT COUNT(*) FROM invitations WHERE organization_id = ? AND status = 'pending' AND expires_at > ?) AS pending_invites`,
    )
    .bind(tenantRow.organization_id, tenantRow.organization_id, nowMs)
    .first<{ readonly active_members: number; readonly pending_invites: number }>();

  const activeMembersCount = Number(counts?.active_members ?? 0);
  const pendingInvitationsCount = Number(counts?.pending_invites ?? 0);
  const seatsUsed = activeMembersCount + pendingInvitationsCount;
  return {
    tenantId: tenantRow.id,
    organizationId: tenantRow.organization_id,
    activeMembersCount,
    pendingInvitationsCount,
    seatsUsed,
    seatsLimit: MAX_TENANT_SEAT_CAP,
    seatsRemaining: Math.max(0, MAX_TENANT_SEAT_CAP - seatsUsed),
  };
}

export interface ApproveSetupStaffAccessResult {
  readonly request: CustomThemeRequestRecord;
  readonly joined: boolean;
  readonly alreadyActive: boolean;
  readonly waitingForSeat: boolean;
  readonly waitReason: string | null;
  readonly seats: TenantServiceSeatUsage;
  readonly audit: PlatformAuditRecord | null;
}

/**
 * Owner-approved staff editor membership join for a Terima Beres setup request:
 * - Atomically enforces the 5-member seat cap (`active members + active unexpired pending invitations < 5`)
 *   inside SQLite so concurrent approvals/invitations can NEVER exceed 5 seats!
 * - Joins the nominated staff user into `members` with `role = 'setup_staff'` (mapped to canonical `editor`).
 * - If all 5 seats are occupied, atomically transitions `staff_access_state = 'waiting_seat'` with a clear
 *   Bahasa Indonesia explanation and writes an audit entry instead of bypassing the cap.
 */
export async function approveSetupServiceStaffAccess(
  db: D1Database,
  params: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly expectedVersion: number;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly reason?: string | null;
    readonly httpRequestId: string;
    readonly nowMs: number;
  },
): Promise<ApproveSetupStaffAccessResult> {
  const nowMs = Math.trunc(params.nowMs);
  const existing = await getTenantCustomThemeRequestById(db, {
    tenantId: params.tenantId,
    requestId: params.requestId,
  });

  if (!existing || existing.serviceKind !== "setup") {
    throw new CustomThemeRepositoryError(
      404,
      "NOT_FOUND",
      "Permintaan Layanan Terima Beres tidak ditemukan.",
    );
  }

  const initialSeats = await getTenantSeatUsageForServiceRequest(db, {
    tenantId: existing.tenantId,
    nowMs,
  });
  if (!initialSeats) {
    throw new CustomThemeRepositoryError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  if (existing.staffAccessState === "active") {
    return {
      request: existing,
      joined: true,
      alreadyActive: true,
      waitingForSeat: false,
      waitReason: null,
      seats: initialSeats,
      audit: null,
    };
  }

  if (existing.version !== params.expectedVersion) {
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Versi permintaan sudah berubah. Muat ulang halaman sebelum menyetujui akses Tim Setup.",
    );
  }

  if (existing.status !== "in_progress") {
    throw new CustomThemeRepositoryError(
      409,
      "INVALID_STATUS_TRANSITION",
      "Persetujuan akses Tim Setup hanya dapat dilakukan saat permintaan berstatus Dikerjakan (in_progress).",
    );
  }

  if (!existing.staffUserId) {
    throw new CustomThemeRepositoryError(
      409,
      "STAFF_NOT_ASSIGNED",
      "Operator belum menugaskan akun Tim Setup untuk permintaan ini.",
    );
  }

  if (
    existing.staffAccessState !== "awaiting_owner_approval" &&
    existing.staffAccessState !== "waiting_seat"
  ) {
    throw new CustomThemeRepositoryError(
      409,
      "INVALID_STAFF_ACCESS_STATE",
      `Status akses Tim Setup saat ini (${existing.staffAccessState}) tidak dapat disetujui.`,
    );
  }

  const existingMember = await db
    .prepare("SELECT id, role FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
    .bind(initialSeats.organizationId, existing.staffUserId)
    .first<{ readonly id: string; readonly role: string }>();

  if (existingMember) {
    throw new CustomThemeRepositoryError(
      409,
      "STAFF_ALREADY_MEMBER",
      "Akun staf tersebut sudah terdaftar sebagai anggota aktif situs ini.",
    );
  }

  const memberId = generateUlid(nowMs);
  const approveReason =
    params.reason?.trim() ||
    `Pemilik situs menyetujui akses Editor sementara Tim Setup (${existing.staffEmail ?? existing.staffUserId}) untuk permintaan ${existing.requestCode}`;

  // Atomic Attempt 1: Join free seat (active members + active unexpired pending invites < 5)
  const insertMemberStmt = db
    .prepare(
      `INSERT INTO members (id, organization_id, user_id, role, created_at)
       SELECT ?, ?, ?, 'setup_staff', ?
       WHERE NOT EXISTS (
         SELECT 1 FROM members WHERE organization_id = ? AND user_id = ?
       )
       AND (
         (SELECT COUNT(*) FROM members WHERE organization_id = ?)
         + (SELECT COUNT(*) FROM invitations WHERE organization_id = ? AND status = 'pending' AND expires_at > ?)
       ) < ?
       AND EXISTS (
         SELECT 1
         FROM custom_theme_requests
         WHERE id = ?
           AND tenant_id = ?
           AND version = ?
           AND service_kind = 'setup'
           AND status = 'in_progress'
           AND staff_access_state IN ('awaiting_owner_approval', 'waiting_seat')
       )`,
    )
    .bind(
      memberId,
      initialSeats.organizationId,
      existing.staffUserId,
      nowMs,
      initialSeats.organizationId,
      existing.staffUserId,
      initialSeats.organizationId,
      initialSeats.organizationId,
      nowMs,
      MAX_TENANT_SEAT_CAP,
      existing.id,
      existing.tenantId,
      params.expectedVersion,
    );

  const markActiveStmt = db
    .prepare(
      `UPDATE custom_theme_requests
       SET staff_access_state = 'active',
           staff_approved_by_user_id = ?,
           staff_approved_at = ?,
           staff_member_id = ?,
           staff_joined_at = ?,
           staff_wait_reason = NULL,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND version = ?
         AND service_kind = 'setup'
         AND status = 'in_progress'
         AND staff_access_state IN ('awaiting_owner_approval', 'waiting_seat')
         AND EXISTS (
           SELECT 1
           FROM members
           WHERE id = ?
             AND organization_id = ?
             AND user_id = ?
             AND role = 'setup_staff'
         )`,
    )
    .bind(
      params.actorUserId,
      nowMs,
      memberId,
      nowMs,
      nowMs,
      existing.id,
      existing.tenantId,
      params.expectedVersion,
      memberId,
      initialSeats.organizationId,
      existing.staffUserId,
    );

  const { statement: joinAuditStmt, entry: joinAudit } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "setup_service.staff_access.approved_and_joined",
      targetType: "custom_theme_request",
      targetId: existing.id,
      tenantId: existing.tenantId,
      reason: approveReason,
      requireReason: true,
      outcome: "success",
      requestId: params.httpRequestId,
      metadata: {
        requestCode: existing.requestCode,
        staffUserId: existing.staffUserId,
        staffEmail: existing.staffEmail,
        staffMemberId: memberId,
        memberRole: "setup_staff",
        canonicalRole: "editor",
        previousVersion: existing.version,
        nextVersion: existing.version + 1,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const joinResults = await db.batch([insertMemberStmt, markActiveStmt, joinAuditStmt]);
  const insertedMemberChanges = joinResults[0]?.meta?.changes ?? 0;
  const markedActiveChanges = joinResults[1]?.meta?.changes ?? 0;

  if (insertedMemberChanges === 1 && markedActiveChanges === 1) {
    const [updated, seatsAfter] = await Promise.all([
      getTenantCustomThemeRequestById(db, { tenantId: existing.tenantId, requestId: existing.id }),
      getTenantSeatUsageForServiceRequest(db, { tenantId: existing.tenantId, nowMs }),
    ]);
    if (!updated || !seatsAfter) {
      throw new Error("SETUP_STAFF_APPROVE_READBACK_FAILED");
    }
    return {
      request: updated,
      joined: true,
      alreadyActive: false,
      waitingForSeat: false,
      waitReason: null,
      seats: seatsAfter,
      audit: joinAudit,
    };
  }

  // Fallback inspection: verify request state, member conflict, AND exact seat count
  // before ever classifying as `waiting_seat`!
  const refreshed = await getTenantCustomThemeRequestById(db, {
    tenantId: existing.tenantId,
    requestId: existing.id,
  });
  if (!refreshed) {
    throw new CustomThemeRepositoryError(404, "NOT_FOUND", "Permintaan tidak ditemukan.");
  }
  if (refreshed.staffAccessState === "active") {
    const seatsActive =
      (await getTenantSeatUsageForServiceRequest(db, { tenantId: existing.tenantId, nowMs })) ??
      initialSeats;
    return {
      request: refreshed,
      joined: true,
      alreadyActive: true,
      waitingForSeat: false,
      waitReason: null,
      seats: seatsActive,
      audit: null,
    };
  }
  if (refreshed.status !== "in_progress") {
    throw new CustomThemeRepositoryError(
      409,
      "INVALID_STATUS_TRANSITION",
      "Permintaan sudah tidak berstatus Dikerjakan (in_progress) sehingga akses Tim Setup tidak dapat diaktifkan.",
    );
  }
  if (
    refreshed.staffAccessState !== "awaiting_owner_approval" &&
    refreshed.staffAccessState !== "waiting_seat"
  ) {
    throw new CustomThemeRepositoryError(
      409,
      "INVALID_STAFF_ACCESS_STATE",
      `Status akses Tim Setup (${refreshed.staffAccessState}) tidak dapat disetujui.`,
    );
  }
  if (refreshed.version !== params.expectedVersion) {
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Permintaan berubah secara bersamaan. Muat ulang dan coba lagi.",
    );
  }

  const racedMember = await db
    .prepare("SELECT id, role FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
    .bind(initialSeats.organizationId, existing.staffUserId)
    .first<{ readonly id: string; readonly role: string }>();

  if (racedMember) {
    throw new CustomThemeRepositoryError(
      409,
      "STAFF_ALREADY_MEMBER",
      "Akun staf tersebut sudah terdaftar sebagai anggota aktif situs ini.",
    );
  }

  const seatsNow = await getTenantSeatUsageForServiceRequest(db, {
    tenantId: existing.tenantId,
    nowMs,
  });
  if (!seatsNow) {
    throw new CustomThemeRepositoryError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }
  if (seatsNow.seatsUsed < seatsNow.seatsLimit) {
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Permintaan berubah secara bersamaan. Muat ulang dan coba lagi.",
    );
  }

  // Record explicit `waiting_seat` state with explanation + audit (strictly guarded on `in_progress`!)
  const waitReason = SETUP_SERVICE_SEAT_FULL_EXPLANATION;
  const markWaitingStmt = db
    .prepare(
      `UPDATE custom_theme_requests
       SET staff_access_state = 'waiting_seat',
           staff_approved_by_user_id = ?,
           staff_approved_at = ?,
           staff_wait_reason = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND version = ?
         AND service_kind = 'setup'
         AND status = 'in_progress'
         AND staff_access_state IN ('awaiting_owner_approval', 'waiting_seat')`,
    )
    .bind(
      params.actorUserId,
      nowMs,
      waitReason,
      nowMs,
      existing.id,
      existing.tenantId,
      params.expectedVersion,
    );

  const { statement: waitAuditStmt, entry: waitAudit } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "setup_service.staff_access.waiting_seat",
      targetType: "custom_theme_request",
      targetId: existing.id,
      tenantId: existing.tenantId,
      reason: `Persetujuan Tim Setup menunggu kursi anggota kosong (${seatsNow.seatsUsed}/${seatsNow.seatsLimit} kursi terpakai)`,
      requireReason: true,
      outcome: "success",
      requestId: params.httpRequestId,
      metadata: {
        requestCode: existing.requestCode,
        staffUserId: existing.staffUserId,
        seatsUsed: seatsNow.seatsUsed,
        seatsLimit: seatsNow.seatsLimit,
        activeMembersCount: seatsNow.activeMembersCount,
        pendingInvitationsCount: seatsNow.pendingInvitationsCount,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const waitResults = await db.batch([markWaitingStmt, waitAuditStmt]);
  if ((waitResults[0]?.meta?.changes ?? 0) !== 1) {
    const postRace = await getTenantCustomThemeRequestById(db, {
      tenantId: existing.tenantId,
      requestId: existing.id,
    });
    if (postRace && postRace.status !== "in_progress") {
      throw new CustomThemeRepositoryError(
        409,
        "INVALID_STATUS_TRANSITION",
        "Permintaan sudah selesai atau dibatalkan secara bersamaan.",
      );
    }
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Permintaan berubah secara bersamaan. Muat ulang dan coba lagi.",
    );
  }

  const waitingReq = await getTenantCustomThemeRequestById(db, {
    tenantId: existing.tenantId,
    requestId: existing.id,
  });
  if (!waitingReq) {
    throw new Error("SETUP_STAFF_WAIT_READBACK_FAILED");
  }

  return {
    request: waitingReq,
    joined: false,
    alreadyActive: false,
    waitingForSeat: true,
    waitReason,
    seats: seatsNow,
    audit: waitAudit,
  };
}

export interface RevokeSetupStaffAccessResult {
  readonly request: CustomThemeRequestRecord;
  readonly removed: boolean;
  readonly alreadyRevoked: boolean;
  readonly seats: TenantServiceSeatUsage;
  readonly audit: PlatformAuditRecord | null;
}

/**
 * Idempotently revokes a Terima Beres setup request's temporary `setup_staff` membership
 * on owner request, freeing the member seat immediately and recording an atomic audit row.
 */
export async function revokeSetupServiceStaffAccess(
  db: D1Database,
  params: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly expectedVersion: number;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly reason?: string | null;
    readonly httpRequestId: string;
    readonly nowMs: number;
  },
): Promise<RevokeSetupStaffAccessResult> {
  const nowMs = Math.trunc(params.nowMs);
  const existing = await getTenantCustomThemeRequestById(db, {
    tenantId: params.tenantId,
    requestId: params.requestId,
  });

  if (!existing || existing.serviceKind !== "setup") {
    throw new CustomThemeRepositoryError(
      404,
      "NOT_FOUND",
      "Permintaan Layanan Terima Beres tidak ditemukan.",
    );
  }

  const initialSeats = await getTenantSeatUsageForServiceRequest(db, {
    tenantId: existing.tenantId,
    nowMs,
  });
  if (!initialSeats) {
    throw new CustomThemeRepositoryError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  if (existing.staffAccessState === "revoked" || existing.staffAccessState === "none") {
    // Pure read-only idempotent replay: ZERO unguarded or unaudited DELETE statements!
    return {
      request: existing,
      removed: false,
      alreadyRevoked: true,
      seats: initialSeats,
      audit: null,
    };
  }

  if (existing.version !== params.expectedVersion) {
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Versi permintaan sudah berubah. Muat ulang halaman sebelum mencabut akses Tim Setup.",
    );
  }

  const revokeReason =
    params.reason?.trim() ||
    `Pemilik situs mencabut akses sementara Tim Setup untuk permintaan ${existing.requestCode}`;

  const updateStmt = db
    .prepare(
      `UPDATE custom_theme_requests
       SET staff_access_state = 'revoked',
           staff_revoked_at = ?,
           staff_wait_reason = NULL,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND tenant_id = ?
         AND version = ?
         AND service_kind = 'setup'
         AND staff_access_state IN ('awaiting_owner_approval', 'waiting_seat', 'active')`,
    )
    .bind(nowMs, nowMs, existing.id, existing.tenantId, params.expectedVersion);

  const { statement: auditStmt, entry: audit } = buildPlatformAuditStatement(
    db,
    {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "setup_service.staff_access.revoked",
      targetType: "custom_theme_request",
      targetId: existing.id,
      tenantId: existing.tenantId,
      reason: revokeReason,
      requireReason: true,
      outcome: "success",
      requestId: params.httpRequestId,
      metadata: {
        requestCode: existing.requestCode,
        staffUserId: existing.staffUserId,
        staffMemberId: existing.staffMemberId,
        previousStaffAccessState: existing.staffAccessState,
        previousVersion: existing.version,
        nextVersion: existing.version + 1,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const batchStmts: D1PreparedStatement[] = [updateStmt, auditStmt];
  // STRICTLY scope `setup_staff` member deletion by exact `staff_member_id` (NEVER `OR user_id = ?`)!
  if (existing.staffMemberId) {
    batchStmts.push(
      db
        .prepare(
          `DELETE FROM members
           WHERE organization_id = ?
             AND id = ?
             AND role = 'setup_staff'
             AND EXISTS (
               SELECT 1
               FROM custom_theme_requests
               WHERE id = ?
                 AND version = ?
                 AND staff_access_state = 'revoked'
             )`,
        )
        .bind(
          initialSeats.organizationId,
          existing.staffMemberId,
          existing.id,
          params.expectedVersion + 1,
        ),
    );
  }

  const results = await db.batch(batchStmts);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Permintaan berubah secara bersamaan. Muat ulang dan coba lagi.",
    );
  }

  const [updated, seatsAfter] = await Promise.all([
    getTenantCustomThemeRequestById(db, { tenantId: existing.tenantId, requestId: existing.id }),
    getTenantSeatUsageForServiceRequest(db, { tenantId: existing.tenantId, nowMs }),
  ]);
  if (!updated || !seatsAfter) {
    throw new Error("SETUP_STAFF_REVOKE_READBACK_FAILED");
  }

  return {
    request: updated,
    removed: batchStmts.length > 2 ? (results[2]?.meta?.changes ?? 0) > 0 : false,
    alreadyRevoked: false,
    seats: seatsAfter,
    audit,
  };
}
