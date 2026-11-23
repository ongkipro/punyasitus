import {
  createDefaultGtmKillSwitchState,
  createDefaultVendorDeliveryModes,
  createEmptyStoredAnalyticsSettings,
  GTM_RISK_ACK_VERSION,
  isValidGtmContainerId,
  isValidGtmKillSwitchReasonCategory,
  parseStoredAnalyticsSettings,
  validateGtmSettingsInput,
  validateVendorMutualExclusion,
  type GtmKillSwitchReasonCategory,
  type GtmOperatorKillSwitchState,
  type GtmRiskAcknowledgementRecord,
  type StoredAnalyticsSettings,
  type VendorDeliveryModes,
} from "@punyasitus/core/analytics/gtm";
import type { AnalyticsValidationField, DirectAnalyticsConfig } from "@punyasitus/core/analytics/providers";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "../connections/index.ts";
import {
  buildPlatformAuditStatement,
  PlatformAuditError,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "../platform/audit.ts";
import { evictTenantFromCache } from "../routing/resolver.ts";

/**
 * Per-Tenant Google Tag Manager (GTM) Persistence & Control-Plane Operator Kill Switch
 * (`packages/db/src/analytics-settings/gtm.ts`; TASK-076, REQ-027, DEC-027, PLAN §18.1).
 *
 * Security & atomicity invariants:
 * - ZERO runtime DDL. Expects `0001_initial_tenant.sql` on `TenantStore`
 *   and `0020_gtm_kill_switch.sql` on `PLATFORM_DB`.
 * - Enforces owner-only GTM activation with audited, versioned risk acknowledgement
 *   stored in BOTH `site_settings.analytics_risk_ack_at` and `analytics_config_json.gtmRiskAck`
 *   plus atomic `tenant_activity_log` (`WHERE changes() = 1`).
 * - Enforces strict anti-double-count mutual exclusion (`422 VENDOR_DUAL_MODE_CONFLICT`).
 * - Operator kill switch commits inside ONE atomic `PLATFORM_DB.batch([...])` gated on
 *   optimistic `tenants.version`, `platform_audit` (`WHERE changes() = 1`), `tenant_gtm_policies`,
 *   and `job_ledger` idempotency, then updates `TenantStore.site_settings` while preserving
 *   all direct GA4 / Meta / TikTok IDs untouched.
 */

const SINGLETON_ID = 1 as const;
const DEFAULT_SITE_TITLE = "Situs Bisnis";
const SAFE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export interface TenantFullAnalyticsSettingsDto {
  readonly ga4MeasurementId: string | null;
  readonly metaPixelId: string | null;
  readonly tiktokPixelId: string | null;
  readonly vendorModes: VendorDeliveryModes;
  readonly gtmContainerId: string | null;
  readonly gtmEnabled: boolean;
  readonly gtmRiskAck: GtmRiskAcknowledgementRecord | null;
  readonly operatorKillSwitch: GtmOperatorKillSwitchState;
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface UpdateTenantGtmSettingsInput {
  readonly tenantId: string;
  readonly patch: unknown;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly nowMs?: number;
}

export interface ConsoleTenantGtmStatusDto {
  readonly tenantId: string;
  readonly tenantVersion: number;
  readonly handle: string;
  readonly tenantName: string;
  readonly containerId: string | null;
  readonly gtmEnabled: boolean;
  readonly vendorModes: VendorDeliveryModes;
  readonly riskAck: GtmRiskAcknowledgementRecord | null;
  readonly directProvidersConfigured: {
    readonly ga4: boolean;
    readonly meta: boolean;
    readonly tiktok: boolean;
  };
  readonly killSwitch: GtmOperatorKillSwitchState;
  readonly tenantStoreReadable: boolean;
}

export type ConsoleGtmKillSwitchAction = "disable" | "lift";

export interface ConsoleTenantGtmKillSwitchInput {
  readonly actorUserId: string;
  readonly actorRole?: string;
  readonly tenantId?: string;
  readonly handle?: string;
  readonly action: ConsoleGtmKillSwitchAction;
  readonly reasonCategory?: GtmKillSwitchReasonCategory;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly requestId?: string | null;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly nowMs?: number;
}

export interface ConsoleTenantGtmKillSwitchResult {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly version: number;
  readonly action: ConsoleGtmKillSwitchAction;
  readonly containerId: string | null;
  readonly killSwitch: GtmOperatorKillSwitchState;
  readonly ownerEmail: string | null;
  readonly ownerName: string | null;
  readonly replayed: boolean;
  readonly tenantMirrorSynced: boolean;
  readonly audit: PlatformAuditRecord | null;
}

export type GtmDomainErrorCode =
  | "VALIDATION_ERROR"
  | "VENDOR_DUAL_MODE_CONFLICT"
  | "GTM_CONTAINER_ID_REQUIRED"
  | "GTM_RISK_ACK_REQUIRED"
  | "OWNER_ONLY_GTM_ACTIVATION"
  | "GTM_DISABLED_BY_OPERATOR"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "IDEMPOTENCY_CONFLICT"
  | "GTM_ALREADY_DISABLED"
  | "GTM_NOT_DISABLED"
  | "AUDIT_PERSISTENCE_FAILED"
  | "STORAGE_UNAVAILABLE";

export class GtmSettingsDomainError extends Error {
  readonly status: 403 | 404 | 409 | 422 | 500 | 503;
  readonly code: GtmDomainErrorCode;
  readonly fields?: readonly AnalyticsValidationField[];

  constructor(
    status: 403 | 404 | 409 | 422 | 500 | 503,
    code: GtmDomainErrorCode,
    message: string,
    fields?: readonly AnalyticsValidationField[],
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "GtmSettingsDomainError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

interface RawSiteSettingsRow {
  readonly analytics_config_json: string | null;
  readonly analytics_risk_ack_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface RawTenantGtmPolicyRow {
  readonly tenant_id: string;
  readonly gtm_disabled: number;
  readonly reason_category: string | null;
  readonly reason: string | null;
  readonly disabled_by: string | null;
  readonly disabled_at: number | null;
  readonly lifted_by: string | null;
  readonly lifted_at: number | null;
  readonly lift_reason: string | null;
  readonly last_container_id: string | null;
  readonly version: number;
  readonly updated_at: number;
}

interface RawTenantControlRow {
  readonly id: string;
  readonly organization_id: string;
  readonly handle: string;
  readonly name: string;
  readonly version: number;
  readonly owner_email: string | null;
  readonly owner_name: string | null;
}

interface RawJobLedgerRow {
  readonly idempotency_key: string;
  readonly tenant_id: string | null;
  readonly status: string;
  readonly payload_json: string | null;
}

function safeJsonParseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Treat malformed JSON safely as empty object
  }
  return {};
}

function toIsoOrNull(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function isMissingPolicyTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes("no such table") && msg.toLowerCase().includes("tenant_gtm_policies");
}

function mapPolicyRow(row: RawTenantGtmPolicyRow | null | undefined): GtmOperatorKillSwitchState {
  if (!row) return createDefaultGtmKillSwitchState();
  const disabled = row.gtm_disabled === 1;
  return {
    disabled,
    reasonCategory:
      disabled && isValidGtmKillSwitchReasonCategory(row.reason_category)
        ? row.reason_category
        : null,
    reason: disabled ? (row.reason ?? null) : null,
    disabledAt: disabled ? toIsoOrNull(row.disabled_at) : null,
    disabledBy: disabled ? (row.disabled_by ?? null) : null,
    liftedAt: !disabled ? toIsoOrNull(row.lifted_at) : null,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

async function readSiteSettingsAnalyticsRow(
  tenantDb: D1Database,
): Promise<RawSiteSettingsRow | null> {
  return tenantDb
    .prepare(
      `SELECT analytics_config_json, analytics_risk_ack_at, version, updated_at
       FROM site_settings
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(SINGLETON_ID)
    .first<RawSiteSettingsRow>();
}

/**
 * Reads the authoritative operator GTM kill switch status from `PLATFORM_DB.tenant_gtm_policies`.
 * Gracefully treats an unmigrated table (in legacy test fixtures) as non-disabled on read.
 */
export async function getTenantGtmKillSwitchStatus(
  platformDb: D1Database | null | undefined,
  tenantId: string,
): Promise<GtmOperatorKillSwitchState> {
  if (!platformDb || !tenantId.trim()) {
    return createDefaultGtmKillSwitchState();
  }
  try {
    const row = await platformDb
      .prepare(
        `SELECT tenant_id, gtm_disabled, reason_category, reason, disabled_by, disabled_at,
                lifted_by, lifted_at, lift_reason, last_container_id, version, updated_at
         FROM tenant_gtm_policies
         WHERE tenant_id = ?
         LIMIT 1`,
      )
      .bind(tenantId.trim())
      .first<RawTenantGtmPolicyRow>();
    return mapPolicyRow(row);
  } catch (err) {
    if (isMissingPolicyTableError(err)) {
      return createDefaultGtmKillSwitchState();
    }
    throw err;
  }
}

/**
 * Reads the tenant's combined direct + GTM analytics settings from `TenantStore`,
 * merged with authoritative `PLATFORM_DB` operator kill switch state.
 */
export async function getTenantFullAnalyticsSettings(
  tenantDb: D1Database,
  platformDb?: D1Database | null,
  tenantId?: string | null,
): Promise<TenantFullAnalyticsSettingsDto> {
  try {
    const [row, platformKillSwitch] = await Promise.all([
      readSiteSettingsAnalyticsRow(tenantDb),
      platformDb && tenantId
        ? getTenantGtmKillSwitchStatus(platformDb, tenantId)
        : Promise.resolve(createDefaultGtmKillSwitchState()),
    ]);

    if (!row) {
      const empty = createEmptyStoredAnalyticsSettings();
      return {
        ga4MeasurementId: empty.ga4MeasurementId,
        metaPixelId: empty.metaPixelId,
        tiktokPixelId: empty.tiktokPixelId,
        vendorModes: empty.vendorModes,
        gtmContainerId: empty.gtmContainerId,
        gtmEnabled: false,
        gtmRiskAck: null,
        operatorKillSwitch: platformKillSwitch,
        version: 0,
        updatedAt: null,
      };
    }

    const parsed = parseStoredAnalyticsSettings(safeJsonParseObject(row.analytics_config_json));
    const killSwitch: GtmOperatorKillSwitchState = platformKillSwitch.disabled
      ? platformKillSwitch
      : parsed.gtmOperatorDisabled
        ? {
            disabled: true,
            reasonCategory: parsed.gtmOperatorDisabledReasonCategory,
            reason: parsed.gtmOperatorDisabledReason,
            disabledAt: parsed.gtmOperatorDisabledAt,
            disabledBy: null,
            liftedAt: null,
          }
        : platformKillSwitch;

    return {
      ga4MeasurementId: parsed.ga4MeasurementId,
      metaPixelId: parsed.metaPixelId,
      tiktokPixelId: parsed.tiktokPixelId,
      vendorModes: parsed.vendorModes,
      gtmContainerId: parsed.gtmContainerId,
      gtmEnabled: !killSwitch.disabled && parsed.gtmEnabled,
      gtmRiskAck: parsed.gtmRiskAck,
      operatorKillSwitch: killSwitch,
      version: Number(row.version),
      updatedAt: toIsoOrNull(Number(row.updated_at)),
    };
  } catch (err) {
    if (err instanceof GtmSettingsDomainError) throw err;
    throw new GtmSettingsDomainError(
      503,
      "STORAGE_UNAVAILABLE",
      "Gagal memuat pengaturan analitik & Google Tag Manager tenant.",
      undefined,
      err,
    );
  }
}

/**
 * Validates and atomically updates tenant GTM & per-vendor routing settings in `TenantStore`.
 *
 * Enforces:
 * - Strict GTM container ID validation (`^GTM-[A-Z0-9]{6,12}$`), zero script/HTML injection
 * - Anti-double-count mutual exclusion (`422 VENDOR_DUAL_MODE_CONFLICT`)
 * - RBAC: `editor` denied (`403 FORBIDDEN`); `admin` may save IDs/modes when GTM is off
 *   or turn GTM off, but ONLY `owner` may switch GTM on or swap an active container
 *   (`403 OWNER_ONLY_GTM_ACTIVATION`)
 * - Audited, versioned risk acknowledgement (`422 GTM_RISK_ACK_REQUIRED`)
 * - Authoritative operator kill switch enforcement (`403 GTM_DISABLED_BY_OPERATOR`)
 * - Atomic OCC (`expectedVersion`, `409 STALE_VERSION`) + `tenant_activity_log` (`WHERE changes() = 1`)
 */
export async function updateTenantGtmSettings(
  tenantDb: D1Database,
  platformDb: D1Database | null | undefined,
  input: UpdateTenantGtmSettingsInput,
): Promise<TenantFullAnalyticsSettingsDto> {
  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion > 2_147_483_647
  ) {
    throw new GtmSettingsDomainError(
      422,
      "VALIDATION_ERROR",
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

  const actorRole = input.actorRole.trim().toLowerCase();
  if (actorRole !== "owner" && actorRole !== "admin") {
    throw new GtmSettingsDomainError(
      403,
      "FORBIDDEN",
      "Peran Anda tidak diizinkan mengubah pengaturan analitik atau Google Tag Manager.",
    );
  }

  const validation = validateGtmSettingsInput(input.patch);
  if (!validation.ok) {
    throw new GtmSettingsDomainError(422, "VALIDATION_ERROR", validation.message, validation.fields);
  }

  const patch = validation.patch;
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const nowIso = new Date(nowMs).toISOString();

  const killSwitch = await getTenantGtmKillSwitchStatus(platformDb, input.tenantId);
  const currentRow = await readSiteSettingsAnalyticsRow(tenantDb);

  const currentVersion = currentRow ? Number(currentRow.version) : 0;
  if (currentVersion !== input.expectedVersion) {
    throw new GtmSettingsDomainError(
      409,
      "STALE_VERSION",
      `Konflik versi pengaturan analitik: versi Anda (${input.expectedVersion}) sudah tertinggal dari versi terbaru (${currentVersion}). Muat ulang halaman sebelum menyimpan kembali.`,
    );
  }

  const existingRawObj = currentRow ? safeJsonParseObject(currentRow.analytics_config_json) : {};
  const existingParsed: StoredAnalyticsSettings = currentRow
    ? parseStoredAnalyticsSettings(existingRawObj)
    : createEmptyStoredAnalyticsSettings();

  const nextDirect: DirectAnalyticsConfig = {
    ga4MeasurementId:
      patch.ga4MeasurementId !== undefined
        ? patch.ga4MeasurementId
        : existingParsed.ga4MeasurementId,
    metaPixelId:
      patch.metaPixelId !== undefined ? patch.metaPixelId : existingParsed.metaPixelId,
    tiktokPixelId:
      patch.tiktokPixelId !== undefined ? patch.tiktokPixelId : existingParsed.tiktokPixelId,
  };

  const nextVendorModes: VendorDeliveryModes = {
    ga4: patch.vendorModes?.ga4 ?? existingParsed.vendorModes.ga4,
    meta: patch.vendorModes?.meta ?? existingParsed.vendorModes.meta,
    tiktok: patch.vendorModes?.tiktok ?? existingParsed.vendorModes.tiktok,
  };

  // Anti-double-count mutual exclusion check
  const dualConflicts = validateVendorMutualExclusion(nextDirect, nextVendorModes);
  if (dualConflicts.length > 0) {
    throw new GtmSettingsDomainError(
      422,
      "VENDOR_DUAL_MODE_CONFLICT",
      dualConflicts[0]?.message ??
        "Vendor tidak boleh aktif di mode Langsung dan Melalui GTM sekaligus.",
      dualConflicts,
    );
  }

  const nextContainerId =
    patch.gtmContainerId !== undefined ? patch.gtmContainerId : existingParsed.gtmContainerId;

  const wasGtmEnabled = existingParsed.gtmEnabled && !killSwitch.disabled;
  let nextGtmEnabled =
    patch.gtmEnabled !== undefined ? patch.gtmEnabled : wasGtmEnabled;

  // Clearing container ID automatically turns GTM off unless caller explicitly demanded gtmEnabled: true
  if (nextContainerId === null && patch.gtmEnabled === undefined) {
    nextGtmEnabled = false;
  }

  const isEnablingGtm = !wasGtmEnabled && nextGtmEnabled;
  const isSwappingActiveContainer =
    wasGtmEnabled &&
    nextGtmEnabled &&
    nextContainerId !== existingParsed.gtmContainerId;

  // Owner-only activation / active container swap enforcement
  if (actorRole !== "owner") {
    if (isEnablingGtm || isSwappingActiveContainer || patch.riskAcknowledgement !== undefined) {
      throw new GtmSettingsDomainError(
        403,
        "OWNER_ONLY_GTM_ACTIVATION",
        "Hanya Pemilik Situs (Owner) yang dapat mengaktifkan Google Tag Manager atau mengubah kontainer GTM yang sedang aktif setelah menyetujui pernyataan risiko.",
      );
    }
  }

  // Operator kill switch blocks re-enabling GTM until operator lifts the block
  if (nextGtmEnabled && (killSwitch.disabled || existingParsed.gtmOperatorDisabled)) {
    throw new GtmSettingsDomainError(
      403,
      "GTM_DISABLED_BY_OPERATOR",
      "Google Tag Manager pada situs ini sedang dinonaktifkan oleh operator platform. Hubungi tim dukungan sebelum mengaktifkan kembali; pelacak langsung tetap berjalan normal.",
    );
  }

  // Enabling GTM requires a valid container ID
  if (nextGtmEnabled && !isValidGtmContainerId(nextContainerId)) {
    throw new GtmSettingsDomainError(
      422,
      "GTM_CONTAINER_ID_REQUIRED",
      "Masukkan ID kontainer Google Tag Manager yang valid (contoh: GTM-ABC1234) sebelum mengaktifkan GTM.",
      [
        {
          field: "gtmContainerId",
          code: "GTM_CONTAINER_ID_REQUIRED",
          message: "ID kontainer GTM wajib diisi sebelum GTM diaktifkan.",
        },
      ],
    );
  }

  // Owner audited risk acknowledgement required when enabling GTM (or swapping active container)
  let nextRiskAck: GtmRiskAcknowledgementRecord | null = existingParsed.gtmRiskAck;
  let nextRiskAckAtMs: number | null = currentRow?.analytics_risk_ack_at ?? null;

  if (isEnablingGtm || isSwappingActiveContainer) {
    if (
      !patch.riskAcknowledgement ||
      patch.riskAcknowledgement.accepted !== true ||
      patch.riskAcknowledgement.version !== GTM_RISK_ACK_VERSION
    ) {
      throw new GtmSettingsDomainError(
        422,
        "GTM_RISK_ACK_REQUIRED",
        "Pemilik situs wajib menyetujui pernyataan risiko keamanan & privasi Google Tag Manager (versi 1) sebelum mengaktifkan GTM.",
        [
          {
            field: "riskAcknowledgement",
            code: "GTM_RISK_ACK_REQUIRED",
            message: `Persetujuan risiko GTM versi ${GTM_RISK_ACK_VERSION} wajib disetujui oleh pemilik situs.`,
          },
        ],
      );
    }
    nextRiskAck = {
      accepted: true,
      version: GTM_RISK_ACK_VERSION,
      acceptedAt: nowIso,
      acceptedByUserId: input.actorUserId,
    };
    nextRiskAckAtMs = nowMs;
  }

  const mergedAnalytics: Record<string, unknown> = {
    ...existingRawObj,
    ga4MeasurementId: nextDirect.ga4MeasurementId,
    metaPixelId: nextDirect.metaPixelId,
    tiktokPixelId: nextDirect.tiktokPixelId,
    vendorModes: nextVendorModes,
    gtmContainerId: nextContainerId,
    gtmEnabled: nextGtmEnabled,
    gtmRiskAck: nextRiskAck,
    gtmOperatorDisabled: killSwitch.disabled,
    gtmOperatorDisabledReasonCategory: killSwitch.reasonCategory,
    gtmOperatorDisabledReason: killSwitch.reason,
    gtmOperatorDisabledAt: killSwitch.disabledAt,
  };

  const serialized = JSON.stringify(mergedAnalytics);
  const auditAction = isEnablingGtm
    ? "analytics.gtm_enabled"
    : wasGtmEnabled && !nextGtmEnabled
      ? "analytics.gtm_disabled"
      : "analytics.gtm_updated";

  const auditSummary = isEnablingGtm
    ? `Google Tag Manager diaktifkan (${nextContainerId}) dengan persetujuan risiko pemilik v${GTM_RISK_ACK_VERSION}`
    : wasGtmEnabled && !nextGtmEnabled
      ? "Google Tag Manager dinonaktifkan oleh pengelola situs"
      : `Konfigurasi Google Tag Manager & mode vendor diperbarui`;

  const auditMetadata = JSON.stringify({
    gtmEnabled: nextGtmEnabled,
    hasGtmContainerId: Boolean(nextContainerId),
    vendorModes: nextVendorModes,
    riskAckVersion: nextRiskAck?.version ?? null,
    riskAckAcceptedAt: nextRiskAck?.acceptedAt ?? null,
    directProviders: {
      ga4: Boolean(nextDirect.ga4MeasurementId),
      meta: Boolean(nextDirect.metaPixelId),
      tiktok: Boolean(nextDirect.tiktokPixelId),
    },
    version: currentVersion + 1,
  });

  try {
    if (!currentRow) {
      const batchResults = await tenantDb.batch<RawSiteSettingsRow>([
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO site_settings (
               id, site_title, analytics_config_json, analytics_risk_ack_at, version, updated_at
             )
             VALUES (?, ?, ?, ?, 1, ?)`,
          )
          .bind(SINGLETON_ID, DEFAULT_SITE_TITLE, serialized, nextRiskAckAtMs, nowMs),
        tenantDb
          .prepare(
            `INSERT INTO tenant_activity_log (
               actor_user_id, actor_role, action, resource_type, resource_id,
               summary, metadata_json, created_at
             )
             SELECT ?, ?, ?, 'site_settings', '1', ?, ?, ?
             WHERE changes() = 1`,
          )
          .bind(input.actorUserId, actorRole, auditAction, auditSummary, auditMetadata, nowMs),
      ]);

      const insertedChanges = Number(batchResults[0]?.meta?.changes ?? 0);
      if (insertedChanges !== 1) {
        const latest = await readSiteSettingsAnalyticsRow(tenantDb);
        throw new GtmSettingsDomainError(
          409,
          "STALE_VERSION",
          `Konflik versi pengaturan analitik (saat ini v${latest ? Number(latest.version) : 0}).`,
        );
      }

      if (platformDb && input.tenantId) {
        try {
          const cacheBumpRes = await platformDb
            .prepare(`UPDATE tenants SET cache_version = cache_version + 1, updated_at = ? WHERE id = ?`)
            .bind(nowMs, input.tenantId)
            .run();
          if (Number(cacheBumpRes.meta?.changes ?? 0) !== 1) {
            throw new Error("cache_version bump matched 0 tenant rows");
          }
          evictTenantFromCache(input.tenantId);
        } catch (cacheErr) {
          // Compensate/rollback the freshly inserted TenantStore row so cached HTML
          // can never keep stale direct+GTM vendor modes (anti-double-count invariant).
          try {
            await tenantDb.batch([
              tenantDb
                .prepare(`DELETE FROM site_settings WHERE id = ? AND version = 1`)
                .bind(SINGLETON_ID),
              tenantDb
                .prepare(
                  `INSERT INTO tenant_activity_log (
                     actor_user_id, actor_role, action, resource_type, resource_id,
                     summary, metadata_json, created_at
                   )
                   SELECT ?, ?, 'analytics.gtm_rollback', 'site_settings', '1', ?, ?, ?
                   WHERE changes() = 1`,
                )
                .bind(
                  input.actorUserId,
                  actorRole,
                  "Rollback otomatis pengaturan GTM karena penyegaran cache publik gagal",
                  JSON.stringify({ rolledBackVersion: 1, reason: "cache_version_bump_failed" }),
                  nowMs,
                ),
            ]);
          } catch {
            // Best-effort rollback before surfacing 503
          }
          throw new GtmSettingsDomainError(
            503,
            "STORAGE_UNAVAILABLE",
            "Gagal menyegarkan cache publik situs setelah menyimpan pengaturan analitik. Perubahan telah dibatalkan; silakan coba lagi.",
            undefined,
            cacheErr,
          );
        }
      }

      return {
        ...nextDirect,
        vendorModes: nextVendorModes,
        gtmContainerId: nextContainerId,
        gtmEnabled: nextGtmEnabled,
        gtmRiskAck: nextRiskAck,
        operatorKillSwitch: killSwitch,
        version: 1,
        updatedAt: nowIso,
      };
    }

    const batchResults = await tenantDb.batch<RawSiteSettingsRow>([
      tenantDb
        .prepare(
          `UPDATE site_settings
           SET analytics_config_json = ?,
               analytics_risk_ack_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?
           RETURNING analytics_config_json, analytics_risk_ack_at, version, updated_at`,
        )
        .bind(serialized, nextRiskAckAtMs, nowMs, SINGLETON_ID, input.expectedVersion),
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id,
             summary, metadata_json, created_at
           )
           SELECT ?, ?, ?, 'site_settings', '1', ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(input.actorUserId, actorRole, auditAction, auditSummary, auditMetadata, nowMs),
    ]);

    const updatedRow = batchResults[0]?.results?.[0] ?? null;
    if (!updatedRow) {
      const latest = await readSiteSettingsAnalyticsRow(tenantDb);
      throw new GtmSettingsDomainError(
        409,
        "STALE_VERSION",
        `Konflik versi pengaturan analitik: versi Anda (${input.expectedVersion}) tertinggal dari versi terbaru (${latest ? Number(latest.version) : 0}).`,
      );
    }

    if (platformDb && input.tenantId) {
      try {
        const cacheBumpRes = await platformDb
          .prepare(`UPDATE tenants SET cache_version = cache_version + 1, updated_at = ? WHERE id = ?`)
          .bind(nowMs, input.tenantId)
          .run();
        if (Number(cacheBumpRes.meta?.changes ?? 0) !== 1) {
          throw new Error("cache_version bump matched 0 tenant rows");
        }
        evictTenantFromCache(input.tenantId);
      } catch (cacheErr) {
        // Compensate/rollback the TenantStore update guarded on the newly written version
        // so cached public HTML can never keep stale direct+GTM vendor modes.
        try {
          await tenantDb.batch([
            tenantDb
              .prepare(
                `UPDATE site_settings
                 SET analytics_config_json = ?,
                     analytics_risk_ack_at = ?,
                     version = ?,
                     updated_at = ?
                 WHERE id = ? AND version = ?`,
              )
              .bind(
                currentRow.analytics_config_json,
                currentRow.analytics_risk_ack_at,
                Number(currentRow.version),
                Number(currentRow.updated_at),
                SINGLETON_ID,
                Number(updatedRow.version),
              ),
            tenantDb
              .prepare(
                `INSERT INTO tenant_activity_log (
                   actor_user_id, actor_role, action, resource_type, resource_id,
                   summary, metadata_json, created_at
                 )
                 SELECT ?, ?, 'analytics.gtm_rollback', 'site_settings', '1', ?, ?, ?
                 WHERE changes() = 1`,
              )
              .bind(
                input.actorUserId,
                actorRole,
                "Rollback otomatis pengaturan GTM karena penyegaran cache publik gagal",
                JSON.stringify({
                  restoredVersion: Number(currentRow.version),
                  abortedVersion: Number(updatedRow.version),
                  reason: "cache_version_bump_failed",
                }),
                nowMs,
              ),
          ]);
        } catch {
          // Best-effort rollback before surfacing 503
        }
        throw new GtmSettingsDomainError(
          503,
          "STORAGE_UNAVAILABLE",
          "Gagal menyegarkan cache publik situs setelah menyimpan pengaturan analitik. Perubahan telah dibatalkan; silakan coba lagi.",
          undefined,
          cacheErr,
        );
      }
    }

    const parsedUpdated = parseStoredAnalyticsSettings(
      safeJsonParseObject(updatedRow.analytics_config_json),
    );
    return {
      ga4MeasurementId: parsedUpdated.ga4MeasurementId,
      metaPixelId: parsedUpdated.metaPixelId,
      tiktokPixelId: parsedUpdated.tiktokPixelId,
      vendorModes: parsedUpdated.vendorModes,
      gtmContainerId: parsedUpdated.gtmContainerId,
      gtmEnabled: !killSwitch.disabled && parsedUpdated.gtmEnabled,
      gtmRiskAck: parsedUpdated.gtmRiskAck,
      operatorKillSwitch: killSwitch,
      version: Number(updatedRow.version),
      updatedAt: toIsoOrNull(Number(updatedRow.updated_at)),
    };
  } catch (err) {
    if (err instanceof GtmSettingsDomainError) throw err;
    throw new GtmSettingsDomainError(
      503,
      "STORAGE_UNAVAILABLE",
      "Gagal menyimpan pengaturan Google Tag Manager ke penyimpanan tenant.",
      undefined,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Superadmin Console — GTM Status Inspection & Audited Kill Switch
// ---------------------------------------------------------------------------

async function loadControlPlaneTenantWithOwner(
  platformDb: D1Database,
  selector: { readonly tenantId?: string; readonly handle?: string },
): Promise<RawTenantControlRow | null> {
  const byId = Boolean(selector.tenantId?.trim());
  const whereClause = byId ? "t.id = ?" : "t.handle = ?";
  const bindVal = byId ? selector.tenantId!.trim() : selector.handle!.trim().toLowerCase();

  return platformDb
    .prepare(
      `SELECT
         t.id AS id,
         t.organization_id AS organization_id,
         t.handle AS handle,
         t.name AS name,
         t.version AS version,
         (
           SELECT u.email
           FROM members m
           JOIN users u ON u.id = m.user_id
           WHERE m.organization_id = t.organization_id AND m.role = 'owner'
           ORDER BY m.created_at ASC
           LIMIT 1
         ) AS owner_email,
         (
           SELECT u.name
           FROM members m
           JOIN users u ON u.id = m.user_id
           WHERE m.organization_id = t.organization_id AND m.role = 'owner'
           ORDER BY m.created_at ASC
           LIMIT 1
         ) AS owner_name
       FROM tenants t
       WHERE ${whereClause}
       LIMIT 1`,
    )
    .bind(bindVal)
    .first<RawTenantControlRow>();
}

/**
 * Narrow read of tenant GTM control-plane policy + `site_settings.analytics_config_json` ONLY
 * (never touches tenant pages, posts, offerings, leads, or media).
 */
export async function getConsoleTenantGtmStatus(
  platformDb: D1Database,
  selector: { readonly tenantId?: string; readonly handle?: string },
  tenantStore?: TenantStoreNamespaceLike | null,
): Promise<ConsoleTenantGtmStatusDto | null> {
  const tenantRow = await loadControlPlaneTenantWithOwner(platformDb, selector);
  if (!tenantRow) return null;

  const killSwitch = await getTenantGtmKillSwitchStatus(platformDb, tenantRow.id);

  let stored: StoredAnalyticsSettings = createEmptyStoredAnalyticsSettings();
  let tenantStoreReadable = false;

  if (tenantStore) {
    try {
      const tenantDb = createTenantDb(openTenantStoreStub(tenantStore, tenantRow.id));
      const siteRow = await readSiteSettingsAnalyticsRow(tenantDb);
      tenantStoreReadable = true;
      if (siteRow) {
        stored = parseStoredAnalyticsSettings(safeJsonParseObject(siteRow.analytics_config_json));
      }
    } catch {
      tenantStoreReadable = false;
    }
  }

  let policyLastContainer: string | null = null;
  try {
    const pRow = await platformDb
      .prepare(`SELECT last_container_id FROM tenant_gtm_policies WHERE tenant_id = ? LIMIT 1`)
      .bind(tenantRow.id)
      .first<{ readonly last_container_id: string | null }>();
    policyLastContainer = pRow?.last_container_id ?? null;
  } catch {
    // ignore if table not migrated yet
  }

  const containerId = stored.gtmContainerId ?? policyLastContainer;

  return {
    tenantId: tenantRow.id,
    tenantVersion: Number(tenantRow.version),
    handle: tenantRow.handle,
    tenantName: tenantRow.name,
    containerId,
    gtmEnabled: !killSwitch.disabled && stored.gtmEnabled,
    vendorModes: stored.vendorModes ?? createDefaultVendorDeliveryModes(),
    riskAck: stored.gtmRiskAck,
    directProvidersConfigured: {
      ga4: Boolean(stored.ga4MeasurementId),
      meta: Boolean(stored.metaPixelId),
      tiktok: Boolean(stored.tiktokPixelId),
    },
    killSwitch,
    tenantStoreReadable,
  };
}

/**
 * Executes the audited Superadmin Console GTM kill switch (`disable` or `lift`).
 *
 * - Validates operator reason (10–500 chars, PII/secret scrubbed), reason category
 *   (`abuse` | `malware` | `performance` for `disable`), `expectedVersion`, and `idempotencyKey`.
 * - Persists `tenants.version/cache_version`, `platform_audit` (`WHERE changes() = 1`),
 *   `tenant_gtm_policies`, and `job_ledger` atomically inside ONE `PLATFORM_DB.batch([...])`.
 * - Disables GTM in `TenantStore.site_settings` while leaving ALL direct GA4/Meta/TikTok tags intact.
 */
export async function executeConsoleTenantGtmKillSwitch(
  platformDb: D1Database,
  input: ConsoleTenantGtmKillSwitchInput,
): Promise<ConsoleTenantGtmKillSwitchResult> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) {
    throw new GtmSettingsDomainError(422, "VALIDATION_ERROR", "actorUserId wajib diisi.");
  }

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new GtmSettingsDomainError(
      422,
      "VALIDATION_ERROR",
      "Field expectedVersion wajib berupa bilangan bulat positif.",
    );
  }

  const idempotencyKey = input.idempotencyKey.trim();
  if (!SAFE_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new GtmSettingsDomainError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key wajib 8–128 karakter alfanumerik aman.",
    );
  }

  if (input.action !== "disable" && input.action !== "lift") {
    throw new GtmSettingsDomainError(
      422,
      "VALIDATION_ERROR",
      'Field action hanya boleh bernilai "disable" atau "lift".',
    );
  }

  let reasonCategory: GtmKillSwitchReasonCategory | null = null;
  if (input.action === "disable") {
    if (!isValidGtmKillSwitchReasonCategory(input.reasonCategory)) {
      throw new GtmSettingsDomainError(
        422,
        "VALIDATION_ERROR",
        'Kategori alasan kill switch GTM wajib dipilih ("abuse", "malware", atau "performance").',
      );
    }
    reasonCategory = input.reasonCategory;
  }

  let cleanReason: string;
  try {
    cleanReason = validateOperatorReason(input.reason);
  } catch (err) {
    throw new GtmSettingsDomainError(
      422,
      "VALIDATION_ERROR",
      err instanceof Error ? err.message : "Alasan operasional wajib 10–500 karakter.",
      undefined,
      err,
    );
  }

  const tenantRow = await loadControlPlaneTenantWithOwner(platformDb, {
    tenantId: input.tenantId,
    handle: input.handle,
  });
  if (!tenantRow) {
    throw new GtmSettingsDomainError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const ledgerKey = `gtm-kill-switch:${idempotencyKey}`;
  const requestHash = await sha256Hex(
    JSON.stringify([
      tenantRow.id,
      input.action,
      reasonCategory,
      cleanReason,
      input.expectedVersion,
    ]),
  );

  // 1. Idempotency check BEFORE state/version checks
  const existingLedger = await platformDb
    .prepare(
      `SELECT idempotency_key, tenant_id, status, payload_json
       FROM job_ledger
       WHERE idempotency_key = ?
       LIMIT 1`,
    )
    .bind(ledgerKey)
    .first<RawJobLedgerRow>();

  if (existingLedger) {
    const storedPayload = safeJsonParseObject(existingLedger.payload_json);
    if (
      existingLedger.tenant_id !== tenantRow.id ||
      storedPayload.requestHash !== requestHash
    ) {
      throw new GtmSettingsDomainError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key ini sudah digunakan untuk operasi kill switch GTM yang berbeda.",
      );
    }
    const latestKillSwitch = await getTenantGtmKillSwitchStatus(platformDb, tenantRow.id);
    return {
      tenantId: tenantRow.id,
      handle: tenantRow.handle,
      tenantName: tenantRow.name,
      version: Number(tenantRow.version),
      action: input.action,
      containerId:
        typeof storedPayload.containerId === "string" ? storedPayload.containerId : null,
      killSwitch: latestKillSwitch,
      ownerEmail: tenantRow.owner_email,
      ownerName: tenantRow.owner_name,
      replayed: true,
      tenantMirrorSynced: true,
      audit: null,
    };
  }

  // 2. Optimistic concurrency check
  if (Number(tenantRow.version) !== input.expectedVersion) {
    throw new GtmSettingsDomainError(
      409,
      "STALE_VERSION",
      `Versi tenant berubah (diharapkan v${input.expectedVersion}, saat ini v${tenantRow.version}). Muat ulang halaman sebelum mencoba lagi.`,
    );
  }

  // 3. Check current kill switch state
  const currentKillSwitch = await getTenantGtmKillSwitchStatus(platformDb, tenantRow.id);
  if (input.action === "disable" && currentKillSwitch.disabled) {
    throw new GtmSettingsDomainError(
      409,
      "GTM_ALREADY_DISABLED",
      "Kill switch Google Tag Manager untuk tenant ini sudah dalam status aktif.",
    );
  }
  if (input.action === "lift" && !currentKillSwitch.disabled) {
    throw new GtmSettingsDomainError(
      409,
      "GTM_NOT_DISABLED",
      "Tenant ini tidak sedang berada dalam status kill switch GTM.",
    );
  }

  // 4. Inspect current container ID from TenantStore (narrow read of site_settings only)
  let containerId: string | null = null;
  let tenantDb: D1Database | null = null;
  if (input.tenantStore) {
    try {
      tenantDb = createTenantDb(openTenantStoreStub(input.tenantStore, tenantRow.id));
      const siteRow = await readSiteSettingsAnalyticsRow(tenantDb);
      if (siteRow) {
        const parsed = parseStoredAnalyticsSettings(
          safeJsonParseObject(siteRow.analytics_config_json),
        );
        containerId = parsed.gtmContainerId;
      }
    } catch {
      tenantDb = null;
    }
  }

  const auditAction =
    input.action === "disable"
      ? "console.tenant.gtm_kill_switch.disable"
      : "console.tenant.gtm_kill_switch.lift";

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: input.actorRole ?? "platform_superadmin",
      action: auditAction,
      targetType: "tenant",
      targetId: tenantRow.id,
      tenantId: tenantRow.id,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        action: input.action,
        reasonCategory,
        containerId,
        previousVersion: input.expectedVersion,
        nextVersion: input.expectedVersion + 1,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const ledgerPayload = JSON.stringify({
    tenantId: tenantRow.id,
    action: input.action,
    reasonCategory,
    containerId,
    requestHash,
  });

  // Every statement after UPDATE tenants is strictly gated on the version transition succeeding:
  // `platform_audit` uses `WHERE changes() = 1`, and BOTH `tenant_gtm_policies` and `job_ledger`
  // require `EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)` so a stale-version race leaves
  // `platform_audit`, `tenant_gtm_policies`, and `job_ledger` completely untouched (0 rows mutated).
  const policyUpsertStmt =
    input.action === "disable"
      ? platformDb
          .prepare(
            `INSERT INTO tenant_gtm_policies (
               tenant_id, gtm_disabled, reason_category, reason, disabled_by, disabled_at,
               lifted_by, lifted_at, lift_reason, last_container_id, version, updated_at
             )
             SELECT ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?, 1, ?
             WHERE EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)
             ON CONFLICT(tenant_id) DO UPDATE SET
               gtm_disabled = 1,
               reason_category = excluded.reason_category,
               reason = excluded.reason,
               disabled_by = excluded.disabled_by,
               disabled_at = excluded.disabled_at,
               lifted_by = NULL,
               lifted_at = NULL,
               lift_reason = NULL,
               last_container_id = COALESCE(excluded.last_container_id, tenant_gtm_policies.last_container_id),
               version = tenant_gtm_policies.version + 1,
               updated_at = excluded.updated_at`,
          )
          .bind(
            tenantRow.id,
            reasonCategory,
            cleanReason,
            actorUserId,
            nowMs,
            containerId,
            nowMs,
            auditEntry.id,
          )
      : platformDb
          .prepare(
            `INSERT INTO tenant_gtm_policies (
               tenant_id, gtm_disabled, reason_category, reason, disabled_by, disabled_at,
               lifted_by, lifted_at, lift_reason, last_container_id, version, updated_at
             )
             SELECT ?, 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 1, ?
             WHERE EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)
             ON CONFLICT(tenant_id) DO UPDATE SET
               gtm_disabled = 0,
               reason_category = NULL,
               reason = NULL,
               lifted_by = excluded.lifted_by,
               lifted_at = excluded.lifted_at,
               lift_reason = excluded.lift_reason,
               version = tenant_gtm_policies.version + 1,
               updated_at = excluded.updated_at`,
          )
          .bind(tenantRow.id, actorUserId, nowMs, cleanReason, containerId, nowMs, auditEntry.id);

  // 5. Single atomic PLATFORM_DB transaction:
  //    UPDATE tenants -> conditional platform_audit (WHERE changes() = 1)
  //    -> conditional policy upsert -> conditional job_ledger
  let batchResults: D1Result[];
  try {
    batchResults = await platformDb.batch([
      platformDb
        .prepare(
          `UPDATE tenants
           SET version = version + 1,
               cache_version = cache_version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(nowMs, tenantRow.id, input.expectedVersion),
      auditStmt,
      policyUpsertStmt,
      platformDb
        .prepare(
          `INSERT INTO job_ledger (
             idempotency_key, topic, tenant_id, status, attempts,
             payload_json, created_at, updated_at
           )
           SELECT ?, 'console.tenant.gtm_kill_switch', ?, 'completed', 1, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM platform_audit WHERE id = ?)`,
        )
        .bind(ledgerKey, tenantRow.id, ledgerPayload, nowMs, nowMs, auditEntry.id),
    ]);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new GtmSettingsDomainError(500, "AUDIT_PERSISTENCE_FAILED", err.message, undefined, err);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") && msg.includes("job_ledger")) {
      throw new GtmSettingsDomainError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key bentrok dengan permintaan lain yang sedang berjalan.",
        undefined,
        err,
      );
    }
    throw new GtmSettingsDomainError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyimpan status kill switch GTM dan catatan audit secara atomik.",
      undefined,
      err,
    );
  }

  const tenantUpdateChanges = Number(batchResults[0]?.meta?.changes ?? 0);
  const auditChanges = Number(batchResults[1]?.meta?.changes ?? 0);
  if (tenantUpdateChanges !== 1 || auditChanges !== 1) {
    throw new GtmSettingsDomainError(
      409,
      "STALE_VERSION",
      "Versi tenant berubah secara bersamaan. Muat ulang data lalu coba lagi.",
    );
  }

  evictTenantFromCache(tenantRow.id);

  // 6. Synchronize TenantStore site_settings with bounded OCC retry (preserving direct GA4/Meta/TikTok IDs intact!)
  let tenantMirrorSynced = false;
  if (input.tenantStore) {
    const MAX_MIRROR_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_MIRROR_ATTEMPTS; attempt += 1) {
      try {
        const mirrorDb =
          tenantDb ?? createTenantDb(openTenantStoreStub(input.tenantStore, tenantRow.id));
        tenantDb = mirrorDb;

        const siteRow = await readSiteSettingsAnalyticsRow(mirrorDb);
        if (!siteRow) {
          // No site_settings row exists yet; PLATFORM_DB policy enforces fail-closed suppression.
          tenantMirrorSynced = true;
          break;
        }

        const existingObj = safeJsonParseObject(siteRow.analytics_config_json);
        const nextObj: Record<string, unknown> = {
          ...existingObj,
          gtmEnabled: false,
          gtmOperatorDisabled: input.action === "disable",
          gtmOperatorDisabledReasonCategory: input.action === "disable" ? reasonCategory : null,
          gtmOperatorDisabledReason: input.action === "disable" ? cleanReason : null,
          gtmOperatorDisabledAt: input.action === "disable" ? nowIso : null,
        };
        const tenantAuditAction =
          input.action === "disable"
            ? "analytics.gtm_operator_disabled"
            : "analytics.gtm_operator_lifted";
        const tenantAuditSummary =
          input.action === "disable"
            ? `Google Tag Manager dinonaktifkan oleh operator platform (${reasonCategory})`
            : "Pembatasan kill switch GTM dicabut oleh operator platform (tetap nonaktif hingga diaktifkan pemilik)";

        const mirrorResults = await mirrorDb.batch([
          mirrorDb
            .prepare(
              `UPDATE site_settings
               SET analytics_config_json = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND version = ?`,
            )
            .bind(JSON.stringify(nextObj), nowMs, SINGLETON_ID, Number(siteRow.version)),
          mirrorDb
            .prepare(
              `INSERT INTO tenant_activity_log (
                 actor_user_id, actor_role, action, resource_type, resource_id,
                 summary, metadata_json, created_at
               )
               SELECT ?, 'platform_operator', ?, 'site_settings', '1', ?, ?, ?
               WHERE changes() = 1`,
            )
            .bind(
              actorUserId,
              tenantAuditAction,
              tenantAuditSummary,
              JSON.stringify({
                action: input.action,
                reasonCategory,
                auditId: auditEntry.id,
              }),
              nowMs,
            ),
        ]);

        if (Number(mirrorResults[0]?.meta?.changes ?? 0) === 1) {
          tenantMirrorSynced = true;
          break;
        }
        console.warn(
          JSON.stringify({
            event: "gtm_kill_switch_tenant_mirror_version_conflict",
            tenantId: tenantRow.id,
            action: input.action,
            attempt,
            maxAttempts: MAX_MIRROR_ATTEMPTS,
            expectedSiteSettingsVersion: Number(siteRow.version),
          }),
        );
      } catch (mirrorErr) {
        console.warn(
          JSON.stringify({
            event: "gtm_kill_switch_tenant_mirror_failed",
            tenantId: tenantRow.id,
            action: input.action,
            attempt,
            maxAttempts: MAX_MIRROR_ATTEMPTS,
            error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
          }),
        );
      }
    }
  }

  const nextKillSwitch: GtmOperatorKillSwitchState =
    input.action === "disable"
      ? {
          disabled: true,
          reasonCategory,
          reason: cleanReason,
          disabledAt: nowIso,
          disabledBy: actorUserId,
          liftedAt: null,
        }
      : {
          disabled: false,
          reasonCategory: null,
          reason: null,
          disabledAt: null,
          disabledBy: null,
          liftedAt: nowIso,
        };

  return {
    tenantId: tenantRow.id,
    handle: tenantRow.handle,
    tenantName: tenantRow.name,
    version: input.expectedVersion + 1,
    action: input.action,
    containerId,
    killSwitch: nextKillSwitch,
    ownerEmail: tenantRow.owner_email,
    ownerName: tenantRow.owner_name,
    replayed: false,
    tenantMirrorSynced,
    audit: auditEntry,
  };
}
