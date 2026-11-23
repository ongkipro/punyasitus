import {
  DEFAULT_BRANCH_TIMEZONE,
  MAX_BRANCHES_PER_TENANT,
  validateBranchCreatePayload,
  validateBranchReorderPayload,
  validateBranchUpdatePayload,
  type BranchOpeningHours,
  type BranchRecord,
  type BranchValidationFieldIssue,
} from "@punyasitus/core/branches/index";
import { allocateNextSequenceId } from "../identifiers/index.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";

/**
 * Multi-Branch Locations (`branches`) TenantStore Repository
 * (`packages/db/src/branches/index.ts`; REQ-088, PLAN §5.2, §19.5; TASK-088).
 *
 * Hard Invariants:
 * - ZERO request-time DDL (table + additive columns provisioned strictly via
 *   `0001_initial_tenant.sql` + `0017_branches.sql`).
 * - Hard cap of 10 branches per tenant enforced atomically in SQL (`WHERE (SELECT COUNT(*) FROM branches) < 10`).
 * - Single-primary-branch invariant enforced BOTH in SQLite partial unique index
 *   (`branches_single_primary_idx`) and in atomic `tenantDb.batch()` transactions.
 * - Optimistic concurrency control (`expectedVersion` -> `409 STALE_VERSION`) with
 *   `WHERE changes() = 1` chained audit logs in `tenant_activity_log`.
 * - Deleting a branch safely detaches any `leads.branch_id` FK references atomically.
 */

export class BranchValidationError extends Error {
  readonly code: "VALIDATION_ERROR" | "BRANCH_LIMIT_REACHED";
  readonly fields: readonly BranchValidationFieldIssue[];

  constructor(
    message: string,
    fields: readonly BranchValidationFieldIssue[] = [],
    code: "VALIDATION_ERROR" | "BRANCH_LIMIT_REACHED" = "VALIDATION_ERROR",
  ) {
    super(message);
    this.name = "BranchValidationError";
    this.code = code;
    this.fields = fields;
  }
}

export class BranchLimitReachedError extends BranchValidationError {
  readonly maxBranches: number = MAX_BRANCHES_PER_TENANT;

  constructor(
    message = `Maksimal ${MAX_BRANCHES_PER_TENANT} cabang per situs telah tercapai. Hapus salah satu cabang terlebih dahulu sebelum menambah cabang baru.`,
  ) {
    super(
      message,
      [
        {
          field: "branches",
          code: "BRANCH_LIMIT_REACHED",
          message,
        },
      ],
      "BRANCH_LIMIT_REACHED",
    );
    this.name = "BranchLimitReachedError";
  }
}

export class BranchNotFoundError extends Error {
  readonly branchId: number;

  constructor(branchId: number, message = `Cabang #${branchId} tidak ditemukan.`) {
    super(message);
    this.name = "BranchNotFoundError";
    this.branchId = branchId;
  }
}

export class BranchStaleVersionError extends Error {
  readonly branchId: number;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(
    branchId: number,
    expectedVersion: number,
    actualVersion: number | null,
    message = "Data cabang telah diubah di sesi lain. Muat ulang daftar cabang sebelum menyimpan.",
  ) {
    super(message);
    this.name = "BranchStaleVersionError";
    this.branchId = branchId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export interface BranchListAdminDto {
  readonly items: readonly BranchRecord[];
  readonly total: number;
  readonly maxBranches: typeof MAX_BRANCHES_PER_TENANT;
  readonly remainingSlots: number;
  readonly primaryBranchId: number | null;
}

export interface BranchMutationAuditActor {
  readonly actorUserId?: string | null;
  readonly actorRole?: string | null;
  readonly nowMs?: number;
}

export interface DeleteBranchOptions extends BranchMutationAuditActor {
  readonly expectedVersion?: number;
}

export interface DeleteBranchResult {
  readonly deleted: true;
  readonly id: number;
  readonly totalRemaining: number;
}

interface RawBranchRow {
  readonly id: number;
  readonly name: string;
  readonly address: string;
  readonly city: string | null;
  readonly province: string | null;
  readonly postal_code: string | null;
  readonly phone: string | null;
  readonly whatsapp_e164: string | null;
  readonly maps_url: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly weekday_hours_json: string | null;
  readonly holiday_hours_json: string | null;
  readonly timezone: string;
  readonly sort_order: number;
  readonly is_primary: number;
  readonly active: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function serializeHoursColumn(hours: string | null): string | null {
  if (hours === null) return null;
  const trimmed = hours.trim();
  if (!trimmed) return null;
  return JSON.stringify(trimmed);
}

function parseHoursColumn(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") {
      const trimmed = parsed.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.text === "string" && obj.text.trim().length > 0) {
        return obj.text.trim();
      }
      if (typeof obj.label === "string" && obj.label.trim().length > 0) {
        return obj.label.trim();
      }
    }
  } catch {
    // Plain string fallback for rows stored without JSON quotes
    return raw.trim() || null;
  }
  return null;
}

function toIsoTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return new Date(0).toISOString();
  }
  return new Date(ms).toISOString();
}

function mapRawBranchRow(row: RawBranchRow): BranchRecord {
  const weekdayHours = parseHoursColumn(row.weekday_hours_json);
  const holidayHours = parseHoursColumn(row.holiday_hours_json);
  const openingHours: BranchOpeningHours | null =
    weekdayHours !== null || holidayHours !== null
      ? { weekday: weekdayHours, holiday: holidayHours }
      : null;
  const whatsappE164 = row.whatsapp_e164 ? String(row.whatsapp_e164) : null;
  const latitude =
    typeof row.latitude === "number" && Number.isFinite(row.latitude) ? row.latitude : null;
  const longitude =
    typeof row.longitude === "number" && Number.isFinite(row.longitude) ? row.longitude : null;

  return {
    id: Number(row.id),
    name: String(row.name),
    address: String(row.address),
    city: row.city ? String(row.city) : null,
    province: row.province ? String(row.province) : null,
    postalCode: row.postal_code ? String(row.postal_code) : null,
    phone: row.phone ? String(row.phone) : null,
    whatsappE164,
    whatsappNumber: whatsappE164,
    mapsUrl: row.maps_url ? String(row.maps_url) : null,
    latitude,
    longitude,
    weekdayHours,
    holidayHours,
    openingHours,
    timezone: row.timezone ? String(row.timezone) : DEFAULT_BRANCH_TIMEZONE,
    sortOrder: Number(row.sort_order ?? 0),
    isPrimary: Number(row.is_primary ?? 0) === 1,
    active: Number(row.active ?? 1) === 1,
    version: Number(row.version ?? 1),
    createdAt: toIsoTimestamp(Number(row.created_at)),
    updatedAt: toIsoTimestamp(Number(row.updated_at)),
  };
}

const SELECT_BRANCH_COLUMNS = `
  id,
  name,
  address,
  city,
  province,
  postal_code,
  phone,
  whatsapp_e164,
  maps_url,
  latitude,
  longitude,
  weekday_hours_json,
  holiday_hours_json,
  timezone,
  sort_order,
  is_primary,
  active,
  version,
  created_at,
  updated_at
`;

const SELECT_BRANCH_COLUMNS_LEGACY = `
  id,
  name,
  address,
  NULL AS city,
  NULL AS province,
  NULL AS postal_code,
  phone,
  whatsapp_e164,
  maps_url,
  latitude,
  longitude,
  weekday_hours_json,
  holiday_hours_json,
  timezone,
  sort_order,
  0 AS is_primary,
  active,
  version,
  created_at,
  updated_at
`;

function isMissingColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /no such column/i.test(msg);
}

/**
 * Lists all tenant branches (active and inactive) for the admin workspace in canonical order:
 * `is_primary DESC, sort_order ASC, id ASC`.
 */
