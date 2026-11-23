import { allocateNextSequenceId } from "../identifiers/index.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";
import {
  buildOutletDirectionsUrl,
  buildOutletMapEmbedUrl,
  DEFAULT_OUTLET_TIMEZONE,
  formatHolidayHoursSummary,
  formatWeeklyHoursSummary,
  MAX_OUTLETS_PER_TENANT,
  normalizeOutletMapsUrl,
  normalizeOutletPhoneE164,
  normalizeOutletWhatsAppE164,
  slugifyOutletName,
  validateOutletCreatePayload,
  validateOutletHolidayHours,
  validateOutletUpdatePayload,
  validateOutletWeeklyHours,
  type OutletHolidayHoursEntry,
  type OutletRecord,
  type OutletStatus,
  type OutletValidationFieldIssue,
  type OutletWeeklyHoursEntry,
} from "./schema.ts";

export * from "./schema.ts";

/**
 * Multi-Outlet Directory (`outlets`) TenantStore Repository
 * (`packages/db/src/outlets/index.ts`; REQ-029, REQ-039, REQ-054, TASK-019).
 *
 * Persists cleanly on the existing `TenantStore.branches` schema (ZERO request-time DDL,
 * 100% compatible with both `0001_initial_tenant.sql` and `0017_branches.sql` AND with
 * `TASK-088` `packages/db/src/branches/`):
 * - Structured weekly hours, slug, draft/published status, and fallback address parts are
 *   stored in `weekday_hours_json` alongside human-readable `text` so `branches` reads it seamlessly.
 * - Structured holiday hours are stored in `holiday_hours_json` alongside human-readable `text`.
 * - SQL `branches.active = 1` strictly represents publicly visible outlets (`active && status === 'published'`),
 *   so draft or inactive outlets NEVER leak through either `outlets` or `branches` public queries.
 * - Enforces max 10 outlets atomically in SQL (`WHERE (SELECT COUNT(*) FROM branches) < 10`),
 *   unique slug per tenant, Optimistic Concurrency Control (`expectedVersion` -> `409 STALE_VERSION`),
 *   atomic `leads.branch_id` FK detachment on delete, and chained audit log writes (`WHERE changes() = 1`).
 */

export class OutletValidationError extends Error {
  readonly code: "VALIDATION_ERROR" | "OUTLET_LIMIT_REACHED" | "DUPLICATE_OUTLET_SLUG";
  readonly fields: readonly OutletValidationFieldIssue[];

  constructor(
    message: string,
    fields: readonly OutletValidationFieldIssue[] = [],
    code: "VALIDATION_ERROR" | "OUTLET_LIMIT_REACHED" | "DUPLICATE_OUTLET_SLUG" = "VALIDATION_ERROR",
  ) {
    super(message);
    this.name = "OutletValidationError";
    this.code = code;
    this.fields = fields;
  }
}

export class OutletLimitReachedError extends OutletValidationError {
  readonly maxOutlets: number = MAX_OUTLETS_PER_TENANT;

  constructor(
    message = `Maksimal ${MAX_OUTLETS_PER_TENANT} gerai per situs telah tercapai. Hapus salah satu gerai terlebih dahulu sebelum menambah gerai baru.`,
  ) {
    super(
      message,
      [{ field: "outlets", code: "OUTLET_LIMIT_REACHED", message }],
      "OUTLET_LIMIT_REACHED",
    );
    this.name = "OutletLimitReachedError";
  }
}

export class OutletDuplicateSlugError extends OutletValidationError {
  readonly slug: string;

  constructor(slug: string) {
    const message = `Slug gerai "${slug}" sudah digunakan oleh gerai lain pada situs ini.`;
    super(message, [{ field: "slug", code: "DUPLICATE_OUTLET_SLUG", message }], "DUPLICATE_OUTLET_SLUG");
    this.name = "OutletDuplicateSlugError";
    this.slug = slug;
  }
}

export class OutletNotFoundError extends Error {
  readonly outletId: number;

  constructor(outletId: number, message = `Gerai #${outletId} tidak ditemukan.`) {
    super(message);
    this.name = "OutletNotFoundError";
    this.outletId = outletId;
  }
}

