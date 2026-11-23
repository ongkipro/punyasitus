import { sanitizeClientEventId } from "./dedup.ts";
import {
  ANALYTICS_PROVIDER_DESCRIPTORS,
  DIRECT_ANALYTICS_PROVIDERS,
  isSafeTestScriptOverrideUrl,
  isValidProviderId,
  parseStoredDirectAnalyticsConfig,
  type DirectAnalyticsConfig,
  type DirectAnalyticsProvider,
  type AnalyticsValidationField,
} from "./providers.ts";
import { sanitizeSignalPagePath } from "./signals.ts";

/**
 * Easy Google Tag Manager (GTM) Domain Contract, Strict Validation, Consent Mode v2,
 * and Standard First-Party `ps_*` dataLayer Event Contract
 * (`packages/core/src/analytics/gtm.ts`; TASK-076, REQ-027, DEC-027, PLAN §18.1).
 *
 * Security & privacy invariants:
 * - Accepts ONLY one validated GTM container ID (`^GTM-[A-Z0-9]{6,12}$`); rejects raw HTML,
 *   `<script>` tags, JS snippets, and malformed identifiers.
 * - Enforces strict per-vendor mutual exclusion (`direct` vs `gtm`): a vendor (GA4, Meta, TikTok)
 *   can NEVER be active both directly and via GTM simultaneously.
 * - Switching GTM on requires an owner-only audited, versioned risk acknowledgement.
 * - Google Consent Mode v2 defaults are strictly `denied` before GTM loads and update from visitor consent.
 * - The four `ps_*` dataLayer events (`ps_page_view`, `ps_wa_click`, `ps_external_click`,
 *   `ps_lead_submitted`) NEVER carry personal data (name, email, phone, message, or raw query strings).
 */

export const GTM_CONTAINER_ID_RE = /^GTM-[A-Z0-9]{6,12}$/;
export const GTM_RISK_ACK_VERSION = 1 as const;
export const GTM_DATALAYER_CONTRACT_VERSION = 1 as const;

export const ANALYTICS_VENDOR_MODES = ["direct", "gtm"] as const;
export type AnalyticsVendorMode = (typeof ANALYTICS_VENDOR_MODES)[number];

export const GTM_KILL_SWITCH_REASON_CATEGORIES = [
  "abuse",
  "malware",
  "performance",
] as const;
export type GtmKillSwitchReasonCategory = (typeof GTM_KILL_SWITCH_REASON_CATEGORIES)[number];

export const GTM_KILL_SWITCH_CATEGORY_LABELS_ID: Readonly<
  Record<GtmKillSwitchReasonCategory, string>
> = {
  abuse: "Penyalahgunaan (Abuse)",
  malware: "Malware / Skrip Berbahaya",
  performance: "Gangguan Performa Situs",
};

export interface VendorDeliveryModes {
  readonly ga4: AnalyticsVendorMode;
  readonly meta: AnalyticsVendorMode;
  readonly tiktok: AnalyticsVendorMode;
}

export interface GtmRiskAcknowledgementRecord {
  readonly accepted: boolean;
  readonly version: number;
  readonly acceptedAt: string;
  readonly acceptedByUserId: string | null;
}

export interface GtmRiskAcknowledgementInput {
  readonly accepted: boolean;
  readonly version: number;
}

export interface GtmOperatorKillSwitchState {
  readonly disabled: boolean;
  readonly reasonCategory: GtmKillSwitchReasonCategory | null;
  readonly reason: string | null;
  readonly disabledAt: string | null;
  readonly disabledBy: string | null;
  readonly liftedAt: string | null;
}

export interface StoredAnalyticsSettings extends DirectAnalyticsConfig {
  readonly vendorModes: VendorDeliveryModes;
  readonly gtmContainerId: string | null;
  readonly gtmEnabled: boolean;
  readonly gtmRiskAck: GtmRiskAcknowledgementRecord | null;
  readonly gtmOperatorDisabled: boolean;
  readonly gtmOperatorDisabledReasonCategory: GtmKillSwitchReasonCategory | null;
  readonly gtmOperatorDisabledReason: string | null;
  readonly gtmOperatorDisabledAt: string | null;
}

export interface EffectivePublicAnalyticsConfig {
  readonly directProviders: DirectAnalyticsConfig;
  readonly vendorModes: VendorDeliveryModes;
  readonly gtm: {
    readonly enabled: boolean;
    readonly containerId: string | null;
    readonly operatorDisabled: boolean;
  };
}