export async function listBranchesForAdmin(tenantDb: D1Database): Promise<BranchListAdminDto> {
  let rows: RawBranchRow[];
  try {
    const res = await tenantDb
      .prepare(
        `SELECT ${SELECT_BRANCH_COLUMNS}
         FROM branches
         ORDER BY is_primary DESC, sort_order ASC, id ASC`,
      )
      .all<RawBranchRow>();
    rows = res.results;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const legacyRes = await tenantDb
      .prepare(
        `SELECT ${SELECT_BRANCH_COLUMNS_LEGACY}
         FROM branches
         ORDER BY sort_order ASC, id ASC`,
      )
      .all<RawBranchRow>();
    rows = legacyRes.results;
  }

  const items = rows.map(mapRawBranchRow);
  const total = items.length;
  const primary = items.find((b) => b.isPrimary) ?? null;

  return {
    items,
    total,
    maxBranches: MAX_BRANCHES_PER_TENANT,
    remainingSlots: Math.max(0, MAX_BRANCHES_PER_TENANT - total),
    primaryBranchId: primary ? primary.id : null,
  };
}

/**
 * Lists ONLY active branches for public rendering and Schema.org `@graph` generation,
 * ordered canonically (`is_primary DESC, sort_order ASC, id ASC`) and capped at 10.
 */
export async function listActiveBranchesForPublic(
  tenantDb: D1Database,
): Promise<readonly BranchRecord[]> {
  let rows: RawBranchRow[];
  try {
    const res = await tenantDb
      .prepare(
        `SELECT ${SELECT_BRANCH_COLUMNS}
         FROM branches
         WHERE active = 1
         ORDER BY is_primary DESC, sort_order ASC, id ASC
         LIMIT ?`,
      )
      .bind(MAX_BRANCHES_PER_TENANT)
      .all<RawBranchRow>();
    rows = res.results;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const legacyRes = await tenantDb
      .prepare(
        `SELECT ${SELECT_BRANCH_COLUMNS_LEGACY}
         FROM branches
         WHERE active = 1
         ORDER BY sort_order ASC, id ASC
         LIMIT ?`,
      )
      .bind(MAX_BRANCHES_PER_TENANT)
      .all<RawBranchRow>();
    rows = legacyRes.results;
  }
  return rows.map(mapRawBranchRow);
}

/**
 * Fetches a single branch by per-tenant sequential integer ID.
 */
export async function getBranchById(
  tenantDb: D1Database,
  branchId: number,
): Promise<BranchRecord | null> {
  if (!Number.isSafeInteger(branchId) || branchId < 1) {
    return null;
  }
  try {
    const row = await tenantDb
      .prepare(`SELECT ${SELECT_BRANCH_COLUMNS} FROM branches WHERE id = ? LIMIT 1`)
      .bind(branchId)
      .first<RawBranchRow>();
    return row ? mapRawBranchRow(row) : null;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const legacyRow = await tenantDb
      .prepare(`SELECT ${SELECT_BRANCH_COLUMNS_LEGACY} FROM branches WHERE id = ? LIMIT 1`)
      .bind(branchId)
      .first<RawBranchRow>();
    return legacyRow ? mapRawBranchRow(legacyRow) : null;
  }
}

/**
 * Creates a new branch atomically inside `TenantStore`:
 * - Enforces max `10` branches per tenant atomically inside SQL (`WHERE (SELECT COUNT(*) FROM branches) < 10`).
 * - Allocates sequential positive integer ID from `sequences` (`kind = 'branch'`).
 * - Enforces single-primary-branch invariant atomically when `isPrimary: true`.
 * - Records an audit entry in `tenant_activity_log` chained on `WHERE changes() = 1`.
 */
