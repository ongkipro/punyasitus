import {
  parseStoredAnalyticsSettings,
  validateVendorMutualExclusion,
} from "@punyasitus/core/analytics/gtm";
import {
  createEmptyDirectAnalyticsConfig,
  parseStoredDirectAnalyticsConfig,
  validateDirectAnalyticsInput,
  type AnalyticsValidationField,
  type DirectAnalyticsConfig,
} from "@punyasitus/core/analytics/providers";

/**
 * Per-Tenant Direct Analytics Settings Persistence (`packages/db/src/analytics-settings/index.ts`;
 * TASK-022, REQ-027, REQ-039).
 *
 * Storage invariants:
 * - ZERO runtime DDL (`CREATE TABLE`). Uses the pre-existing `site_settings` singleton row
 *   (`id = 1`, column `analytics_config_json`, `version`, `updated_at`) and `tenant_activity_log`
 *   from `0001_initial_tenant.sql`.
 * - Preserves any unrelated pre-existing keys in `analytics_config_json` (such as a future
 *   `gtmContainerId` owned by `TASK-076`) while validating & updating only direct GA4, Meta Pixel,
 *   and TikTok Pixel IDs.
 * - Optimistic concurrency control (`expectedVersion` required -> `409 STALE_VERSION`) with
 *   a single atomic `tenantDb.batch` executing the guarded `UPDATE` + conditional PII-free
 *   `tenant_activity_log` audit `INSERT ... WHERE changes() = 1`.
 */

const SINGLETON_ID = 1 as const;
const DEFAULT_SITE_TITLE = "Situs Bisnis";

export interface TenantAnalyticsSettingsDto extends DirectAnalyticsConfig {
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface UpdateTenantAnalyticsSettingsInput {
  readonly patch: unknown;
  readonly expectedVersion: number;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly nowMs?: number;
}

interface RawSiteSettingsAnalyticsRow {
  readonly analytics_config_json: string | null;
  readonly version: number;
  readonly updated_at: number;
}

export class AnalyticsSettingsValidationError extends Error {
  readonly fields: readonly AnalyticsValidationField[];

  constructor(message: string, fields: readonly AnalyticsValidationField[]) {
    super(message);
    this.name = "AnalyticsSettingsValidationError";
    this.fields = fields;
  }
}

export class AnalyticsSettingsStaleVersionError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `Konflik versi pengaturan analitik: versi Anda (${expectedVersion}) sudah tertinggal dari versi terbaru (${actualVersion}). Muat ulang halaman sebelum menyimpan kembali.`,
    );
    this.name = "AnalyticsSettingsStaleVersionError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class AnalyticsSettingsStorageError extends Error {
  constructor(message = "Gagal mengakses penyimpanan pengaturan analitik tenant.") {
    super(message);
    this.name = "AnalyticsSettingsStorageError";
  }
}

function safeJsonParseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Treat corrupted JSON safely as empty object
  }
  return {};
}

