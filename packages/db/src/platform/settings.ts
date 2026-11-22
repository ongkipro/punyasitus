import {
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
  MAX_IDR_AMOUNT,
  MIN_AUTOLARIS_CHARGE_IDR,
  PLATFORM_BILLING_SETTING_KEYS,
} from "@punyasitus/core/billing/constants";
import {
  ExternalLinkValidationError,
  sanitizeExternalLink,
} from "@punyasitus/core/link-sanitizer";
import {
  normalizeIndonesianWhatsAppNumber,
  WhatsAppValidationError,
} from "@punyasitus/core/wa-dispatcher";
import {
  buildPlatformAuditStatement,
  PlatformAuditError,
  validateOperatorReason,
  type PlatformAuditRecord,
} from "./audit.ts";
import { getActivePlatformOperator } from "./operators.ts";

/**
 * Authoritative `PLATFORM_DB.platform_settings` repository and audited update service
 * for `console.punyasitus.com/settings` (PLAN §13; REQ-051, REQ-082, REQ-105).
 *
 * Security invariants:
 * - Strictly validates `salesWhatsapp` (Indonesian E.164 via TASK-010), `supportEmail`,
 *   `termsUrl` and `privacyUrl` (safe public HTTPS via TASK-011), and optional commercial/support
 *   metadata.
 * - Rejects unknown keys and forbidden keys (`__proto__`, `actorUserId`, `role`, `secret`, etc.).
 * - Requires an active platform operator grant + mandatory 10-500 char reason + optimistic version.
 * - Commits `platform_settings` (+ synced `billing.pricing` when prices are provided) AND
 *   `platform_audit` inside a SINGLE atomic `D1Database.batch([...])` transaction: any audit
 *   failure rolls back the settings change completely.
 */

export const PLATFORM_CONSOLE_SETTINGS_KEY = "platform.public_settings" as const;

const EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;
const CONTROL_CHARS_RE = /\p{Cc}/u;
const MAX_SUPPORT_TEXT_LENGTH = 120;

export const ALLOWED_PLATFORM_SETTINGS_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "salesWhatsapp",
  "supportEmail",
  "termsUrl",
  "privacyUrl",
  "supportHours",
  "supportResponseTarget",
  "monthlyPriceIdr",
  "yearlyPriceIdr",
  "expectedVersion",
  "reason",
  "idempotencyKey",
]);

export const FORBIDDEN_PLATFORM_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "actorUserId",
  "actor_user_id",
  "updatedBy",
  "updated_by",
  "updatedAt",
  "updated_at",
  "version",
  "role",
  "operatorRole",
  "isPlatformOperator",
  "tenantId",
  "tenant_id",
  "organizationId",
  "organization_id",
  "userId",
  "user_id",
  "impersonateUserId",
  "impersonate_user_id",
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "sql",
  "query",
  "command",
]);

export type PlatformSettingsErrorCode =
  | "VALIDATION_ERROR"
  | "UNKNOWN_FIELD"
  | "FORBIDDEN_FIELD"
  | "PLATFORM_OPERATOR_REQUIRED"
  | "VERSION_CONFLICT"
  | "AUDIT_PERSISTENCE_FAILED";

export interface PlatformSettingsFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class PlatformSettingsError extends Error {
  readonly status: 403 | 409 | 422 | 500;
  readonly code: PlatformSettingsErrorCode;
  readonly fields: readonly PlatformSettingsFieldError[];