export const GTM_RISK_ACK_STATEMENTS_ID: readonly {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}[] = [
  {
    id: "arbitrary_code_execution",
    title: "Eksekusi kode di seluruh halaman publik",
    description:
      "Siapa pun yang memiliki izin menerbitkan (Publish) pada kontainer Google Tag Manager ini dapat menjalankan kode JavaScript apa pun pada halaman publik situs Anda kapan saja.",
  },
  {
    id: "form_input_visibility",
    title: "Akses terhadap isian pengunjung di halaman publik",
    description:
      "Tag yang Anda pasang di dalam GTM berpotensi membaca interaksi dan teks yang diketik pengunjung pada formulir halaman publik, menambah vendor pihak ketiga, serta mengubah perilaku halaman.",
  },
  {
    id: "tenant_privacy_responsibility",
    title: "Tanggung jawab privasi & kepatuhan tag milik pemilik situs",
    description:
      "Jaminan platform PunyaSitus hanya mencakup konfigurasi bawaan dan dataLayer ps_* bebas PII. Kewajiban persetujuan, privasi (UU PDP), dan kepatuhan tag tambahan di dalam GTM adalah tanggung jawab pemilik situs.",
  },
  {
    id: "performance_and_kill_switch",
    title: "Dampak kecepatan & tombol darurat operasional",
    description:
      "Setiap tag tambahan di dalam GTM dapat memperlambat waktu muat halaman publik. Operator PunyaSitus berhak menonaktifkan GTM secara sepihak dengan catatan audit bila ditemukan penyalahgunaan, malware, atau gangguan performa serius.",
  },
] as const;