export class OutletStaleVersionError extends Error {
  readonly outletId: number;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(
    outletId: number,
    expectedVersion: number,
    actualVersion: number | null,
    message = "Data gerai telah diubah di sesi lain. Muat ulang daftar gerai sebelum menyimpan.",
  ) {
    super(message);
    this.name = "OutletStaleVersionError";
    this.outletId = outletId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export interface OutletListAdminDto {
  readonly items: readonly OutletRecord[];
  readonly total: number;
  readonly maxOutlets: typeof MAX_OUTLETS_PER_TENANT;
  readonly remainingSlots: number;
  readonly primaryOutletId: number | null;
}

export interface OutletMutationAuditActor {
  readonly actorUserId?: string | null;
  readonly actorRole?: string | null;
  readonly nowMs?: number;
}

export interface DeleteOutletOptions extends OutletMutationAuditActor {
  readonly expectedVersion?: number;
}

export interface DeleteOutletResult {
  readonly deleted: true;
  readonly id: number;
  readonly totalRemaining: number;
}

interface RawOutletRow {
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

interface StoredWeekdayPayload {
  readonly text: string | null;
  readonly slug?: string;
  readonly status?: OutletStatus;
  readonly active?: boolean;
  readonly isPrimary?: boolean;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
  readonly weeklyHours?: readonly OutletWeeklyHoursEntry[];
}

interface StoredHolidayPayload {
  readonly text: string | null;
  readonly entries?: readonly OutletHolidayHoursEntry[];
}

const SELECT_OUTLET_COLUMNS = `
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

const SELECT_OUTLET_COLUMNS_LEGACY = `
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

function serializeWeekdayPayload(params: {
  readonly slug: string;
  readonly status: OutletStatus;
  readonly active: boolean;
  readonly isPrimary: boolean;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly weeklyHours: readonly OutletWeeklyHoursEntry[];
}): string {
  const payload: StoredWeekdayPayload = {
    text: formatWeeklyHoursSummary(params.weeklyHours),
    slug: params.slug,
    status: params.status,
    active: params.active,
    isPrimary: params.isPrimary,
    city: params.city,
    province: params.province,
    postalCode: params.postalCode,
    weeklyHours: params.weeklyHours,
  };
  return JSON.stringify(payload);
}

function serializeHolidayPayload(
  holidayHours: readonly OutletHolidayHoursEntry[],
): string | null {
  if (!holidayHours || holidayHours.length === 0) return null;
  const payload: StoredHolidayPayload = {
    text: formatHolidayHoursSummary(holidayHours),
    entries: holidayHours,
  };
  return JSON.stringify(payload);
}

function parseStoredWeekdayPayload(raw: string | null | undefined): StoredWeekdayPayload {
  if (!raw || !raw.trim()) return { text: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") {
      return { text: parsed.trim() || null };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const weeklyCheck = validateOutletWeeklyHours(obj.weeklyHours);
      return {
        text: typeof obj.text === "string" && obj.text.trim() ? obj.text.trim() : null,
        slug: typeof obj.slug === "string" && obj.slug.trim() ? obj.slug.trim() : undefined,
        status: obj.status === "draft" || obj.status === "published" ? obj.status : undefined,
        active: typeof obj.active === "boolean" ? obj.active : undefined,
        isPrimary: typeof obj.isPrimary === "boolean" ? obj.isPrimary : undefined,
        city: typeof obj.city === "string" ? obj.city : obj.city === null ? null : undefined,
        province:
          typeof obj.province === "string"
            ? obj.province
            : obj.province === null
              ? null
              : undefined,
        postalCode:
          typeof obj.postalCode === "string"
            ? obj.postalCode
            : obj.postalCode === null
              ? null
              : undefined,
        weeklyHours: weeklyCheck.ok ? weeklyCheck.data : [],
      };
    }
  } catch {
    return { text: raw.trim() || null };
  }
  return { text: null };
}

function parseStoredHolidayPayload(raw: string | null | undefined): StoredHolidayPayload {
  if (!raw || !raw.trim()) return { text: null, entries: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") {
      return { text: parsed.trim() || null, entries: [] };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const holidayCheck = validateOutletHolidayHours(obj.entries);
      return {
        text: typeof obj.text === "string" && obj.text.trim() ? obj.text.trim() : null,
        entries: holidayCheck.ok ? holidayCheck.data : [],
      };
    }
  } catch {
    return { text: raw.trim() || null, entries: [] };
  }
  return { text: null, entries: [] };
}

function toIsoTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

function mapRawOutletRow(row: RawOutletRow): OutletRecord {
  const weekdayMeta = parseStoredWeekdayPayload(row.weekday_hours_json);
  const holidayMeta = parseStoredHolidayPayload(row.holiday_hours_json);

  const id = Number(row.id);
  const name = String(row.name);
  const address = String(row.address);
  const city = row.city !== null && row.city !== undefined ? String(row.city) : (weekdayMeta.city ?? null);
  const province =
    row.province !== null && row.province !== undefined
      ? String(row.province)
      : (weekdayMeta.province ?? null);
  const postalCode =
    row.postal_code !== null && row.postal_code !== undefined
      ? String(row.postal_code)
      : (weekdayMeta.postalCode ?? null);

  const phoneNorm = normalizeOutletPhoneE164(row.phone);
  const phone = phoneNorm.ok ? phoneNorm.value : (row.phone ? String(row.phone) : null);

  const waNorm = normalizeOutletWhatsAppE164(row.whatsapp_e164);
  const whatsappE164 = waNorm.ok
    ? waNorm.value
    : (row.whatsapp_e164 ? String(row.whatsapp_e164) : null);

  const latitude =
    typeof row.latitude === "number" && Number.isFinite(row.latitude) ? row.latitude : null;
  const longitude =
    typeof row.longitude === "number" && Number.isFinite(row.longitude) ? row.longitude : null;
  // Revalidate stored `maps_url` strictly on read so non-Google legacy URLs never propagate
  const safeStoredMapsUrl = normalizeOutletMapsUrl(row.maps_url);
  const mapsUrl = safeStoredMapsUrl.ok ? safeStoredMapsUrl.value : null;

  const weeklyHours = weekdayMeta.weeklyHours ?? [];
  const holidayHours = holidayMeta.entries ?? [];
  const weekdayHoursText = weekdayMeta.text ?? formatWeeklyHoursSummary(weeklyHours);
  const holidayHoursText = holidayMeta.text ?? formatHolidayHoursSummary(holidayHours);

  const sqlActive = Number(row.active ?? 1) === 1;
  const status: OutletStatus = weekdayMeta.status ?? "published";
  // Never let stale JSON metadata override SQL `active = 0` on non-draft rows (e.g. deactivated via TASK-088)
  const active =
    status === "draft"
      ? (weekdayMeta.active ?? false)
      : Boolean(sqlActive) && (weekdayMeta.active ?? true);
  const isPrimary =
    Number(row.is_primary ?? 0) === 1 || (row.is_primary === 0 && weekdayMeta.isPrimary === true);
  const slug = weekdayMeta.slug || slugifyOutletName(name, id);

  return {
    id,
    name,
    slug,
    address,
    city,
    province,
    postalCode,
    phone,
    whatsappE164,
    mapsUrl,
    directionsUrl: buildOutletDirectionsUrl({
      mapsUrl,
      latitude,
      longitude,
      address,
      city,
      province,
      postalCode,
    }),
    mapEmbedUrl: buildOutletMapEmbedUrl({ latitude, longitude }),
    latitude,
    longitude,
    weeklyHours,
    holidayHours,
    weekdayHoursText,
    holidayHoursText,
    timezone: row.timezone ? String(row.timezone) : DEFAULT_OUTLET_TIMEZONE,
    sortOrder: Number(row.sort_order ?? 0),
    isPrimary,
    status,
    active,
    version: Number(row.version ?? 1),
    createdAt: toIsoTimestamp(Number(row.created_at)),
    updatedAt: toIsoTimestamp(Number(row.updated_at)),
  };
}

function sortOutletsCanonically(items: readonly OutletRecord[]): OutletRecord[] {
  return [...items].sort((a, b) => {
    const primaryDiff = Number(b.isPrimary) - Number(a.isPrimary);
    if (primaryDiff !== 0) return primaryDiff;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id - b.id;
  });
}

async function queryAllRawOutlets(tenantDb: D1Database): Promise<RawOutletRow[]> {
  try {
    const res = await tenantDb
      .prepare(
        `SELECT ${SELECT_OUTLET_COLUMNS}
         FROM branches
         ORDER BY is_primary DESC, sort_order ASC, id ASC`,
      )
      .all<RawOutletRow>();
    return res.results;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const legacy = await tenantDb
      .prepare(
        `SELECT ${SELECT_OUTLET_COLUMNS_LEGACY}
         FROM branches
         ORDER BY sort_order ASC, id ASC`,
      )
      .all<RawOutletRow>();
    return legacy.results;
  }
}

async function hasExtendedBranchColumns(tenantDb: D1Database): Promise<boolean> {
  try {
    await tenantDb.prepare(`SELECT city, is_primary FROM branches LIMIT 1`).first();
    return true;
  } catch (err) {
    if (isMissingColumnError(err)) return false;
    throw err;
  }
}

function toDbWhatsAppDigits(whatsappE164: string | null): string | null {
  if (!whatsappE164) return null;
  return whatsappE164.replace(/^\+/, "");
}

function toDbPhoneDigits(phoneE164: string | null): string | null {
  if (!phoneE164) return null;
  return phoneE164.replace(/^\+/, "");
}

/**
 * Lists all tenant outlets (published, draft, active, inactive) for the admin manager.
 */
export async function listOutletsForAdmin(tenantDb: D1Database): Promise<OutletListAdminDto> {
  const rows = await queryAllRawOutlets(tenantDb);
  const items = sortOutletsCanonically(rows.map(mapRawOutletRow));
  const primary = items.find((o) => o.isPrimary) ?? null;

  return {
    items,
    total: items.length,
    maxOutlets: MAX_OUTLETS_PER_TENANT,
    remainingSlots: Math.max(0, MAX_OUTLETS_PER_TENANT - items.length),
    primaryOutletId: primary ? primary.id : null,
  };
}

/**
 * Lists ONLY published AND active outlets for public rendering & Schema.org JSON-LD.
 * Draft or inactive outlets are NEVER returned.
 */
export async function listPublishedOutletsForPublic(
  tenantDb: D1Database,
): Promise<readonly OutletRecord[]> {
  let rows: RawOutletRow[];
  try {
    const res = await tenantDb
      .prepare(
        `SELECT ${SELECT_OUTLET_COLUMNS}
         FROM branches
         WHERE active = 1
         ORDER BY is_primary DESC, sort_order ASC, id ASC
         LIMIT ?`,
      )
      .bind(MAX_OUTLETS_PER_TENANT)
      .all<RawOutletRow>();
    rows = res.results;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const legacy = await tenantDb
      .prepare(
        `SELECT ${SELECT_OUTLET_COLUMNS_LEGACY}
         FROM branches
         WHERE active = 1
         ORDER BY sort_order ASC, id ASC
         LIMIT ?`,
      )
      .bind(MAX_OUTLETS_PER_TENANT)
      .all<RawOutletRow>();
    rows = legacy.results;
  }

  return sortOutletsCanonically(rows.map(mapRawOutletRow))
    .filter((o) => o.active && o.status === "published")
    .slice(0, MAX_OUTLETS_PER_TENANT);
}

/**
 * Fetches a single outlet by per-tenant sequential integer ID.
 */
export async function getOutletById(
  tenantDb: D1Database,
  outletId: number,
): Promise<OutletRecord | null> {
  if (!Number.isSafeInteger(outletId) || outletId < 1) {
    return null;
  }
  try {
    const row = await tenantDb
      .prepare(`SELECT ${SELECT_OUTLET_COLUMNS} FROM branches WHERE id = ? LIMIT 1`)
      .bind(outletId)
      .first<RawOutletRow>();
    return row ? mapRawOutletRow(row) : null;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const legacy = await tenantDb
      .prepare(`SELECT ${SELECT_OUTLET_COLUMNS_LEGACY} FROM branches WHERE id = ? LIMIT 1`)
      .bind(outletId)
      .first<RawOutletRow>();
    return legacy ? mapRawOutletRow(legacy) : null;
  }
}

/**
 * Creates a new outlet atomically inside `TenantStore`:
 * - Enforces max 10 outlets atomically in SQL.
 * - Enforces unique slug per tenant.
 * - Allocates sequential positive integer ID from `sequences` (`kind = 'branch'`).
 * - Chains audit entry `outlet.created` on `WHERE changes() = 1`.
 */
export async function createOutlet(
  tenantDb: D1Database,
  rawInput: unknown,
  actor: OutletMutationAuditActor = {},
): Promise<OutletRecord> {
  const validated = validateOutletCreatePayload(rawInput);
  if (!validated.ok) {
    throw new OutletValidationError(validated.message, validated.fields);
  }
  const data = validated.data;
  const nowMs = Math.floor(actor.nowMs ?? Date.now());
  const actorUserId = actor.actorUserId ?? null;
  const actorRole = actor.actorRole ?? "admin";

  const existingList = await listOutletsForAdmin(tenantDb);
  if (existingList.total >= MAX_OUTLETS_PER_TENANT) {
    throw new OutletLimitReachedError();
  }
  if (existingList.items.some((o) => o.slug === data.slug)) {
    throw new OutletDuplicateSlugError(data.slug);
  }

  const maxSort = existingList.items.reduce((acc, o) => Math.max(acc, o.sortOrder), -1);
  const nextSortOrder =
    data.sortOrder !== undefined ? data.sortOrder : Math.min(100, maxSort + 1);

  const outletId = await allocateNextSequenceId(tenantDb, "branch");
  const sqlActiveInt = data.active && data.status === "published" ? 1 : 0;
  const weekdayJson = serializeWeekdayPayload({
    slug: data.slug,
    status: data.status,
    active: data.active,
    isPrimary: data.isPrimary,
    city: data.city,
    province: data.province,
    postalCode: data.postalCode,
    weeklyHours: data.weeklyHours,
  });
  const holidayJson = serializeHolidayPayload(data.holidayHours);
  const auditMetadata = JSON.stringify({
    outletId,
    slug: data.slug,
    name: data.name,
    status: data.status,
    active: data.active,
    isPrimary: data.isPrimary,
    sortOrder: nextSortOrder,
  });

  const extendedCols = await hasExtendedBranchColumns(tenantDb);
  const statements: D1PreparedStatement[] = [];

  const SLUG_UNIQUE_SQL_GUARD = `NOT EXISTS (
    SELECT 1 FROM branches
    WHERE json_valid(weekday_hours_json) = 1
      AND json_type(weekday_hours_json) = 'object'
      AND json_extract(weekday_hours_json, '$.slug') = ?
  )`;

  if (extendedCols && data.isPrimary) {
    statements.push(
      tenantDb
        .prepare(
          `UPDATE branches
           SET is_primary = 0, version = version + 1, updated_at = ?
           WHERE is_primary = 1
             AND (SELECT COUNT(*) FROM branches) < ?
             AND ${SLUG_UNIQUE_SQL_GUARD}`,
        )
        .bind(nowMs, MAX_OUTLETS_PER_TENANT, data.slug),
    );
  }

  const insertIdx = statements.length;
  if (extendedCols) {
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
           WHERE (SELECT COUNT(*) FROM branches) < ?
             AND ${SLUG_UNIQUE_SQL_GUARD}`,
        )
        .bind(
          outletId,
          data.name,
          data.address,
          data.city,
          data.province,
          data.postalCode,
          toDbPhoneDigits(data.phone),
          toDbWhatsAppDigits(data.whatsappE164),
          data.mapsUrl,
          data.latitude,
          data.longitude,
          weekdayJson,
          holidayJson,
          data.timezone,
          nextSortOrder,
          data.isPrimary ? 1 : 0,
          sqlActiveInt,
          nowMs,
          nowMs,
          MAX_OUTLETS_PER_TENANT,
          data.slug,
        ),
    );
  } else {
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO branches (
             id, name, address, phone, whatsapp_e164, maps_url, latitude, longitude,
             weekday_hours_json, holiday_hours_json, timezone,
             sort_order, active, version, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
           WHERE (SELECT COUNT(*) FROM branches) < ?
             AND ${SLUG_UNIQUE_SQL_GUARD}`,
        )
        .bind(
          outletId,
          data.name,
          data.address,
          toDbPhoneDigits(data.phone),
          toDbWhatsAppDigits(data.whatsappE164),
          data.mapsUrl,
          data.latitude,
          data.longitude,
          weekdayJson,
          holidayJson,
          data.timezone,
          nextSortOrder,
          sqlActiveInt,
          nowMs,
          nowMs,
          MAX_OUTLETS_PER_TENANT,
          data.slug,
        ),
    );
  }

  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'outlet.created', 'outlet', ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        actorUserId,
        actorRole,
        String(outletId),
        `Menambahkan gerai "${data.name}"`,
        auditMetadata,
        nowMs,
      ),
  );

  const results = await tenantDb.batch(statements);
  const insertChanges = Number(results[insertIdx]?.meta?.changes ?? 0);
  if (insertChanges !== 1) {
    // Re-query atomically to distinguish duplicate slug (409) vs 10-outlet limit (422)
    const latest = await listOutletsForAdmin(tenantDb);
    if (latest.items.some((o) => o.slug === data.slug)) {
      throw new OutletDuplicateSlugError(data.slug);
    }
    throw new OutletLimitReachedError();
  }

  const created = await getOutletById(tenantDb, outletId);
  if (!created) {
    throw new Error(`Failed to reload newly created outlet #${outletId}.`);
  }
  return created;
}