  constructor(
    status: 403 | 409 | 422 | 500,
    code: PlatformSettingsErrorCode,
    message: string,
    fields: readonly PlatformSettingsFieldError[] = [],
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "PlatformSettingsError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface PlatformSettingsValues {
  readonly salesWhatsapp: string;
  readonly supportEmail: string;
  readonly termsUrl: string;
  readonly privacyUrl: string;
  readonly supportHours: string | null;
  readonly supportResponseTarget: string | null;
  readonly monthlyPriceIdr: number;
  readonly yearlyPriceIdr: number;
}

export interface PlatformSettingsRecord extends PlatformSettingsValues {
  readonly configured: boolean;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: number | null;
}

export interface ValidatedPlatformSettingsPayload extends PlatformSettingsValues {
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface UpdatePlatformSettingsInput {
  readonly actorUserId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface UpdatePlatformSettingsResult {
  readonly settings: PlatformSettingsRecord;
  readonly audit: PlatformAuditRecord;
  readonly changedFields: readonly string[];
}

export const DEFAULT_PLATFORM_SETTINGS_VALUES: PlatformSettingsValues = {
  salesWhatsapp: "",
  supportEmail: "",
  termsUrl: "",
  privacyUrl: "",
  supportHours: "Senin–Jumat, 09.00–17.00 WIB",
  supportResponseTarget: "Maksimal 1 hari kerja",
  monthlyPriceIdr: DEFAULT_MONTHLY_PRICE_IDR,
  yearlyPriceIdr: DEFAULT_YEARLY_PRICE_IDR,
};

function findForbiddenOrUnknownKeys(
  raw: Record<string, unknown>,
): { readonly kind: "forbidden" | "unknown"; readonly key: string } | null {
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_PLATFORM_SETTINGS_KEYS.has(key)) {
      return { kind: "forbidden", key };
    }
    if (!ALLOWED_PLATFORM_SETTINGS_UPDATE_KEYS.has(key)) {
      return { kind: "unknown", key };
    }
  }
  return null;
}

function validateOptionalSupportText(
  raw: unknown,
  field: "supportHours" | "supportResponseTarget",
  errors: PlatformSettingsFieldError[],
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    errors.push({
      field,
      code: "INVALID_STRING",
      message: `${field} harus berupa teks.`,
    });
    return null;
  }
  if (CONTROL_CHARS_RE.test(raw)) {
    errors.push({
      field,
      code: "CONTROL_CHARACTER",
      message: `${field} tidak boleh mengandung karakter kontrol.`,
    });
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_SUPPORT_TEXT_LENGTH) {
    errors.push({
      field,
      code: "TEXT_TOO_LONG",
      message: `${field} maksimal ${MAX_SUPPORT_TEXT_LENGTH} karakter.`,
    });
    return null;
  }
  return trimmed;
}

function validatePriceField(
  raw: unknown,
  fallback: number,
  field: "monthlyPriceIdr" | "yearlyPriceIdr",
  errors: PlatformSettingsFieldError[],
): number {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    errors.push({
      field,
      code: "INVALID_PRICE",
      message: `${field} harus berupa bilangan bulat Rupiah yang valid.`,
    });
    return fallback;
  }
  if (raw < MIN_AUTOLARIS_CHARGE_IDR || raw > MAX_IDR_AMOUNT) {
    errors.push({
      field,
      code: "PRICE_OUT_OF_RANGE",
      message: `${field} harus berada di antara Rp ${MIN_AUTOLARIS_CHARGE_IDR.toLocaleString("id-ID")} dan Rp ${MAX_IDR_AMOUNT.toLocaleString("id-ID")}.`,
    });
    return fallback;
  }
  return raw;
}

/**
 * Pure validator for `platform_settings` updates (unit-testable without D1).
 * Uses canonical TASK-010 WhatsApp E.164 normalizer and TASK-011 HTTPS URL sanitizer.
 */