const SCRIPT_OR_JS_INJECTION_RE =
  /(<\s*\/?\s*script\b|<\s*\/?\s*[a-z]+[^>]*>|javascript:|data:|vbscript:|on[a-z]+\s*=|[;{}()`]|\r|\n|\0)/i;

const EMAIL_PII_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PII_RE = /(?:\+?\d[\d\s().-]{7,18}\d)/;

export function createDefaultVendorDeliveryModes(): VendorDeliveryModes {
  return {
    ga4: "direct",
    meta: "direct",
    tiktok: "direct",
  };
}

export function createDefaultGtmKillSwitchState(): GtmOperatorKillSwitchState {
  return {
    disabled: false,
    reasonCategory: null,
    reason: null,
    disabledAt: null,
    disabledBy: null,
    liftedAt: null,
  };
}

export function createEmptyStoredAnalyticsSettings(): StoredAnalyticsSettings {
  return {
    ga4MeasurementId: null,
    metaPixelId: null,
    tiktokPixelId: null,
    vendorModes: createDefaultVendorDeliveryModes(),
    gtmContainerId: null,
    gtmEnabled: false,
    gtmRiskAck: null,
    gtmOperatorDisabled: false,
    gtmOperatorDisabledReasonCategory: null,
    gtmOperatorDisabledReason: null,
    gtmOperatorDisabledAt: null,
  };
}

export function isValidGtmContainerId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (SCRIPT_OR_JS_INJECTION_RE.test(value)) return false;
  return GTM_CONTAINER_ID_RE.test(value);
}

export function isValidVendorMode(value: unknown): value is AnalyticsVendorMode {
  return value === "direct" || value === "gtm";
}

export function isValidGtmKillSwitchReasonCategory(
  value: unknown,
): value is GtmKillSwitchReasonCategory {
  return value === "abuse" || value === "malware" || value === "performance";
}

function parseVendorDeliveryModes(raw: unknown): VendorDeliveryModes {
  const defaults = createDefaultVendorDeliveryModes();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }
  const obj = raw as Record<string, unknown>;
  return {
    ga4: isValidVendorMode(obj.ga4) ? obj.ga4 : "direct",
    meta: isValidVendorMode(obj.meta) ? obj.meta : "direct",
    tiktok: isValidVendorMode(obj.tiktok) ? obj.tiktok : "direct",
  };
}

function parseStoredRiskAck(raw: unknown): GtmRiskAcknowledgementRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (
    obj.accepted === true &&
    typeof obj.version === "number" &&
    Number.isInteger(obj.version) &&
    obj.version >= 1 &&
    typeof obj.acceptedAt === "string" &&
    obj.acceptedAt.trim().length > 0
  ) {
    return {
      accepted: true,
      version: obj.version,
      acceptedAt: obj.acceptedAt.trim(),
      acceptedByUserId:
        typeof obj.acceptedByUserId === "string" && obj.acceptedByUserId.trim().length > 0
          ? obj.acceptedByUserId.trim()
          : null,
    };
  }
  return null;
}

/**
 * Safely parses the full stored `site_settings.analytics_config_json` object,
 * preserving strict direct provider validation while extracting validated GTM settings.
 */
export function parseStoredAnalyticsSettings(raw: unknown): StoredAnalyticsSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptyStoredAnalyticsSettings();
  }
  const obj = raw as Record<string, unknown>;
  const direct = parseStoredDirectAnalyticsConfig(obj);
  const vendorModes = parseVendorDeliveryModes(obj.vendorModes);
  const gtmContainerId = isValidGtmContainerId(obj.gtmContainerId) ? obj.gtmContainerId : null;
  const gtmRiskAck = parseStoredRiskAck(obj.gtmRiskAck);
  const gtmOperatorDisabled = obj.gtmOperatorDisabled === true;
  const gtmOperatorDisabledReasonCategory = isValidGtmKillSwitchReasonCategory(
    obj.gtmOperatorDisabledReasonCategory,
  )
    ? obj.gtmOperatorDisabledReasonCategory
    : null;
  const gtmOperatorDisabledReason =
    typeof obj.gtmOperatorDisabledReason === "string" && obj.gtmOperatorDisabledReason.trim()
      ? obj.gtmOperatorDisabledReason.trim().slice(0, 500)
      : null;
  const gtmOperatorDisabledAt =
    typeof obj.gtmOperatorDisabledAt === "string" && obj.gtmOperatorDisabledAt.trim()
      ? obj.gtmOperatorDisabledAt.trim()
      : null;

  // Fail-closed: GTM can only be considered enabled when a valid container ID and owner risk ack exist
  // AND operator kill-switch is not active.
  const gtmEnabled =
    obj.gtmEnabled === true &&
    gtmContainerId !== null &&
    gtmRiskAck !== null &&
    gtmRiskAck.accepted === true &&
    !gtmOperatorDisabled;

  return {
    ...direct,
    vendorModes,
    gtmContainerId,
    gtmEnabled,
    gtmRiskAck,
    gtmOperatorDisabled,
    gtmOperatorDisabledReasonCategory,
    gtmOperatorDisabledReason,
    gtmOperatorDisabledAt,
  };
}

/**
 * Resolves the effective public runtime analytics config, strictly enforcing:
 * 1. Operator kill switch overrides GTM to disabled immediately while direct tags keep working.
 * 2. When GTM is active, ANY vendor routed `"gtm"` has its direct ID forced to `null`
 *    so no vendor can EVER run both directly and via GTM (zero double-count guarantee).
 */
export function resolveEffectivePublicAnalyticsConfig(
  stored: StoredAnalyticsSettings,
  operatorKillSwitchActive = false,
): EffectivePublicAnalyticsConfig {
  const killed = Boolean(operatorKillSwitchActive || stored.gtmOperatorDisabled);
  const gtmActive =
    !killed &&
    stored.gtmEnabled === true &&
    isValidGtmContainerId(stored.gtmContainerId) &&
    stored.gtmRiskAck?.accepted === true;

  const directProviders: DirectAnalyticsConfig = {
    ga4MeasurementId:
      gtmActive && stored.vendorModes.ga4 === "gtm" ? null : stored.ga4MeasurementId,
    metaPixelId: gtmActive && stored.vendorModes.meta === "gtm" ? null : stored.metaPixelId,
    tiktokPixelId: gtmActive && stored.vendorModes.tiktok === "gtm" ? null : stored.tiktokPixelId,
  };

  return {
    directProviders,
    vendorModes: stored.vendorModes,
    gtm: {
      enabled: gtmActive,
      containerId: gtmActive ? stored.gtmContainerId : null,
      operatorDisabled: killed,
    },
  };
}

export interface ValidatedGtmSettingsPatch {
  readonly gtmContainerId?: string | null;
  readonly gtmEnabled?: boolean;
  readonly vendorModes?: Partial<VendorDeliveryModes>;
  readonly ga4MeasurementId?: string | null;
  readonly metaPixelId?: string | null;
  readonly tiktokPixelId?: string | null;
  readonly riskAcknowledgement?: GtmRiskAcknowledgementInput;
}

export type GtmSettingsValidationResult =
  | {
      readonly ok: true;
      readonly patch: ValidatedGtmSettingsPatch;
    }
  | {
      readonly ok: false;
      readonly code: "VALIDATION_ERROR";
      readonly message: string;
      readonly fields: readonly AnalyticsValidationField[];
    };

const GTM_PATCH_ALLOWED_KEYS = new Set([
  "gtmContainerId",
  "gtmEnabled",
  "vendorModes",
  "ga4MeasurementId",
  "metaPixelId",
  "tiktokPixelId",
  "riskAcknowledgement",
]);

function validateDirectIdForGtmPatch(
  provider: DirectAnalyticsProvider,
  raw: unknown,
  fields: AnalyticsValidationField[],
): string | null {
  const descriptor = ANALYTICS_PROVIDER_DESCRIPTORS[provider];
  const field = descriptor.configKey;

  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    fields.push({
      field,
      code: "INVALID_TYPE",
      message: `${descriptor.label} ID harus berupa teks atau kosong.`,
    });
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (SCRIPT_OR_JS_INJECTION_RE.test(raw)) {
    fields.push({
      field,
      code: "FORBIDDEN_SCRIPT_SNIPPET",
      message: `${descriptor.label} hanya menerima ID pelacak valid; kode HTML atau JavaScript ditolak.`,
    });
    return null;
  }

  if (!isValidProviderId(provider, trimmed)) {
    fields.push({
      field,
      code: "INVALID_ANALYTICS_ID",
      message: `ID ${descriptor.label} tidak valid. ${descriptor.formatHintId}`,
    });
    return null;
  }

  return trimmed;
}

/**
 * Strictly validates a tenant GTM & per-vendor routing PATCH payload.
 * Rejects malformed container IDs, script/XSS injection, unknown fields,
 * invalid vendor modes, and invalid risk acknowledgement shapes.
 */
export function validateGtmSettingsInput(input: unknown): GtmSettingsValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Payload pengaturan GTM harus berupa objek JSON.",
      fields: [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected a JSON object." }],
    };
  }

  const record = input as Record<string, unknown>;
  const fields: AnalyticsValidationField[] = [];

  for (const key of Object.keys(record)) {
    if (!GTM_PATCH_ALLOWED_KEYS.has(key)) {
      fields.push({
        field: key,
        code: "UNKNOWN_FIELD",
        message: `Field "${key}" tidak diizinkan pada pengaturan GTM.`,
      });
    }
  }

  const patch: {
    gtmContainerId?: string | null;
    gtmEnabled?: boolean;
    vendorModes?: Partial<VendorDeliveryModes>;
    ga4MeasurementId?: string | null;
    metaPixelId?: string | null;
    tiktokPixelId?: string | null;
    riskAcknowledgement?: GtmRiskAcknowledgementInput;
  } = {};

  if (Object.prototype.hasOwnProperty.call(record, "gtmContainerId")) {
    const rawGtm = record.gtmContainerId;
    if (rawGtm === null) {
      patch.gtmContainerId = null;
    } else if (typeof rawGtm !== "string") {
      fields.push({
        field: "gtmContainerId",
        code: "INVALID_TYPE",
        message: "ID kontainer GTM harus berupa teks atau kosong.",
      });
    } else {
      const trimmed = rawGtm.trim();
      if (trimmed.length === 0) {
        patch.gtmContainerId = null;
      } else if (SCRIPT_OR_JS_INJECTION_RE.test(rawGtm)) {
        fields.push({
          field: "gtmContainerId",
          code: "FORBIDDEN_SCRIPT_SNIPPET",
          message:
            "ID kontainer GTM hanya menerima format GTM-XXXXXXX; tag <script>, HTML, atau kode JavaScript ditolak.",
        });
      } else if (!isValidGtmContainerId(trimmed)) {
        fields.push({
          field: "gtmContainerId",
          code: "INVALID_GTM_CONTAINER_ID",
          message:
            "Format ID kontainer GTM tidak valid. Gunakan GTM- diikuti 6–12 huruf kapital atau angka (contoh: GTM-ABC1234).",
        });
      } else {
        patch.gtmContainerId = trimmed;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(record, "gtmEnabled")) {
    if (typeof record.gtmEnabled !== "boolean") {
      fields.push({
        field: "gtmEnabled",
        code: "INVALID_TYPE",
        message: "Field gtmEnabled harus berupa boolean (true/false).",
      });
    } else {
      patch.gtmEnabled = record.gtmEnabled;
    }
  }

  if (Object.prototype.hasOwnProperty.call(record, "vendorModes")) {
    const rawModes = record.vendorModes;
    if (!rawModes || typeof rawModes !== "object" || Array.isArray(rawModes)) {
      fields.push({
        field: "vendorModes",
        code: "INVALID_TYPE",
        message: "Field vendorModes harus berupa objek berisi mode ga4, meta, dan/atau tiktok.",
      });
    } else {
      const modeRecord = rawModes as Record<string, unknown>;
      const parsedModes: {
        ga4?: AnalyticsVendorMode;
        meta?: AnalyticsVendorMode;
        tiktok?: AnalyticsVendorMode;
      } = {};
      for (const [k, v] of Object.entries(modeRecord)) {
        if (k !== "ga4" && k !== "meta" && k !== "tiktok") {
          fields.push({
            field: `vendorModes.${k}`,
            code: "UNKNOWN_FIELD",
            message: `Vendor "${k}" tidak dikenal. Gunakan ga4, meta, atau tiktok.`,
          });
          continue;
        }
        if (!isValidVendorMode(v)) {
          fields.push({
            field: `vendorModes.${k}`,
            code: "INVALID_VENDOR_MODE",
            message: `Mode untuk ${k} harus "direct" (Langsung) atau "gtm" (Melalui GTM).`,
          });
          continue;
        }
        parsedModes[k] = v;
      }
      patch.vendorModes = parsedModes;
    }
  }

  if (Object.prototype.hasOwnProperty.call(record, "ga4MeasurementId")) {
    patch.ga4MeasurementId = validateDirectIdForGtmPatch("ga4", record.ga4MeasurementId, fields);
  }
  if (Object.prototype.hasOwnProperty.call(record, "metaPixelId")) {
    patch.metaPixelId = validateDirectIdForGtmPatch("meta", record.metaPixelId, fields);
  }
  if (Object.prototype.hasOwnProperty.call(record, "tiktokPixelId")) {
    patch.tiktokPixelId = validateDirectIdForGtmPatch("tiktok", record.tiktokPixelId, fields);
  }

  if (Object.prototype.hasOwnProperty.call(record, "riskAcknowledgement")) {
    const rawAck = record.riskAcknowledgement;
    if (!rawAck || typeof rawAck !== "object" || Array.isArray(rawAck)) {
      fields.push({
        field: "riskAcknowledgement",
        code: "INVALID_RISK_ACK",
        message: "Persetujuan risiko GTM harus berupa objek { accepted: true, version: 1 }.",
      });
    } else {
      const ackObj = rawAck as Record<string, unknown>;
      for (const k of Object.keys(ackObj)) {
        if (k !== "accepted" && k !== "version") {
          fields.push({
            field: `riskAcknowledgement.${k}`,
            code: "UNKNOWN_FIELD",
            message: `Field "${k}" tidak diizinkan pada riskAcknowledgement.`,
          });
        }
      }
      if (typeof ackObj.accepted !== "boolean") {
        fields.push({
          field: "riskAcknowledgement.accepted",
          code: "INVALID_RISK_ACK",
          message: "Field riskAcknowledgement.accepted harus berupa boolean.",
        });
      }
      if (
        typeof ackObj.version !== "number" ||
        !Number.isInteger(ackObj.version) ||
        ackObj.version !== GTM_RISK_ACK_VERSION
      ) {
        fields.push({
          field: "riskAcknowledgement.version",
          code: "INVALID_RISK_ACK_VERSION",
          message: `Versi persetujuan risiko GTM wajib bernilai ${GTM_RISK_ACK_VERSION}.`,
        });
      }
      if (typeof ackObj.accepted === "boolean" && ackObj.version === GTM_RISK_ACK_VERSION) {
        patch.riskAcknowledgement = {
          accepted: ackObj.accepted,
          version: ackObj.version,
        };
      }
    }
  }

  if (fields.length > 0) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: fields[0]?.message ?? "Konfigurasi Google Tag Manager tidak valid.",
      fields,
    };
  }

  return { ok: true, patch };
}

/**
 * Checks the anti-double-count mutual exclusion invariant across merged vendor modes & direct IDs.
 * A vendor configured as `"gtm"` MUST NOT simultaneously carry an active direct ID.
 */
export function validateVendorMutualExclusion(
  direct: DirectAnalyticsConfig,
  vendorModes: VendorDeliveryModes,
): readonly AnalyticsValidationField[] {
  const conflicts: AnalyticsValidationField[] = [];
  for (const provider of DIRECT_ANALYTICS_PROVIDERS) {
    const desc = ANALYTICS_PROVIDER_DESCRIPTORS[provider];
    const directVal = direct[desc.configKey];
    if (vendorModes[provider] === "gtm" && directVal !== null) {
      conflicts.push({
        field: desc.configKey,
        code: "VENDOR_DUAL_MODE_CONFLICT",
        message: `${desc.label} tidak boleh aktif di mode Langsung dan Melalui GTM sekaligus untuk mencegah penghitungan ganda (double counting). Kosongkan ID langsung atau ubah mode ke Langsung.`,
      });
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Google Consent Mode v2 Contract (verified against Google Tag Platform v2)
// ---------------------------------------------------------------------------

export type GoogleConsentStatus = "granted" | "denied";

export interface GoogleConsentModeV2DefaultParams {
  readonly ad_storage: "denied";
  readonly ad_user_data: "denied";
  readonly ad_personalization: "denied";
  readonly analytics_storage: "denied";
  readonly functionality_storage: "denied";
  readonly personalization_storage: "denied";
  readonly security_storage: "granted";
  readonly wait_for_update: 500;
}

export interface GoogleConsentModeV2UpdateParams {
  readonly ad_storage: GoogleConsentStatus;
  readonly ad_user_data: GoogleConsentStatus;
  readonly ad_personalization: GoogleConsentStatus;
  readonly analytics_storage: GoogleConsentStatus;
  readonly functionality_storage: GoogleConsentStatus;
  readonly personalization_storage: GoogleConsentStatus;
  readonly security_storage: "granted";
}

export const GTM_CONSENT_MODE_V2_DEFAULT: GoogleConsentModeV2DefaultParams = Object.freeze({
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied",
  functionality_storage: "denied",
  personalization_storage: "denied",
  security_storage: "granted",
  wait_for_update: 500,
});

export function buildGoogleConsentModeUpdate(consent: {
  readonly analytics: boolean;
  readonly marketing: boolean;
  readonly hasDecision: boolean;
}): GoogleConsentModeV2UpdateParams {
  const analyticsGranted = consent.hasDecision && consent.analytics === true;
  const marketingGranted = consent.hasDecision && consent.marketing === true;
  return {
    ad_storage: marketingGranted ? "granted" : "denied",
    ad_user_data: marketingGranted ? "granted" : "denied",
    ad_personalization: marketingGranted ? "granted" : "denied",
    analytics_storage: analyticsGranted ? "granted" : "denied",
    functionality_storage: analyticsGranted ? "granted" : "denied",
    personalization_storage: marketingGranted ? "granted" : "denied",
    security_storage: "granted",
  };
}

// ---------------------------------------------------------------------------
// Standard First-Party `ps_*` dataLayer Event Contract (PLAN §18.1, version 1)
// ---------------------------------------------------------------------------

export const GTM_DATALAYER_EVENTS = [
  "ps_page_view",
  "ps_wa_click",
  "ps_external_click",
  "ps_lead_submitted",
] as const;

export type GtmDataLayerEventName = (typeof GTM_DATALAYER_EVENTS)[number];

export const GTM_PAGE_TYPES = [
  "home",
  "page",
  "post",
  "service",
  "product",
  "tour",
  "vehicle",
  "category",
  "tag",
  "archive",
  "other",
] as const;
export type GtmPageType = (typeof GTM_PAGE_TYPES)[number];

export const GTM_CTA_PLACEMENTS = [
  "hero",
  "header",
  "floating",
  "catalog_card",
  "detail",
  "section_cta",
  "contact",
  "footer",
  "other",
] as const;
export type GtmCtaPlacement = (typeof GTM_CTA_PLACEMENTS)[number];

const PAGE_TYPE_SET = new Set<string>(GTM_PAGE_TYPES);
const PLACEMENT_SET = new Set<string>(GTM_CTA_PLACEMENTS);
const SAFE_ID_RE = /^[a-zA-Z0-9._:/-]{1,64}$/;

export interface GtmDataLayerEventDoc {
  readonly event: GtmDataLayerEventName;
  readonly labelId: string;
  readonly fields: readonly string[];
  readonly triggerRuleId: string;
  readonly piiPolicyId: string;
}

export const GTM_DATALAYER_EVENT_DOCS: readonly GtmDataLayerEventDoc[] = [
  {
    event: "ps_page_view",
    labelId: "Kunjungan Halaman",
    fields: ["ps_schema_version", "event_id", "page_type", "content_id", "page_path"],
    triggerRuleId: "Dikirim otomatis saat halaman publik dimuat setelah izin Analitik aktif.",
    piiPolicyId: "Hanya jenis halaman, ID konten non-PII, dan path tanpa query string.",
  },
  {
    event: "ps_wa_click",
    labelId: "Klik CTA WhatsApp",
    fields: ["ps_schema_version", "event_id", "item_id", "item_title", "placement", "page_path"],
    triggerRuleId: "Dikirim non-blocking saat pengunjung mengklik tombol atau tautan WhatsApp.",
    piiPolicyId: "Tanpa nomor telepon pengunjung, tanpa isi pesan WhatsApp, dan tanpa query URL.",
  },
  {
    event: "ps_external_click",
    labelId: "Klik Tautan Eksternal",
    fields: ["ps_schema_version", "event_id", "item_id", "destination_host", "page_path"],
    triggerRuleId: "Dikirim non-blocking saat pengunjung mengklik tautan marketplace/eksternal.",
    piiPolicyId: "Hanya meneruskan nama host tujuan (destination_host), tidak pernah URL/query lengkap.",
  },
  {
    event: "ps_lead_submitted",
    labelId: "Formulir Prospek Tersimpan",
    fields: ["ps_schema_version", "event_id", "form_id", "page_path"],
    triggerRuleId: "Dikirim tepat SATU KALI setelah POST /api/leads mengonfirmasi penyimpanan tahan lama.",
    piiPolicyId: "Dilarang keras mengirim nama, email, nomor HP, atau isi pesan formulir ke dataLayer.",
  },
] as const;

export interface PsPageViewEventPayload {
  readonly event: "ps_page_view";
  readonly ps_schema_version: typeof GTM_DATALAYER_CONTRACT_VERSION;
  readonly event_id: string;
  readonly page_type: GtmPageType;
  readonly content_id: string | null;
  readonly page_path: string;
}

export interface PsWaClickEventPayload {
  readonly event: "ps_wa_click";
  readonly ps_schema_version: typeof GTM_DATALAYER_CONTRACT_VERSION;
  readonly event_id: string;
  readonly item_id: string | null;
  readonly item_title: string | null;
  readonly placement: GtmCtaPlacement;
  readonly page_path: string;
}

export interface PsExternalClickEventPayload {
  readonly event: "ps_external_click";
  readonly ps_schema_version: typeof GTM_DATALAYER_CONTRACT_VERSION;
  readonly event_id: string;
  readonly item_id: string | null;
  readonly destination_host: string | null;
  readonly page_path: string;
}

export interface PsLeadSubmittedEventPayload {
  readonly event: "ps_lead_submitted";
  readonly ps_schema_version: typeof GTM_DATALAYER_CONTRACT_VERSION;
  readonly event_id: string;
  readonly form_id: string;
  readonly page_path: string;
}

export type PsDataLayerEventPayload =
  | PsPageViewEventPayload
  | PsWaClickEventPayload
  | PsExternalClickEventPayload
  | PsLeadSubmittedEventPayload;

function stripControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      out += value[i];
    }
  }
  return out;
}

function containsPii(value: string): boolean {
  return EMAIL_PII_RE.test(value) || PHONE_PII_RE.test(value);
}

function sanitizeSafeIdentifier(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const trimmed = stripControlChars(String(raw)).trim();
  if (!trimmed || !SAFE_ID_RE.test(trimmed) || containsPii(trimmed)) {
    return null;
  }
  return trimmed;
}

function sanitizeNonPiiTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = stripControlChars(raw).replace(/\s+/g, " ").trim();
  if (!trimmed || containsPii(trimmed)) return null;
  // Drop query strings if someone passed a URL-like title
  if (trimmed.includes("?") && /^https?:\/\//i.test(trimmed)) return null;
  return trimmed.slice(0, 128);
}

/**
 * Extracts ONLY the lowercase destination hostname from an external URL.
 * Rejects `javascript:`, `data:`, `vbscript:`, paths, query strings, credentials, and PII.
 */
export function sanitizeDestinationHost(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = stripControlChars(rawUrl).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:")
  ) {
    return null;
  }

  let candidate = trimmed;
  if (!candidate.includes("://")) {
    // Allow plain host input like "tokopedia.com" only if clean hostname
    if (/^[a-z0-9.-]+$/i.test(candidate) && candidate.includes(".")) {
      candidate = `https://${candidate}`;
    } else {
      return null;
    }
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || host.length > 253 || containsPii(host)) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