/**
 * Updates an existing outlet atomically inside `TenantStore` with Optimistic Concurrency Control
 * (`expectedVersion` -> `OutletStaleVersionError` / HTTP 409).
 */
export async function updateOutlet(
  tenantDb: D1Database,
  outletId: number,
  rawInput: unknown,
  actor: OutletMutationAuditActor = {},
): Promise<OutletRecord> {
  if (!Number.isSafeInteger(outletId) || outletId < 1) {
    throw new OutletNotFoundError(outletId);
  }

  const existing = await getOutletById(tenantDb, outletId);
  if (!existing) {
    throw new OutletNotFoundError(outletId);
  }

  const validated = validateOutletUpdatePayload(rawInput, {
    latitude: existing.latitude,
    longitude: existing.longitude,
  });
  if (!validated.ok) {
    throw new OutletValidationError(validated.message, validated.fields);
  }
  const patch = validated.data;

  if (patch.expectedVersion !== undefined && patch.expectedVersion !== existing.version) {
    throw new OutletStaleVersionError(outletId, patch.expectedVersion, existing.version);
  }

  const nextSlug = patch.slug !== undefined ? patch.slug : existing.slug;
  if (nextSlug !== existing.slug) {
    const all = await listOutletsForAdmin(tenantDb);
    if (all.items.some((o) => o.id !== outletId && o.slug === nextSlug)) {
      throw new OutletDuplicateSlugError(nextSlug);
    }
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
  const nextWhatsapp =
    patch.whatsappE164 !== undefined ? patch.whatsappE164 : existing.whatsappE164;
  const nextMapsUrl = patch.mapsUrl !== undefined ? patch.mapsUrl : existing.mapsUrl;
  const nextLatitude = patch.latitude !== undefined ? patch.latitude : existing.latitude;
  const nextLongitude = patch.longitude !== undefined ? patch.longitude : existing.longitude;
  const nextWeeklyHours =
    patch.weeklyHours !== undefined ? patch.weeklyHours : existing.weeklyHours;
  const nextHolidayHours =
    patch.holidayHours !== undefined ? patch.holidayHours : existing.holidayHours;
  const nextTimezone = patch.timezone !== undefined ? patch.timezone : existing.timezone;
  const nextSortOrder = patch.sortOrder !== undefined ? patch.sortOrder : existing.sortOrder;
  const nextIsPrimary = patch.isPrimary !== undefined ? patch.isPrimary : existing.isPrimary;
  const nextStatus = patch.status !== undefined ? patch.status : existing.status;
  const nextActive = patch.active !== undefined ? patch.active : existing.active;
  const sqlActiveInt = nextActive && nextStatus === "published" ? 1 : 0;

  const weekdayJson = serializeWeekdayPayload({
    slug: nextSlug,
    status: nextStatus,
    active: nextActive,
    isPrimary: nextIsPrimary,
    city: nextCity,
    province: nextProvince,
    postalCode: nextPostalCode,
    weeklyHours: nextWeeklyHours,
  });
  const holidayJson = serializeHolidayPayload(nextHolidayHours);

  const auditMetadata = JSON.stringify({
    outletId,
    slug: nextSlug,
    name: nextName,
    previousVersion: guardVersion,
    nextVersion: guardVersion + 1,
    status: nextStatus,
    active: nextActive,
    isPrimary: nextIsPrimary,
  });

  const extendedCols = await hasExtendedBranchColumns(tenantDb);
  const statements: D1PreparedStatement[] = [];

  const UPDATE_SLUG_UNIQUE_SQL_GUARD = `NOT EXISTS (
    SELECT 1 FROM branches
    WHERE id != ?
      AND json_valid(weekday_hours_json) = 1
      AND json_type(weekday_hours_json) = 'object'
      AND json_extract(weekday_hours_json, '$.slug') = ?
  )`;

  if (extendedCols && nextIsPrimary && !existing.isPrimary) {
    statements.push(
      tenantDb
        .prepare(
          `UPDATE branches
           SET is_primary = 0, version = version + 1, updated_at = ?
           WHERE is_primary = 1
             AND id != ?
             AND EXISTS (SELECT 1 FROM branches WHERE id = ? AND version = ?)
             AND ${UPDATE_SLUG_UNIQUE_SQL_GUARD}`,
        )
        .bind(nowMs, outletId, outletId, guardVersion, outletId, nextSlug),
    );
  }

  const updateIdx = statements.length;
  if (extendedCols) {
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
           WHERE id = ? AND version = ?
             AND ${UPDATE_SLUG_UNIQUE_SQL_GUARD}`,
        )
        .bind(
          nextName,
          nextAddress,
          nextCity,
          nextProvince,
          nextPostalCode,
          toDbPhoneDigits(nextPhone),
          toDbWhatsAppDigits(nextWhatsapp),
          nextMapsUrl,
          nextLatitude,
          nextLongitude,
          weekdayJson,
          holidayJson,
          nextTimezone,
          nextSortOrder,
          nextIsPrimary ? 1 : 0,
          sqlActiveInt,
          nowMs,
          outletId,
          guardVersion,
          outletId,
          nextSlug,
        ),
    );
  } else {
    statements.push(
      tenantDb
        .prepare(
          `UPDATE branches
           SET name = ?,
               address = ?,
               phone = ?,
               whatsapp_e164 = ?,
               maps_url = ?,
               latitude = ?,
               longitude = ?,
               weekday_hours_json = ?,
               holiday_hours_json = ?,
               timezone = ?,
               sort_order = ?,
               active = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?
             AND ${UPDATE_SLUG_UNIQUE_SQL_GUARD}`,
        )
        .bind(
          nextName,
          nextAddress,
          toDbPhoneDigits(nextPhone),
          toDbWhatsAppDigits(nextWhatsapp),
          nextMapsUrl,
          nextLatitude,
          nextLongitude,
          weekdayJson,
          holidayJson,
          nextTimezone,
          nextSortOrder,
          sqlActiveInt,
          nowMs,
          outletId,
          guardVersion,
          outletId,
          nextSlug,
        ),
    );
  }

  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'outlet.updated', 'outlet', ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        actorUserId,
        actorRole,
        String(outletId),
        `Memperbarui gerai "${nextName}"`,
        auditMetadata,
        nowMs,
      ),
  );

  const results = await tenantDb.batch(statements);
  const updateChanges = Number(results[updateIdx]?.meta?.changes ?? 0);
  if (updateChanges !== 1) {
    const current = await getOutletById(tenantDb, outletId);
    if (!current) {
      throw new OutletNotFoundError(outletId);
    }
    if (current.version !== guardVersion) {
      throw new OutletStaleVersionError(outletId, guardVersion, current.version);
    }
    const latest = await listOutletsForAdmin(tenantDb);
    if (latest.items.some((o) => o.id !== outletId && o.slug === nextSlug)) {
      throw new OutletDuplicateSlugError(nextSlug);
    }
    throw new OutletStaleVersionError(outletId, guardVersion, current.version);
  }

  const updated = await getOutletById(tenantDb, outletId);
  if (!updated) {
    throw new OutletNotFoundError(outletId);
  }
  return updated;
}

/**
 * Deletes an outlet atomically inside `TenantStore`:
 * - Optional `expectedVersion` OCC guard (`409 STALE_VERSION`).
 * - Atomically detaches any `leads.branch_id` FK references so lead history survives.
 * - Chains audit log entry `outlet.deleted` on `WHERE changes() = 1`.
 */
export async function deleteOutlet(
  tenantDb: D1Database,
  outletId: number,
  options: DeleteOutletOptions = {},
): Promise<DeleteOutletResult> {
  if (!Number.isSafeInteger(outletId) || outletId < 1) {
    throw new OutletNotFoundError(outletId);
  }

  const existing = await getOutletById(tenantDb, outletId);
  if (!existing) {
    throw new OutletNotFoundError(outletId);
  }

  if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
    throw new OutletStaleVersionError(outletId, options.expectedVersion, existing.version);
  }

  const nowMs = Math.floor(options.nowMs ?? Date.now());
  const actorUserId = options.actorUserId ?? null;
  const actorRole = options.actorRole ?? "admin";
  const expectedVersionParam = options.expectedVersion ?? null;

  const auditMetadata = JSON.stringify({
    outletId,
    slug: existing.slug,
    name: existing.name,
    deletedVersion: existing.version,
  });

  const statements: D1PreparedStatement[] = [
    tenantDb
      .prepare(
        `UPDATE leads
         SET branch_id = NULL, updated_at = ?
         WHERE branch_id = ?
           AND EXISTS (SELECT 1 FROM branches WHERE id = ? AND (? IS NULL OR version = ?))`,
      )
      .bind(nowMs, outletId, outletId, expectedVersionParam, expectedVersionParam),
    expectedVersionParam !== null
      ? tenantDb
          .prepare(`DELETE FROM branches WHERE id = ? AND version = ?`)
          .bind(outletId, expectedVersionParam)
      : tenantDb.prepare(`DELETE FROM branches WHERE id = ?`).bind(outletId),
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'outlet.deleted', 'outlet', ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(
        actorUserId,
        actorRole,
        String(outletId),
        `Menghapus gerai "${existing.name}"`,
        auditMetadata,
        nowMs,
      ),
  ];

  const results = await tenantDb.batch(statements);
  const deleteChanges = Number(results[1]?.meta?.changes ?? 0);
  if (deleteChanges !== 1) {
    const current = await getOutletById(tenantDb, outletId);
    if (!current) {
      throw new OutletNotFoundError(outletId);
    }
    throw new OutletStaleVersionError(
      outletId,
      options.expectedVersion ?? existing.version,
      current.version,
    );
  }

  const remainingRow = await tenantDb
    .prepare(`SELECT COUNT(*) AS cnt FROM branches`)
    .first<{ readonly cnt: number }>();

  return {
    deleted: true,
    id: outletId,
    totalRemaining: Number(remainingRow?.cnt ?? 0),
  };
}

export interface OutletCacheSyncResult {
  readonly synced: boolean;
  readonly cacheVersion: number | null;
}

/**
 * Post-commit atomic `cache_version` bump in `PLATFORM_DB.tenants` + in-isolate routing cache eviction.
 * Never throws after a committed TenantStore mutation.
 */
export async function bumpTenantCacheVersionForOutlets(
  platformDb: D1Database,
  tenantId: string,
  nowMs?: number,
): Promise<OutletCacheSyncResult> {
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
          event: "outlets.cache_version_bump_missing_tenant",
          tenantId,
        }),
      );
      return { synced: false, cacheVersion: null };
    }

    return { synced: true, cacheVersion: Number(row.cache_version) };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "outlets.cache_version_bump_failed",
        tenantId,
        errorName: err instanceof Error ? err.name : "UnknownError",
      }),
    );
    return { synced: false, cacheVersion: null };
  } finally {
    evictTenantFromCache(tenantId);
  }
}