export function validatePlatformSettingsUpdate(
  rawBody: unknown,
  currentValues: PlatformSettingsValues = DEFAULT_PLATFORM_SETTINGS_VALUES,
): ValidatedPlatformSettingsPayload {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new PlatformSettingsError(
      422,
      "VALIDATION_ERROR",
      "Body permintaan harus berupa objek JSON.",
      [{ field: "body", code: "INVALID_PAYLOAD", message: "Expected a JSON object." }],
    );
  }

  const record = rawBody as Record<string, unknown>;
  const keyViolation = findForbiddenOrUnknownKeys(record);
  if (keyViolation) {
    if (keyViolation.kind === "forbidden") {
      throw new PlatformSettingsError(
        422,
        "FORBIDDEN_FIELD",
        `Field "${keyViolation.key}" dilarang dalam pembaruan pengaturan platform.`,
        [
          {
            field: keyViolation.key,
            code: "FORBIDDEN_FIELD",
            message: `Forbidden field "${keyViolation.key}" is not allowed.`,
          },
        ],
      );
    }
    throw new PlatformSettingsError(
      422,
      "UNKNOWN_FIELD",
      `Field tidak dikenal "${keyViolation.key}".`,
      [
        {
          field: keyViolation.key,
          code: "UNKNOWN_FIELD",
          message: `Unknown field "${keyViolation.key}" is not allowed.`,
        },
      ],
    );
  }

  const errors: PlatformSettingsFieldError[] = [];

  // 1. salesWhatsapp (Indonesian E.164 via TASK-010 helper)
  let salesWhatsapp = "";
  if (typeof record.salesWhatsapp !== "string" || record.salesWhatsapp.trim().length === 0) {
    errors.push({
      field: "salesWhatsapp",
      code: "INVALID_PHONE",
      message: "Nomor WhatsApp penjualan wajib diisi dalam format Indonesia (08 / 628 / +628).",
    });
  } else {
    try {
      salesWhatsapp = normalizeIndonesianWhatsAppNumber(record.salesWhatsapp);
    } catch (err) {
      errors.push({
        field: "salesWhatsapp",
        code: err instanceof WhatsAppValidationError ? err.code : "INVALID_PHONE",
        message:
          err instanceof Error
            ? err.message
            : "Nomor WhatsApp penjualan harus berupa nomor seluler Indonesia E.164 yang valid.",
      });
    }
  }

  // 2. supportEmail (strict valid email)
  let supportEmail = "";
  if (typeof record.supportEmail !== "string" || record.supportEmail.trim().length === 0) {
    errors.push({
      field: "supportEmail",
      code: "INVALID_EMAIL",
      message: "Email dukungan wajib diisi.",
    });
  } else if (CONTROL_CHARS_RE.test(record.supportEmail)) {
    errors.push({
      field: "supportEmail",
      code: "INVALID_EMAIL",
      message: "Email dukungan tidak boleh mengandung karakter kontrol.",
    });
  } else {
    const normalizedEmail = record.supportEmail.trim().toLowerCase();
    if (normalizedEmail.length > 254 || !EMAIL_RE.test(normalizedEmail)) {
      errors.push({
        field: "supportEmail",
        code: "INVALID_EMAIL",
        message: "Format email dukungan tidak valid.",
      });
    } else {
      supportEmail = normalizedEmail;
    }
  }

  // 3. termsUrl (strict safe HTTPS via TASK-011 helper)
  let termsUrl = "";
  if (typeof record.termsUrl !== "string" || record.termsUrl.trim().length === 0) {
    errors.push({
      field: "termsUrl",
      code: "EMPTY_URL",
      message: "URL Syarat & Ketentuan wajib diisi menggunakan HTTPS publik yang valid.",
    });
  } else {
    try {
      termsUrl = sanitizeExternalLink(record.termsUrl).href;
    } catch (err) {
      errors.push({
        field: "termsUrl",
        code: err instanceof ExternalLinkValidationError ? err.code : "INVALID_URL",
        message:
          err instanceof Error
            ? err.message
            : "URL Syarat & Ketentuan harus menggunakan HTTPS publik yang valid.",
      });
    }
  }

  // 4. privacyUrl (strict safe HTTPS via TASK-011 helper)
  let privacyUrl = "";
  if (typeof record.privacyUrl !== "string" || record.privacyUrl.trim().length === 0) {
    errors.push({
      field: "privacyUrl",
      code: "EMPTY_URL",
      message: "URL Kebijakan Privasi wajib diisi menggunakan HTTPS publik yang valid.",
    });
  } else {
    try {
      privacyUrl = sanitizeExternalLink(record.privacyUrl).href;
    } catch (err) {
      errors.push({
        field: "privacyUrl",
        code: err instanceof ExternalLinkValidationError ? err.code : "INVALID_URL",
        message:
          err instanceof Error
            ? err.message
            : "URL Kebijakan Privasi harus menggunakan HTTPS publik yang valid.",
      });
    }
  }

  // 5. Optional support metadata & pricing
  const supportHours =
    "supportHours" in record
      ? validateOptionalSupportText(record.supportHours, "supportHours", errors)
      : currentValues.supportHours;
  const supportResponseTarget =
    "supportResponseTarget" in record
      ? validateOptionalSupportText(record.supportResponseTarget, "supportResponseTarget", errors)
      : currentValues.supportResponseTarget;

  const monthlyPriceIdr = validatePriceField(
    record.monthlyPriceIdr,
    currentValues.monthlyPriceIdr,
    "monthlyPriceIdr",
    errors,
  );
  const yearlyPriceIdr = validatePriceField(
    record.yearlyPriceIdr,
    currentValues.yearlyPriceIdr,
    "yearlyPriceIdr",
    errors,
  );

  // 6. Optimistic version
  let expectedVersion = 0;
  if (
    typeof record.expectedVersion !== "number" ||
    !Number.isSafeInteger(record.expectedVersion) ||
    record.expectedVersion < 0
  ) {
    errors.push({
      field: "expectedVersion",
      code: "INVALID_VERSION",
      message: "expectedVersion harus berupa bilangan bulat >= 0.",
    });
  } else {
    expectedVersion = record.expectedVersion;
  }

  // 7. Mandatory audit reason (10-500 chars)
  let reason = "";
  try {
    reason = validateOperatorReason(record.reason);
  } catch (err) {
    errors.push({
      field: "reason",
      code: err instanceof PlatformAuditError ? err.code : "VALIDATION_ERROR",
      message:
        err instanceof Error
          ? err.message
          : "Alasan perubahan wajib diisi (10–500 karakter tanpa data rahasia).",
    });
  }

  if (errors.length > 0) {
    throw new PlatformSettingsError(
      422,
      "VALIDATION_ERROR",
      errors[0]?.message ?? "Validasi pengaturan platform gagal.",
      errors,
    );
  }

  return {
    salesWhatsapp,
    supportEmail,
    termsUrl,
    privacyUrl,
    supportHours,
    supportResponseTarget,
    monthlyPriceIdr,
    yearlyPriceIdr,
    expectedVersion,
    reason,
  };
}

