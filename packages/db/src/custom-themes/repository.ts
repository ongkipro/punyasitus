import {
  CUSTOM_THEME_DAILY_REQUEST_LIMIT,
  CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL,
  computeCustomThemeDayBucket,
  formatCustomThemeStartingPriceLabel,
  isAllowedCustomThemeStatusTransition,
  type ContactPreference,
  type CustomThemePackageRecord,
  type CustomThemeRequestRecord,
  type CustomThemeRequestStatus,
  type ServiceKind,
  type ValidatedCreateCustomThemePackageInput,
  type ValidatedCreateCustomThemeRequestInput,
  type ValidatedTransitionCustomThemeRequestInput,
  type ValidatedUpdateCustomThemePackageInput,
} from "@punyasitus/core/custom-themes/index";
import { buildPlatformAuditStatement, type PlatformAuditRecord } from "../platform/audit.ts";

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
  | "THEME_GRANT_REQUIRED";

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
  let packageNameSnapshot: string = CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL;
  if (input.packageId !== null) {
    const pkg = await getCustomThemePackageById(db, input.packageId);
    if (!pkg || pkg.serviceKind !== input.serviceKind) {
      throw new CustomThemeRepositoryError(
        422,
        "INVALID_PACKAGE",
        "Paket tema kustom yang dipilih tidak ditemukan.",
      );
    }
    if (!pkg.active) {
      throw new CustomThemeRepositoryError(
        422,
        "PACKAGE_INACTIVE",
        "Paket tema kustom yang dipilih sudah tidak aktif. Pilih paket lain atau konsultasi.",
      );
    }
    packageNameSnapshot = pkg.name;
  }

  // 3. Atomic conditional INSERT enforcing 3/day cap + active package inside a single SQLite batch
  const requestId = generateUlid(nowMs);
  const requestCode = `CTR-${dayBucket.replace(/-/g, "")}-${requestId.slice(-6)}`;

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
        `Batas maksimal ${CUSTOM_THEME_DAILY_REQUEST_LIMIT} permintaan tema kustom per hari untuk situs ini telah tercapai. Silakan coba lagi besok atau hubungi tim kami melalui WhatsApp.`,
      );
    }
    throw new CustomThemeRepositoryError(
      422,
      "PACKAGE_INACTIVE",
      "Paket tema kustom yang dipilih sudah tidak aktif. Pilih paket lain atau konsultasi.",
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

/**
 * Transitions a custom theme request status in `console.punyasitus.com/custom-themes` with:
 * - Optimistic concurrency (`expectedVersion` -> `409 STALE_VERSION`)
 * - Valid forward-only state transition (`409 INVALID_STATUS_TRANSITION`)
 * - Mandatory active `tenant_theme_entitlements` + active custom `theme_catalog` grant when
 *   marking `delivered` (`409 THEME_GRANT_REQUIRED` if absent or revoked!)
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
): Promise<{ readonly request: CustomThemeRequestRecord; readonly audit: PlatformAuditRecord }> {
  const existing = await getConsoleCustomThemeRequestById(db, params.requestId);
  if (!existing) {
    throw new CustomThemeRepositoryError(
      404,
      "NOT_FOUND",
      "Permintaan tema kustom tidak ditemukan.",
    );
  }
  if (existing.version !== params.input.expectedVersion) {
    throw new CustomThemeRepositoryError(
      409,
      "STALE_VERSION",
      "Versi permintaan sudah berubah. Muat ulang sebelum mengubah status.",
    );
  }
  if (!isAllowedCustomThemeStatusTransition(existing.status, params.input.status)) {
    throw new CustomThemeRepositoryError(
      409,
      "INVALID_STATUS_TRANSITION",
      `Status tidak dapat diubah dari "${existing.status}" ke "${params.input.status}".`,
    );
  }

  const nowMs = Math.trunc(params.nowMs);
  const { input } = params;
  const nextOperatorNotes =
    input.operatorNotes !== undefined ? input.operatorNotes : existing.operatorNotes;

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