function toIsoOrNull(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function buildAuditSummary(config: DirectAnalyticsConfig): string {
  const active: string[] = [];
  if (config.ga4MeasurementId) active.push("GA4");
  if (config.metaPixelId) active.push("Meta Pixel");
  if (config.tiktokPixelId) active.push("TikTok Pixel");
  return active.length > 0
    ? `Pengaturan analitik langsung diperbarui (${active.join(", ")})`
    : "Semua ID pelacak analitik langsung dinonaktifkan";
}

function buildAuditMetadata(config: DirectAnalyticsConfig, version: number): string {
  return JSON.stringify({
    providers: {
      ga4: Boolean(config.ga4MeasurementId),
      meta: Boolean(config.metaPixelId),
      tiktok: Boolean(config.tiktokPixelId),
    },
    version,
  });
}

async function readSiteSettingsRow(
  tenantDb: D1Database,
): Promise<RawSiteSettingsAnalyticsRow | null> {
  return tenantDb
    .prepare(
      `SELECT analytics_config_json, version, updated_at
       FROM site_settings
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(SINGLETON_ID)
    .first<RawSiteSettingsAnalyticsRow>();
}

/**
 * Reads the tenant's direct analytics settings (GA4, Meta Pixel, TikTok Pixel) + OCC version
 * from `site_settings`. Returns empty nulls with `version: 0` if `site_settings` has not been seeded yet.
 */
export async function getTenantAnalyticsSettings(
  tenantDb: D1Database,
): Promise<TenantAnalyticsSettingsDto> {
  try {
    const row = await readSiteSettingsRow(tenantDb);
    if (!row) {
      return {
        ...createEmptyDirectAnalyticsConfig(),
        version: 0,
        updatedAt: null,
      };
    }

    const parsed = safeJsonParseObject(row.analytics_config_json);
    const direct = parseStoredDirectAnalyticsConfig(parsed);
    return {
      ...direct,
      version: Number(row.version),
      updatedAt: toIsoOrNull(Number(row.updated_at)),
    };
  } catch (err) {
    if (
      err instanceof AnalyticsSettingsValidationError ||
      err instanceof AnalyticsSettingsStaleVersionError ||
      err instanceof AnalyticsSettingsStorageError
    ) {
      throw err;
    }
    throw new AnalyticsSettingsStorageError();
  }
}

/**
 * Validates and atomically updates direct analytics settings (`ga4MeasurementId`, `metaPixelId`,
 * `tiktokPixelId`) in `site_settings` with required optimistic concurrency (`expectedVersion`)
 * and an atomic PII-free audit entry in `tenant_activity_log` (`WHERE changes() = 1`).
 */
export async function updateTenantAnalyticsSettings(
  tenantDb: D1Database,
  input: UpdateTenantAnalyticsSettingsInput,
): Promise<TenantAnalyticsSettingsDto> {
  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion > 2_147_483_647
  ) {
    throw new AnalyticsSettingsValidationError(
      "Field expectedVersion wajib berupa bilangan bulat non-negatif.",
      [
        {
          field: "expectedVersion",
          code: "INVALID_VERSION",
          message: "expectedVersion must be a non-negative integer.",
        },
      ],
    );
  }

  const validation = validateDirectAnalyticsInput(input.patch);
  if (!validation.ok) {
    throw new AnalyticsSettingsValidationError(validation.message, validation.fields);
  }

  const explicitPatch = validation.patch;
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const actorUserId = input.actorUserId ?? null;
  const actorRole = input.actorRole ?? "admin";

  try {
    const current = await readSiteSettingsRow(tenantDb);

    // Case 1: Singleton `site_settings` row does not exist yet (expectedVersion must be 0)
    if (!current) {
      if (input.expectedVersion !== 0) {
        throw new AnalyticsSettingsStaleVersionError(input.expectedVersion, 0);
      }

      const nextDirect: DirectAnalyticsConfig = {
        ga4MeasurementId:
          explicitPatch.ga4MeasurementId !== undefined ? explicitPatch.ga4MeasurementId : null,
        metaPixelId: explicitPatch.metaPixelId !== undefined ? explicitPatch.metaPixelId : null,
        tiktokPixelId:
          explicitPatch.tiktokPixelId !== undefined ? explicitPatch.tiktokPixelId : null,
      };

      const serialized = JSON.stringify({
        ga4MeasurementId: nextDirect.ga4MeasurementId,
        metaPixelId: nextDirect.metaPixelId,
        tiktokPixelId: nextDirect.tiktokPixelId,
      });

      const batchResults = await tenantDb.batch<RawSiteSettingsAnalyticsRow>([
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO site_settings (
               id, site_title, analytics_config_json, version, updated_at
             )
             VALUES (?, ?, ?, 1, ?)`,
          )
          .bind(SINGLETON_ID, DEFAULT_SITE_TITLE, serialized, nowMs),
        tenantDb
          .prepare(
            `INSERT INTO tenant_activity_log (
               actor_user_id, actor_role, action, resource_type, resource_id,
               summary, metadata_json, created_at
             )
             SELECT ?, ?, 'analytics.settings_updated', 'site_settings', '1', ?, ?, ?
             WHERE changes() = 1`,
          )
          .bind(
            actorUserId,
            actorRole,
            buildAuditSummary(nextDirect),
            buildAuditMetadata(nextDirect, 1),
            nowMs,
          ),
      ]);

      const insertedChanges = Number(batchResults[0]?.meta?.changes ?? 0);
      if (insertedChanges !== 1) {
        const latest = await readSiteSettingsRow(tenantDb);
        throw new AnalyticsSettingsStaleVersionError(
          input.expectedVersion,
          latest ? Number(latest.version) : 0,
        );
      }

      return {
        ...nextDirect,
        version: 1,
        updatedAt: toIsoOrNull(nowMs),
      };
    }

    // Case 2: Singleton `site_settings` row already exists — verify OCC version
    const currentVersion = Number(current.version);
    if (currentVersion !== input.expectedVersion) {
      throw new AnalyticsSettingsStaleVersionError(input.expectedVersion, currentVersion);
    }

    const existingObj = safeJsonParseObject(current.analytics_config_json);
    const existingDirect = parseStoredDirectAnalyticsConfig(existingObj);

    // Partial PATCH semantics: omitted keys preserve existing stored values; explicit `null`/`""` clears them.
    const nextDirect: DirectAnalyticsConfig = {
      ga4MeasurementId: Object.prototype.hasOwnProperty.call(explicitPatch, "ga4MeasurementId")
        ? (explicitPatch.ga4MeasurementId ?? null)
        : existingDirect.ga4MeasurementId,
      metaPixelId: Object.prototype.hasOwnProperty.call(explicitPatch, "metaPixelId")
        ? (explicitPatch.metaPixelId ?? null)
        : existingDirect.metaPixelId,
      tiktokPixelId: Object.prototype.hasOwnProperty.call(explicitPatch, "tiktokPixelId")
        ? (explicitPatch.tiktokPixelId ?? null)
        : existingDirect.tiktokPixelId,
    };

    // Enforce anti-double-count mutual exclusion when GTM is actively enabled for a vendor
    const existingFull = parseStoredAnalyticsSettings(existingObj);
    if (existingFull.gtmEnabled && !existingFull.gtmOperatorDisabled) {
      const conflicts = validateVendorMutualExclusion(nextDirect, existingFull.vendorModes);
      if (conflicts.length > 0) {
        throw new AnalyticsSettingsValidationError(
          conflicts[0]?.message ??
            "Vendor sedang diatur melalui Google Tag Manager dan tidak boleh aktif langsung secara bersamaan.",
          conflicts,
        );
      }
    }

    // Preserve ALL unrelated keys in `analytics_config_json` (future GTM flags, risk ack metadata, custom flags, etc.)
    const mergedAnalytics: Record<string, unknown> = {
      ...existingObj,
      ga4MeasurementId: nextDirect.ga4MeasurementId,
      metaPixelId: nextDirect.metaPixelId,
      tiktokPixelId: nextDirect.tiktokPixelId,
    };

    const serialized = JSON.stringify(mergedAnalytics);
    const nextVersion = input.expectedVersion + 1;

    // Atomic single-transaction batch (`transactionSync` in TenantStore):
    // 1. Guarded optimistic UPDATE on `site_settings`
    // 2. Conditional PII-free `tenant_activity_log` INSERT executed ONLY when UPDATE matched (`changes() = 1`)
    const batchResults = await tenantDb.batch<RawSiteSettingsAnalyticsRow>([
      tenantDb
        .prepare(
          `UPDATE site_settings
           SET analytics_config_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?
           RETURNING analytics_config_json, version, updated_at`,
        )
        .bind(serialized, nowMs, SINGLETON_ID, input.expectedVersion),
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id,
             summary, metadata_json, created_at
           )
           SELECT ?, ?, 'analytics.settings_updated', 'site_settings', '1', ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          actorUserId,
          actorRole,
          buildAuditSummary(nextDirect),
          buildAuditMetadata(nextDirect, nextVersion),
          nowMs,
        ),
    ]);

    const updatedRow = batchResults[0]?.results?.[0] ?? null;
    if (!updatedRow) {
      const latest = await readSiteSettingsRow(tenantDb);
      throw new AnalyticsSettingsStaleVersionError(
        input.expectedVersion,
        latest ? Number(latest.version) : 0,
      );
    }

    const parsedUpdated = safeJsonParseObject(updatedRow.analytics_config_json);
    return {
      ...parseStoredDirectAnalyticsConfig(parsedUpdated),
      version: Number(updatedRow.version),
      updatedAt: toIsoOrNull(Number(updatedRow.updated_at)),
    };
  } catch (err) {
    if (
      err instanceof AnalyticsSettingsValidationError ||
      err instanceof AnalyticsSettingsStaleVersionError ||
      err instanceof AnalyticsSettingsStorageError
    ) {
      throw err;
    }
    throw new AnalyticsSettingsStorageError();
  }
}

export * from "./gtm.ts";
export * from "./migrations.ts";