interface PlatformSettingsDbRow {
  readonly key: string;
  readonly value_json: string;
  readonly version: number;
  readonly updated_by: string | null;
  readonly updated_at: number;
}

/**
 * Reads the current `platform_settings` console record from `PLATFORM_DB`.
 * Returns `configured: false, version: 0` when no settings row has been saved yet.
 */
export async function getPlatformSettings(
  platformDb: D1Database,
): Promise<PlatformSettingsRecord> {
  const row = await platformDb
    .prepare(
      `SELECT key, value_json, version, updated_by, updated_at
       FROM platform_settings
       WHERE key = ?
       LIMIT 1`,
    )
    .bind(PLATFORM_CONSOLE_SETTINGS_KEY)
    .first<PlatformSettingsDbRow>();

  if (!row) {
    return {
      ...DEFAULT_PLATFORM_SETTINGS_VALUES,
      configured: false,
      version: 0,
      updatedBy: null,
      updatedAt: null,
    };
  }

  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(row.value_json) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  return {
    salesWhatsapp:
      typeof parsed.salesWhatsapp === "string"
        ? parsed.salesWhatsapp
        : DEFAULT_PLATFORM_SETTINGS_VALUES.salesWhatsapp,
    supportEmail:
      typeof parsed.supportEmail === "string"
        ? parsed.supportEmail
        : DEFAULT_PLATFORM_SETTINGS_VALUES.supportEmail,
    termsUrl:
      typeof parsed.termsUrl === "string"
        ? parsed.termsUrl
        : DEFAULT_PLATFORM_SETTINGS_VALUES.termsUrl,
    privacyUrl:
      typeof parsed.privacyUrl === "string"
        ? parsed.privacyUrl
        : DEFAULT_PLATFORM_SETTINGS_VALUES.privacyUrl,
    supportHours:
      typeof parsed.supportHours === "string" ? parsed.supportHours : null,
    supportResponseTarget:
      typeof parsed.supportResponseTarget === "string" ? parsed.supportResponseTarget : null,
    monthlyPriceIdr:
      typeof parsed.monthlyPriceIdr === "number" && Number.isSafeInteger(parsed.monthlyPriceIdr)
        ? parsed.monthlyPriceIdr
        : DEFAULT_MONTHLY_PRICE_IDR,
    yearlyPriceIdr:
      typeof parsed.yearlyPriceIdr === "number" && Number.isSafeInteger(parsed.yearlyPriceIdr)
        ? parsed.yearlyPriceIdr
        : DEFAULT_YEARLY_PRICE_IDR,
    configured: true,
    version: Number(row.version),
    updatedBy: row.updated_by,
    updatedAt: Number(row.updated_at),
  };
}