export function normalizeGtmPageType(raw: unknown): GtmPageType {
  if (typeof raw === "string") {
    const clean = raw.trim().toLowerCase();
    if (PAGE_TYPE_SET.has(clean)) {
      return clean as GtmPageType;
    }
  }
  return "other";
}

export function normalizeGtmPlacement(raw: unknown): GtmCtaPlacement {
  if (typeof raw === "string") {
    const clean = raw.trim().toLowerCase();
    if (PLACEMENT_SET.has(clean)) {
      return clean as GtmCtaPlacement;
    }
  }
  return "other";
}

export function buildPsPageViewEvent(input: {
  readonly eventId: string;
  readonly pageType?: unknown;
  readonly contentId?: unknown;
  readonly pagePath?: unknown;
}): PsPageViewEventPayload {
  return {
    event: "ps_page_view",
    ps_schema_version: GTM_DATALAYER_CONTRACT_VERSION,
    event_id: sanitizeClientEventId(input.eventId) ?? "evt_page_view",
    page_type: normalizeGtmPageType(input.pageType),
    content_id: sanitizeSafeIdentifier(input.contentId),
    page_path: sanitizeSignalPagePath(input.pagePath) ?? "/",
  };
}

export function buildPsWaClickEvent(input: {
  readonly eventId: string;
  readonly itemId?: unknown;
  readonly itemTitle?: unknown;
  readonly placement?: unknown;
  readonly pagePath?: unknown;
}): PsWaClickEventPayload {
  return {
    event: "ps_wa_click",
    ps_schema_version: GTM_DATALAYER_CONTRACT_VERSION,
    event_id: sanitizeClientEventId(input.eventId) ?? "evt_wa_click",
    item_id: sanitizeSafeIdentifier(input.itemId),
    item_title: sanitizeNonPiiTitle(input.itemTitle),
    placement: normalizeGtmPlacement(input.placement),
    page_path: sanitizeSignalPagePath(input.pagePath) ?? "/",
  };
}