export async function createBranch(
  tenantDb: D1Database,
  rawInput: unknown,
  actor: BranchMutationAuditActor = {},
): Promise<BranchRecord> {
  const validated = validateBranchCreatePayload(rawInput);
  if (!validated.ok) {
    throw new BranchValidationError(validated.message, validated.fields);
  }
  const data = validated.data;
  const nowMs = Math.floor(actor.nowMs ?? Date.now());
  const actorUserId = actor.actorUserId ?? null;
  const actorRole = actor.actorRole ?? "admin";

  // Pre-check current count & default sort order (atomic SQL guard still enforces cap under concurrency!)
  const countRow = await tenantDb
    .prepare(`SELECT COUNT(*) AS cnt, COALESCE(MAX(sort_order), -1) AS max_sort FROM branches`)
    .first<{ readonly cnt: number; readonly max_sort: number }>();
  const currentCount = Number(countRow?.cnt ?? 0);
  if (currentCount >= MAX_BRANCHES_PER_TENANT) {
    throw new BranchLimitReachedError();
  }

  const nextSortOrder =
    data.sortOrder !== undefined
      ? data.sortOrder
      : Math.min(100, Number(countRow?.max_sort ?? -1) + 1);

  const branchId = await allocateNextSequenceId(tenantDb, "branch");
  const auditMetadata = JSON.stringify({
    branchId,
    name: data.name,
    isPrimary: data.isPrimary,
    active: data.active,
    sortOrder: nextSortOrder,
  });

  const statements: D1PreparedStatement[] = [];

  // Stmt 0 (optional): Clear previous primary atomically ONLY if we are still under the 10-branch cap
  if (data.isPrimary) {
    statements.push(
      tenantDb
        .prepare(
          `UPDATE branches
           SET is_primary = 0, version = version + 1, updated_at = ?
           WHERE is_primary = 1
             AND (SELECT COUNT(*) FROM branches) < ?`,
        )
        .bind(nowMs, MAX_BRANCHES_PER_TENANT),
    );
  }

  // Insert statement with atomic SQL cap check (prevents parallel creates from ever exceeding 10)
  const insertStmtIndex = statements.length;
  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO branches (
           id, name, address, city, province, postal_code,
           phone, whatsapp_e164, maps_url, latitude, longitude,
           weekday_hours_json, holiday_hours_json, timezone,
           sort_order, is_primary, active, version, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
         WHERE (SELECT COUNT(*) FROM branches) < ?`,
      )
      .bind(
        branchId,
        data.name,
        data.address,
        data.city,
        data.province,
        data.postalCode,
        data.phone,
        data.whatsappE164,
        data.mapsUrl,
        data.latitude,
        data.longitude,
        serializeHoursColumn(data.weekdayHours),
        serializeHoursColumn(data.holidayHours),
        data.timezone,
        nextSortOrder,
        data.isPrimary ? 1 : 0,
        data.active ? 1 : 0,
        nowMs,
        nowMs,
        MAX_BRANCHES_PER_TENANT,
      ),
  );

  // Audit log strictly chained on `changes() = 1` from the INSERT
  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'branch.created', 'branch', ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        actorUserId,
        actorRole,
        String(branchId),
        `Menambahkan cabang "${data.name}"`,
        auditMetadata,
        nowMs,
      ),
  );

  const results = await tenantDb.batch(statements);
  const insertChanges = Number(results[insertStmtIndex]?.meta?.changes ?? 0);
  if (insertChanges !== 1) {
    throw new BranchLimitReachedError();
  }

  const created = await getBranchById(tenantDb, branchId);
  if (!created) {
    throw new Error(`Failed to reload newly created branch #${branchId}.`);
  }
  return created;
}

/**
 * Updates an existing branch atomically inside `TenantStore`:
 * - Enforces Optimistic Concurrency Control (`expectedVersion` -> `409 STALE_VERSION`).
 * - Enforces single-primary-branch invariant atomically when promoting `isPrimary: true`
 *   (clearing previous primary ONLY IF the target row still matches `guardVersion`).
 * - Records an audit entry in `tenant_activity_log` chained on `WHERE changes() = 1`.
 */