function computeChangedSettingsFields(
  prev: PlatformSettingsRecord,
  next: PlatformSettingsValues,
): string[] {
  const changed: string[] = [];
  if (prev.salesWhatsapp !== next.salesWhatsapp) changed.push("salesWhatsapp");
  if (prev.supportEmail !== next.supportEmail) changed.push("supportEmail");
  if (prev.termsUrl !== next.termsUrl) changed.push("termsUrl");
  if (prev.privacyUrl !== next.privacyUrl) changed.push("privacyUrl");
  if (prev.supportHours !== next.supportHours) changed.push("supportHours");
  if (prev.supportResponseTarget !== next.supportResponseTarget) {
    changed.push("supportResponseTarget");
  }
  if (prev.monthlyPriceIdr !== next.monthlyPriceIdr) changed.push("monthlyPriceIdr");
  if (prev.yearlyPriceIdr !== next.yearlyPriceIdr) changed.push("yearlyPriceIdr");
  return changed;
}

/**
 * Validates and persists `platform_settings` atomically with `platform_audit`.
 * If `platform_audit` insertion fails (e.g. DB error/trigger), SQLite rolls back the entire batch.
 */
export async function updatePlatformSettings(
  platformDb: D1Database,
  input: UpdatePlatformSettingsInput,
): Promise<UpdatePlatformSettingsResult> {
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) {
    throw new PlatformSettingsError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "Operator platform aktif diperlukan untuk mengubah pengaturan platform.",
    );
  }

  const actorGrant = await getActivePlatformOperator(platformDb, actorUserId);
  if (!actorGrant) {
    throw new PlatformSettingsError(
      403,
      "PLATFORM_OPERATOR_REQUIRED",
      "Akses operator platform aktif diperlukan untuk mengubah pengaturan platform.",
    );
  }

  const current = await getPlatformSettings(platformDb);
  const validated = validatePlatformSettingsUpdate(input.payload, current);

  if (validated.expectedVersion !== current.version) {
    throw new PlatformSettingsError(
      409,
      "VERSION_CONFLICT",
      `Versi pengaturan tidak cocok (diharapkan ${validated.expectedVersion}, saat ini ${current.version}). Muat ulang sebelum menyimpan.`,
    );
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const nextValues: PlatformSettingsValues = {
    salesWhatsapp: validated.salesWhatsapp,
    supportEmail: validated.supportEmail,
    termsUrl: validated.termsUrl,
    privacyUrl: validated.privacyUrl,
    supportHours: validated.supportHours,
    supportResponseTarget: validated.supportResponseTarget,
    monthlyPriceIdr: validated.monthlyPriceIdr,
    yearlyPriceIdr: validated.yearlyPriceIdr,
  };
  const changedFields = computeChangedSettingsFields(current, nextValues);
  const valueJson = JSON.stringify(nextValues);
  const nextVersion = current.version + 1;

  const settingsStmt =
    current.version === 0
      ? platformDb
          .prepare(
            `INSERT INTO platform_settings (key, value_json, version, updated_by, updated_at)
             SELECT ?, ?, 1, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM platform_operators WHERE user_id = ? AND revoked_at IS NULL
             )
               AND NOT EXISTS (
                 SELECT 1 FROM platform_settings WHERE key = ?
               )`,
          )
          .bind(
            PLATFORM_CONSOLE_SETTINGS_KEY,
            valueJson,
            actorUserId,
            nowMs,
            actorUserId,
            PLATFORM_CONSOLE_SETTINGS_KEY,
          )
      : platformDb
          .prepare(
            `UPDATE platform_settings
             SET value_json = ?, version = version + 1, updated_by = ?, updated_at = ?
             WHERE key = ?
               AND version = ?
               AND EXISTS (
                 SELECT 1 FROM platform_operators WHERE user_id = ? AND revoked_at IS NULL
               )`,
          )
          .bind(
            valueJson,
            actorUserId,
            nowMs,
            PLATFORM_CONSOLE_SETTINGS_KEY,
            validated.expectedVersion,
            actorUserId,
          );

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "platform_operator",
      action: "platform_settings.update",
      targetType: "platform_settings",
      targetId: PLATFORM_CONSOLE_SETTINGS_KEY,
      reason: validated.reason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        changedFields,
        fromVersion: current.version,
        toVersion: nextVersion,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  // Mirror billing pricing key when pricing values are explicitly supplied so checkout reads live prices immediately.
  const statements: D1PreparedStatement[] = [settingsStmt, auditStmt];
  if ("monthlyPriceIdr" in input.payload || "yearlyPriceIdr" in input.payload) {
    const pricingJson = JSON.stringify({
      monthlyPriceIdr: nextValues.monthlyPriceIdr,
      yearlyPriceIdr: nextValues.yearlyPriceIdr,
    });
    statements.push(
      platformDb
        .prepare(
          `INSERT INTO platform_settings (key, value_json, version, updated_by, updated_at)
           SELECT ?, ?, 1, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM platform_settings WHERE key = ? AND version = ?
           )
           ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             version = platform_settings.version + 1,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .bind(
          PLATFORM_BILLING_SETTING_KEYS.pricing,
          pricingJson,
          actorUserId,
          nowMs,
          PLATFORM_CONSOLE_SETTINGS_KEY,
          nextVersion,
        ),
    );
  }

  let results: D1Result[];
  try {
    results = await platformDb.batch(statements);
  } catch (err) {
    throw new PlatformSettingsError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Transaksi pembaruan pengaturan gagal dan dibatalkan sepenuhnya (audit wajib tersimpan).",
      [],
      err,
    );
  }

  const settingsChanges = results[0]?.meta?.changes ?? 0;
  const auditChanges = results[1]?.meta?.changes ?? 0;

  if (settingsChanges !== 1) {
    const stillActive = await getActivePlatformOperator(platformDb, actorUserId);
    if (!stillActive) {
      throw new PlatformSettingsError(
        403,
        "PLATFORM_OPERATOR_REQUIRED",
        "Akses operator platform sudah dicabut.",
      );
    }
    throw new PlatformSettingsError(
      409,
      "VERSION_CONFLICT",
      "Pengaturan telah diperbarui oleh operator lain. Muat ulang versi terbaru sebelum menyimpan.",
    );
  }

  if (auditChanges !== 1) {
    throw new PlatformSettingsError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Catatan audit pengaturan platform gagal tersimpan.",
    );
  }

  const updated = await getPlatformSettings(platformDb);
  return {
    settings: updated,
    audit: auditEntry,
    changedFields,
  };
}