export function buildPsExternalClickEvent(input: {
  readonly eventId: string;
  readonly itemId?: unknown;
  readonly destinationUrl?: unknown;
  readonly destinationHost?: unknown;
  readonly pagePath?: unknown;
}): PsExternalClickEventPayload {
  const host =
    sanitizeDestinationHost(input.destinationHost) ?? sanitizeDestinationHost(input.destinationUrl);
  return {
    event: "ps_external_click",
    ps_schema_version: GTM_DATALAYER_CONTRACT_VERSION,
    event_id: sanitizeClientEventId(input.eventId) ?? "evt_external_click",
    item_id: sanitizeSafeIdentifier(input.itemId),
    destination_host: host,
    page_path: sanitizeSignalPagePath(input.pagePath) ?? "/",
  };
}

export function buildPsLeadSubmittedEvent(input: {
  readonly eventId: string;
  readonly formId?: unknown;
  readonly pagePath?: unknown;
}): PsLeadSubmittedEventPayload {
  return {
    event: "ps_lead_submitted",
    ps_schema_version: GTM_DATALAYER_CONTRACT_VERSION,
    event_id: sanitizeClientEventId(input.eventId) ?? "evt_lead_submitted",
    form_id: sanitizeSafeIdentifier(input.formId) ?? "contact_default",
    page_path: sanitizeSignalPagePath(input.pagePath) ?? "/",
  };
}

export function buildGtmScriptUrl(
  containerId: string,
  testOverrideUrl?: string,
): string | null {
  if (!isValidGtmContainerId(containerId)) return null;
  if (testOverrideUrl !== undefined) {
    if (!isSafeTestScriptOverrideUrl(testOverrideUrl)) return null;
    const trimmed = testOverrideUrl.trim();
    const sep = trimmed.includes("?") ? "&" : "?";
    return `${trimmed}${sep}id=${encodeURIComponent(containerId)}`;
  }
  return `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
}

export function buildGtmNoscriptUrl(
  containerId: string,
  testOverrideUrl?: string,
): string | null {
  if (!isValidGtmContainerId(containerId)) return null;
  if (testOverrideUrl !== undefined) {
    if (!isSafeTestScriptOverrideUrl(testOverrideUrl)) return null;
    const trimmed = testOverrideUrl.trim();
    const sep = trimmed.includes("?") ? "&" : "?";
    return `${trimmed}${sep}id=${encodeURIComponent(containerId)}`;
  }
  return `https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(containerId)}`;
}