export async function updateBranch(
  tenantDb: D1Database,
  branchId: number,
  rawInput: unknown,
  actor: BranchMutationAuditActor = {},
): Promise<BranchRecord> {
  if (!Number.isSafeInteger(branchId) || branchId < 1) {
    throw new BranchNotFoundError(branchId);
  }

  const existing = await getBranchById(tenantDb, branchId);
  if (!existing) {
    throw new BranchNotFoundError(branchId);
  }

  const validated = validateBranchUpdatePayload(rawInput, {
    latitude: existing.latitude,
    longitude: existing.longitude,
  });
  if (!validated.ok) {
    throw new BranchValidationError(validated.message, validated.fields);
  }
  const patch = validated.data;

  if (patch.expectedVersion !== undefined && patch.expectedVersion !== existing.version) {
    throw new BranchStaleVersionError(branchId, patch.expectedVersion, existing.version);
  }

  const guardVersion = patch.expectedVersion ?? existing.version;
  const nowMs = Math.floor(actor.nowMs ?? Date.now());
  const actorUserId = actor.actorUserId ?? null;
  const actorRole = actor.actorRole ?? "admin";

  const nextName = patch.name !== undefined ? patch.name : existing.name;
  const nextAddress = patch.address !== undefined ? patch.address : existing.address;
  const nextCity = patch.city !== undefined ? patch.city : existing.city;
  const nextProvince = patch.province !== undefined ? patch.province : existing.province;
  const nextPostalCode = patch.postalCode !== undefined ? patch.postalCode : existing.postalCode;
  const nextPhone = patch.phone !== undefined ? patch.phone : existing.phone;
  const nextWhatsapp = patch.whatsappE164 !== undefined ? patch.whatsappE164 : existing.whatsappE164;
  const nextMapsUrl = patch.mapsUrl !== undefined ? patch.mapsUrl : existing.mapsUrl;
  const nextLatitude = patch.latitude !== undefined ? patch.latitude : existing.latitude;
  const nextLongitude = patch.longitude !== undefined ? patch.longitude : existing.longitude;
  const nextWeekdayHours =
    patch.weekdayHours !== undefined ? patch.weekdayHours : existing.weekdayHours;
  const nextHolidayHours =
    patch.holidayHours !== undefined ? patch.holidayHours : existing.holidayHours;
  const nextTimezone = patch.timezone !== undefined ? patch.timezone : existing.timezone;
  const nextSortOrder = patch.sortOrder !== undefined ? patch.sortOrder : existing.sortOrder;
  const nextIsPrimary = patch.isPrimary !== undefined ? patch.isPrimary : existing.isPrimary;
  const nextActive = patch.active !== undefined ? patch.active : existing.active;

  const auditMetadata = JSON.stringify({
    branchId,
    name: nextName,
    previousVersion: guardVersion,
    nextVersion: guardVersion + 1,
    isPrimary: nextIsPrimary,
    active: nextActive,
  });

  const statements: D1PreparedStatement[] = [];

  // Stmt 0 (when promoting to primary): demote any other primary ONLY IF target row still matches guardVersion
  if (nextIsPrimary && !existing.isPrimary) {
    statements.push(
      tenantDb
        .prepare(
          `UPDATE branches
           SET is_primary = 0, version = version + 1, updated_at = ?
           WHERE is_primary = 1
             AND id != ?
             AND EXISTS (SELECT 1 FROM branches WHERE id = ? AND version = ?)`,
        )
        .bind(nowMs, branchId, branchId, guardVersion),
    );
  }

  // Target OCC-guarded UPDATE
  const updateStmtIndex = statements.length;
  statements.push(
    tenantDb
      .prepare(
        `UPDATE branches
         SET name = ?,
             address = ?,
             city = ?,
             province = ?,
             postal_code = ?,
             phone = ?,
             whatsapp_e164 = ?,
             maps_url = ?,
             latitude = ?,
             longitude = ?,
             weekday_hours_json = ?,
             holiday_hours_json = ?,
             timezone = ?,
             sort_order = ?,
             is_primary = ?,
             active = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(
        nextName,
        nextAddress,
        nextCity,
        nextProvince,
        nextPostalCode,
        nextPhone,
        nextWhatsapp,
        nextMapsUrl,
        nextLatitude,
        nextLongitude,
        serializeHoursColumn(nextWeekdayHours),
        serializeHoursColumn(nextHolidayHours),
        nextTimezone,
        nextSortOrder,
        nextIsPrimary ? 1 : 0,
        nextActive ? 1 : 0,
        nowMs,
        branchId,
        guardVersion,
      ),
  );

  // Audit log strictly chained on `changes() = 1` from the target UPDATE
  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'branch.updated', 'branch', ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        actorUserId,
        actorRole,
        String(branchId),
        `Memperbarui cabang "${nextName}"`,
        auditMetadata,
        nowMs,
      ),
  );

  const results = await tenantDb.batch(statements);
  const updateChanges = Number(results[updateStmtIndex]?.meta?.changes ?? 0);
  if (updateChanges !== 1) {
    const current = await getBranchById(tenantDb, branchId);
    if (!current) {
      throw new BranchNotFoundError(branchId);
    }
    throw new BranchStaleVersionError(branchId, guardVersion, current.version);
  }

  const updated = await getBranchById(tenantDb, branchId);
  if (!updated) {
    throw new BranchNotFoundError(branchId);
  }
  return updated;
}

/**
 * Deletes a branch atomically inside `TenantStore`:
 * - Supports optional `expectedVersion` OCC check (`409 STALE_VERSION`).
 * - Detaches any `leads.branch_id` FK references atomically before deletion so lead history survives.
 * - Records an audit entry in `tenant_activity_log` chained on `WHERE changes() = 1`.
 */
export async function deleteBranch(
  tenantDb: D1Database,
  branchId: number,
  options: DeleteBranchOptions = {},
): Promise<DeleteBranchResult> {
  if (!Number.isSafeInteger(branchId) || branchId < 1) {
    throw new BranchNotFoundError(branchId);
  }

  const existing = await getBranchById(tenantDb, branchId);
  if (!existing) {
    throw new BranchNotFoundError(branchId);
  }

  if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
    throw new BranchStaleVersionError(branchId, options.expectedVersion, existing.version);
  }

  const nowMs = Math.floor(options.nowMs ?? Date.now());
  const actorUserId = options.actorUserId ?? null;
  const actorRole = options.actorRole ?? "admin";
  const expectedVersionParam = options.expectedVersion ?? null;

  const auditMetadata = JSON.stringify({
    branchId,
    name: existing.name,
    wasPrimary: existing.isPrimary,
    deletedVersion: existing.version,
  });

  const statements: D1PreparedStatement[] = [
    // Stmt 0: Detach leads.branch_id ONLY IF the target branch matches optional version guard
    tenantDb
      .prepare(
        `UPDATE leads
         SET branch_id = NULL, updated_at = ?
         WHERE branch_id = ?
           AND EXISTS (SELECT 1 FROM branches WHERE id = ? AND (? IS NULL OR version = ?))`,
      )
      .bind(nowMs, branchId, branchId, expectedVersionParam, expectedVersionParam),
    // Stmt 1: Delete branch row with optional OCC guard
    expectedVersionParam !== null
      ? tenantDb
          .prepare(`DELETE FROM branches WHERE id = ? AND version = ?`)
          .bind(branchId, expectedVersionParam)
      : tenantDb.prepare(`DELETE FROM branches WHERE id = ?`).bind(branchId),
    // Stmt 2: Audit log strictly chained on `changes() = 1` from DELETE
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'branch.deleted', 'branch', ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        actorUserId,
        actorRole,
        String(branchId),
        `Menghapus cabang "${existing.name}"`,
        auditMetadata,
        nowMs,
      ),
  ];

  const results = await tenantDb.batch(statements);
  const deleteChanges = Number(results[1]?.meta?.changes ?? 0);
  if (deleteChanges !== 1) {
    const current = await getBranchById(tenantDb, branchId);
    if (!current) {
      throw new BranchNotFoundError(branchId);
    }
    throw new BranchStaleVersionError(
      branchId,
      options.expectedVersion ?? existing.version,
      current.version,
    );
  }

  const remainingRow = await tenantDb
    .prepare(`SELECT COUNT(*) AS cnt FROM branches`)
    .first<{ readonly cnt: number }>();

  return {
    deleted: true,
    id: branchId,
    totalRemaining: Number(remainingRow?.cnt ?? 0),
  };
}

/**
 * Atomically reorders all existing branches according to `branchIds` (`sort_order = 0..N-1`),
 * bumping each updated branch's `version` and writing a single audit entry.
 */
export async function reorderBranches(
  tenantDb: D1Database,
  rawInput: unknown,
  actor: BranchMutationAuditActor = {},
): Promise<BranchListAdminDto> {
  const validated = validateBranchReorderPayload(rawInput);
  if (!validated.ok) {
    throw new BranchValidationError(validated.message, validated.fields);
  }
  const { branchIds } = validated.data;

  const existing = await listBranchesForAdmin(tenantDb);
  const existingIds = new Set(existing.items.map((b) => b.id));

  if (branchIds.length !== existingIds.size || branchIds.some((id) => !existingIds.has(id))) {
    throw new BranchValidationError(
      "Daftar branchIds harus memuat seluruh cabang tenant secara tepat tanpa ID asing.",
      [
        {
          field: "branchIds",
          code: "INVALID_BRANCH_REORDER_SET",
          message: "branchIds harus mencakup tepat semua cabang yang ada pada situs ini.",
        },
      ],
    );
  }

  const nowMs = Math.floor(actor.nowMs ?? Date.now());
  const actorUserId = actor.actorUserId ?? null;
  const actorRole = actor.actorRole ?? "admin";

  const statements: D1PreparedStatement[] = branchIds.map((id, index) =>
    tenantDb
      .prepare(
        `UPDATE branches
         SET sort_order = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .bind(index, nowMs, id),
  );

  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         VALUES (?, ?, 'branch.reordered', 'branch', 'all', ?, ?, ?)`,
      )
      .bind(
        actorUserId,
        actorRole,
        `Mengubah urutan ${branchIds.length} cabang`,
        JSON.stringify({ branchIds }),
        nowMs,
      ),
  );

  await tenantDb.batch(statements);
  return listBranchesForAdmin(tenantDb);
}

export interface BranchCacheSyncResult {
  readonly synced: boolean;
  readonly cacheVersion: number | null;
}

/**
 * Post-commit cache invalidation helper for `PLATFORM_DB.tenants.cache_version`.
 * NEVER throws after a `TenantStore` mutation has already committed, so a transient
 * D1 error cannot convert a committed branch create/update/delete/reorder into a 503
 * (preventing duplicate branch retries). Always evicts the in-isolate routing cache
 * in `finally` and returns honest `{ synced, cacheVersion }`.
 */
export async function bumpTenantCacheVersionForBranches(
  platformDb: D1Database,
  tenantId: string,
  nowMs?: number,
): Promise<BranchCacheSyncResult> {
  const ts = Math.floor(nowMs ?? Date.now());
  try {
    const row = await platformDb
      .prepare(
        `UPDATE tenants
         SET cache_version = cache_version + 1, updated_at = ?
         WHERE id = ?
         RETURNING cache_version`,
      )
      .bind(ts, tenantId)
      .first<{ readonly cache_version: number }>();

    if (!row) {
      console.warn(
        JSON.stringify({
          event: "branches.cache_version_bump_missing_tenant",
          tenantId,
        }),
      );
      return { synced: false, cacheVersion: null };
    }

    return { synced: true, cacheVersion: Number(row.cache_version) };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "branches.cache_version_bump_failed",
        tenantId,
        errorName: err instanceof Error ? err.name : "UnknownError",
      }),
    );
    return { synced: false, cacheVersion: null };
  } finally {
    evictTenantFromCache(tenantId);
  }
}
