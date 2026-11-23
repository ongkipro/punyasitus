import { z } from "zod";
import {
  ExternalLinkValidationError,
  sanitizeExternalLink,
} from "../link-sanitizer.ts";
import {
  CONTACT_PREFERENCES,
  CUSTOM_THEME_ALLOWED_TRANSITIONS,
  CUSTOM_THEME_MAX_BRAND_NAME_LENGTH,
  CUSTOM_THEME_MAX_BRIEF_LENGTH,
  CUSTOM_THEME_MAX_BUDGET_RANGE_LENGTH,
  CUSTOM_THEME_MAX_INCLUSION_LENGTH,
  CUSTOM_THEME_MAX_OPERATOR_NOTES_LENGTH,
  CUSTOM_THEME_MAX_PACKAGE_INCLUSIONS,
  CUSTOM_THEME_MAX_REASON_LENGTH,
  CUSTOM_THEME_MAX_REFERENCE_URLS,
  CUSTOM_THEME_MAX_SORT_ORDER,
  CUSTOM_THEME_MAX_STARTING_PRICE_IDR,
  CUSTOM_THEME_MIN_REASON_LENGTH,
  CUSTOM_THEME_REQUEST_STATUSES,
  CustomThemeValidationError,
  SERVICE_KINDS,
  type ContactPreference,
  type CustomThemeFieldError,
  type CustomThemeRequestStatus,
  type ServiceKind,
} from "./constants.ts";

/**
 * Pure runtime validators for Custom Theme Service packages, tenant requests,
 * reference URLs (HTTPS-only, never fetched), and operator status transitions
 * (REQ-063, PLAN §11.4 & §13, TASK-061).
 */

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SIMPLE_STAFF_EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;

const SERVICE_KIND_SET: ReadonlySet<string> = new Set(SERVICE_KINDS);
const CONTACT_PREFERENCE_SET: ReadonlySet<string> = new Set(CONTACT_PREFERENCES);
const REQUEST_STATUS_SET: ReadonlySet<string> = new Set(CUSTOM_THEME_REQUEST_STATUSES);

function hasDisallowedControlChars(value: string, allowLineBreaks: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code <= 0x1f) {
      if (allowLineBreaks && (code === 0x0a || code === 0x0d || code === 0x09)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CustomThemeValidationError(
      "VALIDATION_ERROR",
      "Payload permintaan harus berupa objek JSON yang valid.",
    );
  }
  return input as Record<string, unknown>;
}

/**
 * Validates up to 5 HTTPS-only reference URLs using `sanitizeExternalLink`
 * (rejecting `http:`, `javascript:`, `data:`, embedded credentials, loopback,
 * RFC 1918 private networks, link-local metadata, and malformed hosts).
 *
 * CRITICAL INVARIANT: NEVER fetches, resolves DNS, or makes outbound network calls!
 */
export function validateCustomThemeReferenceUrls(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new CustomThemeValidationError(
      "VALIDATION_ERROR",
      "Daftar URL referensi harus berupa array.",
      [
        {
          field: "referenceUrls",
          code: "INVALID_TYPE",
          message: "URL referensi harus dikirim dalam bentuk daftar.",
        },
      ],
    );
  }

  const trimmedEntries: { readonly index: number; readonly rawValue: string }[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== "string") {
      throw new CustomThemeValidationError(
        "INVALID_REFERENCE_URL",
        `URL referensi ke-${i + 1} harus berupa teks HTTPS yang valid.`,
        [
          {
            field: `referenceUrls[${i}]`,
            code: "INVALID_REFERENCE_URL",
            message: "URL referensi harus berupa teks tautan HTTPS yang valid.",
          },
        ],
      );
    }
    const cleaned = item.trim();
    if (cleaned.length > 0) {
      trimmedEntries.push({ index: i, rawValue: cleaned });
    }
  }

  if (trimmedEntries.length > CUSTOM_THEME_MAX_REFERENCE_URLS) {
    throw new CustomThemeValidationError(
      "TOO_MANY_REFERENCE_URLS",
      `Maksimal ${CUSTOM_THEME_MAX_REFERENCE_URLS} URL referensi yang diperbolehkan.`,
      [
        {
          field: "referenceUrls",
          code: "TOO_MANY_REFERENCE_URLS",
          message: `Maksimal ${CUSTOM_THEME_MAX_REFERENCE_URLS} tautan referensi per permintaan.`,
        },
      ],
    );
  }

  const sanitized: string[] = [];
  const seen = new Set<string>();
  const fieldErrors: CustomThemeFieldError[] = [];

  for (const entry of trimmedEntries) {
    try {
      const link = sanitizeExternalLink(entry.rawValue);
      if (!seen.has(link.href)) {
        seen.add(link.href);
        sanitized.push(link.href);
      }
    } catch (err) {
      const reason =
        err instanceof ExternalLinkValidationError
          ? err.code === "UNSUPPORTED_PROTOCOL"
            ? "Gunakan tautan HTTPS publik yang aman (https://...)."
            : err.code === "FORBIDDEN_HOST"
              ? "Tautan ke jaringan lokal/privat tidak diizinkan."
              : err.code === "EMBEDDED_CREDENTIALS"
                ? "Tautan tidak boleh memuat kredensial."
                : "Format URL referensi tidak valid."
          : "URL referensi tidak valid.";
      fieldErrors.push({
        field: `referenceUrls[${entry.index}]`,
        code: "INVALID_REFERENCE_URL",
        message: reason,
      });
    }
  }

  if (fieldErrors.length > 0) {
    throw new CustomThemeValidationError(
      "INVALID_REFERENCE_URL",
      fieldErrors[0]?.message ?? "Salah satu URL referensi tidak valid.",
      fieldErrors,
    );
  }

  return sanitized;
}

export function validateIdempotencyKey(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new CustomThemeValidationError(
      "INVALID_IDEMPOTENCY_KEY",
      "Kunci idempotensi (Idempotency-Key) wajib disertakan.",
      [
        {
          field: "idempotencyKey",
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "Sertakan header Idempotency-Key atau field idempotencyKey (8–128 karakter).",
        },
      ],
    );
  }
  const trimmed = raw.trim();
  if (!IDEMPOTENCY_KEY_RE.test(trimmed)) {
    throw new CustomThemeValidationError(
      "INVALID_IDEMPOTENCY_KEY",
      "Format kunci idempotensi tidak valid (gunakan 8–128 karakter huruf, angka, titik, garis bawah, titik dua, atau tanda hubung).",
      [
        {
          field: "idempotencyKey",
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "Kunci idempotensi harus 8–128 karakter (A-Z, a-z, 0-9, ., _, :, -).",
        },
      ],
    );
  }
  return trimmed;
}

export interface ValidatedCreateCustomThemeRequestInput {
  readonly serviceKind: ServiceKind;
  readonly packageId: string | null;
  readonly brandName: string;
  readonly brief: string;
  readonly referenceUrls: readonly string[];
  readonly budgetRange: string | null;
  readonly contactPreference: ContactPreference;
  readonly idempotencyKey: string;
}

export function validateCreateCustomThemeRequestInput(
  rawInput: unknown,
  options: { readonly headerIdempotencyKey?: string | null; readonly serviceKind?: ServiceKind } = {},
): ValidatedCreateCustomThemeRequestInput {
  const rec = asRecord(rawInput);
  const fields: CustomThemeFieldError[] = [];

  const serviceKind: ServiceKind = options.serviceKind ?? "custom_theme";

  // packageId: optional or null / "undecided"
  let packageId: string | null = null;
  if (rec.packageId !== undefined && rec.packageId !== null) {
    if (typeof rec.packageId !== "string") {
      fields.push({
        field: "packageId",
        code: "INVALID_TYPE",
        message: "Pilihan paket tidak valid.",
      });
    } else {
      const cleaned = rec.packageId.trim();
      if (cleaned !== "" && cleaned.toLowerCase() !== "undecided") {
        if (cleaned.length > 64 || hasDisallowedControlChars(cleaned, false)) {
          fields.push({
            field: "packageId",
            code: "INVALID_PACKAGE_ID",
            message: "ID paket tidak valid.",
          });
        } else {
          packageId = cleaned;
        }
      }
    }
  }

  // brandName: 1..100 chars
  let brandName = "";
  if (typeof rec.brandName !== "string") {
    fields.push({
      field: "brandName",
      code: "REQUIRED",
      message: "Nama brand atau usaha wajib diisi.",
    });
  } else {
    brandName = rec.brandName.trim();
    if (brandName.length < 1 || brandName.length > CUSTOM_THEME_MAX_BRAND_NAME_LENGTH) {
      fields.push({
        field: "brandName",
        code: "INVALID_LENGTH",
        message: `Nama brand harus 1–${CUSTOM_THEME_MAX_BRAND_NAME_LENGTH} karakter.`,
      });
    } else if (hasDisallowedControlChars(brandName, false)) {
      fields.push({
        field: "brandName",
        code: "CONTROL_CHARACTER",
        message: "Nama brand tidak boleh mengandung karakter kontrol.",
      });
    }
  }

  // brief: 1..2000 chars
  let brief = "";
  if (typeof rec.brief !== "string") {
    fields.push({
      field: "brief",
      code: "REQUIRED",
      message: "Ringkasan kebutuhan desain (brief) wajib diisi.",
    });
  } else {
    brief = rec.brief.trim();
    if (brief.length < 1 || brief.length > CUSTOM_THEME_MAX_BRIEF_LENGTH) {
      fields.push({
        field: "brief",
        code: "INVALID_LENGTH",
        message: `Ringkasan kebutuhan harus 1–${CUSTOM_THEME_MAX_BRIEF_LENGTH} karakter.`,
      });
    } else if (hasDisallowedControlChars(brief, true)) {
      fields.push({
        field: "brief",
        code: "CONTROL_CHARACTER",
        message: "Ringkasan kebutuhan mengandung karakter kontrol tidak valid.",
      });
    }
  }

  // budgetRange: optional <= 120 chars
  let budgetRange: string | null = null;
  if (rec.budgetRange !== undefined && rec.budgetRange !== null) {
    if (typeof rec.budgetRange !== "string") {
      fields.push({
        field: "budgetRange",
        code: "INVALID_TYPE",
        message: "Kisaran anggaran harus berupa teks.",
      });
    } else {
      const cleaned = rec.budgetRange.trim();
      if (cleaned.length > CUSTOM_THEME_MAX_BUDGET_RANGE_LENGTH) {
        fields.push({
          field: "budgetRange",
          code: "INVALID_LENGTH",
          message: `Kisaran anggaran maksimal ${CUSTOM_THEME_MAX_BUDGET_RANGE_LENGTH} karakter.`,
        });
      } else if (hasDisallowedControlChars(cleaned, false)) {
        fields.push({
          field: "budgetRange",
          code: "CONTROL_CHARACTER",
          message: "Kisaran anggaran mengandung karakter kontrol tidak valid.",
        });
      } else if (cleaned.length > 0) {
        budgetRange = cleaned;
      }
    }
  }

  // contactPreference
  let contactPreference: ContactPreference = "whatsapp";
  if (rec.contactPreference !== undefined && rec.contactPreference !== null) {
    if (
      typeof rec.contactPreference !== "string" ||
      !CONTACT_PREFERENCE_SET.has(rec.contactPreference.trim())
    ) {
      fields.push({
        field: "contactPreference",
        code: "INVALID_VALUE",
        message: "Preferensi kontak harus salah satu dari: whatsapp, email, atau both.",
      });
    } else {
      contactPreference = rec.contactPreference.trim() as ContactPreference;
    }
  }

  // referenceUrls: validate early so specific error codes surface cleanly
  let referenceUrls: readonly string[] = [];
  let referenceUrlError: CustomThemeValidationError | null = null;
  try {
    referenceUrls = validateCustomThemeReferenceUrls(rec.referenceUrls);
  } catch (err) {
    if (err instanceof CustomThemeValidationError) {
      referenceUrlError = err;
      fields.push(...err.fields);
    } else {
      throw err;
    }
  }

  // idempotencyKey: prefer header, fall back to body
  const rawIdem =
    options.headerIdempotencyKey && options.headerIdempotencyKey.trim().length > 0
      ? options.headerIdempotencyKey
      : rec.idempotencyKey;
  let idempotencyKey = "";
  let idemError: CustomThemeValidationError | null = null;
  try {
    idempotencyKey = validateIdempotencyKey(rawIdem);
  } catch (err) {
    if (err instanceof CustomThemeValidationError) {
      idemError = err;
      fields.push(...err.fields);
    } else {
      throw err;
    }
  }

  if (fields.length > 0) {
    const primaryCode =
      referenceUrlError?.code ?? idemError?.code ?? "VALIDATION_ERROR";
    const primaryMessage =
      fields[0]?.message ?? "Periksa kembali isian formulir permintaan tema kustom.";
    throw new CustomThemeValidationError(primaryCode, primaryMessage, fields);
  }

  return {
    serviceKind,
    packageId,
    brandName,
    brief,
    referenceUrls,
    budgetRange,
    contactPreference,
    idempotencyKey,
  };
}

function validateOperatorReasonField(raw: unknown, fields: CustomThemeFieldError[]): string {
  if (typeof raw !== "string") {
    fields.push({
      field: "reason",
      code: "INVALID_REASON",
      message: `Alasan perubahan wajib diisi (${CUSTOM_THEME_MIN_REASON_LENGTH}–${CUSTOM_THEME_MAX_REASON_LENGTH} karakter).`,
    });
    return "";
  }
  const trimmed = raw.trim();
  if (
    trimmed.length < CUSTOM_THEME_MIN_REASON_LENGTH ||
    trimmed.length > CUSTOM_THEME_MAX_REASON_LENGTH
  ) {
    fields.push({
      field: "reason",
      code: "INVALID_REASON",
      message: `Alasan perubahan harus ${CUSTOM_THEME_MIN_REASON_LENGTH}–${CUSTOM_THEME_MAX_REASON_LENGTH} karakter.`,
    });
    return "";
  }
  if (hasDisallowedControlChars(trimmed, false)) {
    fields.push({
      field: "reason",
      code: "CONTROL_CHARACTER",
      message: "Alasan tidak boleh mengandung karakter kontrol atau baris baru.",
    });
    return "";
  }
  return trimmed;
}

function validateInclusionsField(
  raw: unknown,
  fields: CustomThemeFieldError[],
): readonly string[] {
  if (!Array.isArray(raw)) {
    fields.push({
      field: "inclusions",
      code: "INVALID_TYPE",
      message: "Daftar cakupan paket (inclusions) harus berupa array.",
    });
    return [];
  }
  const cleaned: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== "string") {
      fields.push({
        field: `inclusions[${i}]`,
        code: "INVALID_TYPE",
        message: "Setiap item cakupan harus berupa teks.",
      });
      continue;
    }
    const text = item.trim();
    if (text.length === 0) continue;
    if (text.length > CUSTOM_THEME_MAX_INCLUSION_LENGTH || hasDisallowedControlChars(text, false)) {
      fields.push({
        field: `inclusions[${i}]`,
        code: "INVALID_VALUE",
        message: `Setiap item cakupan maksimal ${CUSTOM_THEME_MAX_INCLUSION_LENGTH} karakter tanpa karakter kontrol.`,
      });
      continue;
    }
    cleaned.push(text);
  }
  if (cleaned.length < 1 || cleaned.length > CUSTOM_THEME_MAX_PACKAGE_INCLUSIONS) {
    fields.push({
      field: "inclusions",
      code: "INVALID_LENGTH",
      message: `Sertakan 1–${CUSTOM_THEME_MAX_PACKAGE_INCLUSIONS} item cakupan paket.`,
    });
  }
  return cleaned;
}

function validateStartingPriceIdrField(
  raw: unknown,
  fields: CustomThemeFieldError[],
): number | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw <= 0 ||
    raw > CUSTOM_THEME_MAX_STARTING_PRICE_IDR
  ) {
    fields.push({
      field: "startingPriceIdr",
      code: "INVALID_PRICE",
      message: "Harga mulai harus bilangan bulat positif dalam Rupiah atau dikosongkan untuk penawaran khusus.",
    });
    return null;
  }
  return raw;
}

export interface ValidatedCreateCustomThemePackageInput {
  readonly serviceKind: ServiceKind;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly inclusions: readonly string[];
  readonly startingPriceIdr: number | null;
  readonly estimatedDuration: string;
  readonly sortOrder: number;
  readonly active: boolean;
  readonly reason: string;
}

export function validateCreateCustomThemePackageInput(
  rawInput: unknown,
): ValidatedCreateCustomThemePackageInput {
  const rec = asRecord(rawInput);
  const fields: CustomThemeFieldError[] = [];

  let serviceKind: ServiceKind = "custom_theme";
  if (rec.serviceKind !== undefined && rec.serviceKind !== null) {
    if (typeof rec.serviceKind !== "string" || !SERVICE_KIND_SET.has(rec.serviceKind.trim())) {
      fields.push({
        field: "serviceKind",
        code: "INVALID_VALUE",
        message: "Jenis layanan tidak valid.",
      });
    } else {
      serviceKind = rec.serviceKind.trim() as ServiceKind;
    }
  }

  let slug = "";
  if (typeof rec.slug !== "string") {
    fields.push({ field: "slug", code: "REQUIRED", message: "Slug paket wajib diisi." });
  } else {
    slug = rec.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      fields.push({
        field: "slug",
        code: "INVALID_SLUG",
        message: "Slug paket harus huruf kecil, angka, dan tanda hubung (2–64 karakter).",
      });
    }
  }

  let name = "";
  if (typeof rec.name !== "string") {
    fields.push({ field: "name", code: "REQUIRED", message: "Nama paket wajib diisi." });
  } else {
    name = rec.name.trim();
    if (name.length < 2 || name.length > 120 || hasDisallowedControlChars(name, false)) {
      fields.push({
        field: "name",
        code: "INVALID_LENGTH",
        message: "Nama paket harus 2–120 karakter.",
      });
    }
  }

  let description = "";
  if (typeof rec.description !== "string") {
    fields.push({ field: "description", code: "REQUIRED", message: "Deskripsi paket wajib diisi." });
  } else {
    description = rec.description.trim();
    if (
      description.length < 5 ||
      description.length > 1000 ||
      hasDisallowedControlChars(description, true)
    ) {
      fields.push({
        field: "description",
        code: "INVALID_LENGTH",
        message: "Deskripsi paket harus 5–1000 karakter.",
      });
    }
  }

  const inclusions = validateInclusionsField(rec.inclusions, fields);
  const startingPriceIdr = validateStartingPriceIdrField(rec.startingPriceIdr, fields);

  let estimatedDuration = "";
  if (typeof rec.estimatedDuration !== "string") {
    fields.push({
      field: "estimatedDuration",
      code: "REQUIRED",
      message: "Estimasi waktu pengerjaan wajib diisi.",
    });
  } else {
    estimatedDuration = rec.estimatedDuration.trim();
    if (
      estimatedDuration.length < 2 ||
      estimatedDuration.length > 100 ||
      hasDisallowedControlChars(estimatedDuration, false)
    ) {
      fields.push({
        field: "estimatedDuration",
        code: "INVALID_LENGTH",
        message: "Estimasi pengerjaan harus 2–100 karakter.",
      });
    }
  }

  let sortOrder = 0;
  if (rec.sortOrder !== undefined && rec.sortOrder !== null) {
    if (
      typeof rec.sortOrder !== "number" ||
      !Number.isSafeInteger(rec.sortOrder) ||
      rec.sortOrder < 0 ||
      rec.sortOrder > CUSTOM_THEME_MAX_SORT_ORDER
    ) {
      fields.push({
        field: "sortOrder",
        code: "INVALID_VALUE",
        message: `Urutan tampilan harus bilangan bulat 0–${CUSTOM_THEME_MAX_SORT_ORDER}.`,
      });
    } else {
      sortOrder = rec.sortOrder;
    }
  }

  let active = true;
  if (rec.active !== undefined) {
    if (typeof rec.active !== "boolean") {
      fields.push({
        field: "active",
        code: "INVALID_TYPE",
        message: "Status aktif paket harus berupa boolean.",
      });
    } else {
      active = rec.active;
    }
  }

  const reason = validateOperatorReasonField(rec.reason, fields);

  if (fields.length > 0) {
    const code = fields.some((f) => f.code === "INVALID_REASON") && fields.length === 1
      ? "INVALID_REASON"
      : "VALIDATION_ERROR";
    throw new CustomThemeValidationError(
      code,
      fields[0]?.message ?? "Data paket tema kustom tidak valid.",
      fields,
    );
  }

  return {
    serviceKind,
    slug,
    name,
    description,
    inclusions,
    startingPriceIdr,
    estimatedDuration,
    sortOrder,
    active,
    reason,
  };
}

export interface ValidatedUpdateCustomThemePackageInput {
  readonly expectedVersion: number;
  readonly name?: string;
  readonly description?: string;
  readonly inclusions?: readonly string[];
  readonly startingPriceIdr?: number | null;
  readonly estimatedDuration?: string;
  readonly sortOrder?: number;
  readonly active?: boolean;
  readonly reason: string;
}

export function validateUpdateCustomThemePackageInput(
  rawInput: unknown,
): ValidatedUpdateCustomThemePackageInput {
  const rec = asRecord(rawInput);
  const fields: CustomThemeFieldError[] = [];

  let expectedVersion = 0;
  if (
    typeof rec.expectedVersion !== "number" ||
    !Number.isSafeInteger(rec.expectedVersion) ||
    rec.expectedVersion < 1
  ) {
    fields.push({
      field: "expectedVersion",
      code: "INVALID_VERSION",
      message: "expectedVersion wajib berupa bilangan bulat positif.",
    });
  } else {
    expectedVersion = rec.expectedVersion;
  }

  let name: string | undefined;
  if (rec.name !== undefined) {
    if (typeof rec.name !== "string") {
      fields.push({ field: "name", code: "INVALID_TYPE", message: "Nama paket harus berupa teks." });
    } else {
      const cleaned = rec.name.trim();
      if (cleaned.length < 2 || cleaned.length > 120 || hasDisallowedControlChars(cleaned, false)) {
        fields.push({
          field: "name",
          code: "INVALID_LENGTH",
          message: "Nama paket harus 2–120 karakter.",
        });
      } else {
        name = cleaned;
      }
    }
  }

  let description: string | undefined;
  if (rec.description !== undefined) {
    if (typeof rec.description !== "string") {
      fields.push({
        field: "description",
        code: "INVALID_TYPE",
        message: "Deskripsi paket harus berupa teks.",
      });
    } else {
      const cleaned = rec.description.trim();
      if (
        cleaned.length < 5 ||
        cleaned.length > 1000 ||
        hasDisallowedControlChars(cleaned, true)
      ) {
        fields.push({
          field: "description",
          code: "INVALID_LENGTH",
          message: "Deskripsi paket harus 5–1000 karakter.",
        });
      } else {
        description = cleaned;
      }
    }
  }

  let inclusions: readonly string[] | undefined;
  if (rec.inclusions !== undefined) {
    inclusions = validateInclusionsField(rec.inclusions, fields);
  }

  let startingPriceIdr: number | null | undefined;
  if (Object.prototype.hasOwnProperty.call(rec, "startingPriceIdr")) {
    startingPriceIdr = validateStartingPriceIdrField(rec.startingPriceIdr, fields);
  }

  let estimatedDuration: string | undefined;
  if (rec.estimatedDuration !== undefined) {
    if (typeof rec.estimatedDuration !== "string") {
      fields.push({
        field: "estimatedDuration",
        code: "INVALID_TYPE",
        message: "Estimasi pengerjaan harus berupa teks.",
      });
    } else {
      const cleaned = rec.estimatedDuration.trim();
      if (
        cleaned.length < 2 ||
        cleaned.length > 100 ||
        hasDisallowedControlChars(cleaned, false)
      ) {
        fields.push({
          field: "estimatedDuration",
          code: "INVALID_LENGTH",
          message: "Estimasi pengerjaan harus 2–100 karakter.",
        });
      } else {
        estimatedDuration = cleaned;
      }
    }
  }

  let sortOrder: number | undefined;
  if (rec.sortOrder !== undefined) {
    if (
      typeof rec.sortOrder !== "number" ||
      !Number.isSafeInteger(rec.sortOrder) ||
      rec.sortOrder < 0 ||
      rec.sortOrder > CUSTOM_THEME_MAX_SORT_ORDER
    ) {
      fields.push({
        field: "sortOrder",
        code: "INVALID_VALUE",
        message: `Urutan tampilan harus bilangan bulat 0–${CUSTOM_THEME_MAX_SORT_ORDER}.`,
      });
    } else {
      sortOrder = rec.sortOrder;
    }
  }

  let active: boolean | undefined;
  if (rec.active !== undefined) {
    if (typeof rec.active !== "boolean") {
      fields.push({
        field: "active",
        code: "INVALID_TYPE",
        message: "Status aktif paket harus berupa boolean.",
      });
    } else {
      active = rec.active;
    }
  }

  const reason = validateOperatorReasonField(rec.reason, fields);

  const hasMutationField =
    name !== undefined ||
    description !== undefined ||
    inclusions !== undefined ||
    startingPriceIdr !== undefined ||
    estimatedDuration !== undefined ||
    sortOrder !== undefined ||
    active !== undefined;

  if (!hasMutationField) {
    fields.push({
      field: "body",
      code: "NO_CHANGES",
      message: "Sertakan minimal satu kolom paket untuk diperbarui.",
    });
  }

  if (fields.length > 0) {
    const code = fields.some((f) => f.code === "INVALID_REASON") && fields.length === 1
      ? "INVALID_REASON"
      : "VALIDATION_ERROR";
    throw new CustomThemeValidationError(
      code,
      fields[0]?.message ?? "Perubahan paket tidak valid.",
      fields,
    );
  }

  return {
    expectedVersion,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(inclusions !== undefined ? { inclusions } : {}),
    ...(startingPriceIdr !== undefined ? { startingPriceIdr } : {}),
    ...(estimatedDuration !== undefined ? { estimatedDuration } : {}),
    ...(sortOrder !== undefined ? { sortOrder } : {}),
    ...(active !== undefined ? { active } : {}),
    reason,
  };
}

export interface ValidatedTransitionCustomThemeRequestInput {
  readonly expectedVersion: number;
  readonly status: CustomThemeRequestStatus;
  readonly reason: string;
  readonly operatorNotes?: string | null;
  readonly deliveredThemeId?: string | null;
  readonly staffUserEmail?: string | null;
  readonly staffUserId?: string | null;
}

export function isAllowedCustomThemeStatusTransition(
  fromStatus: CustomThemeRequestStatus,
  toStatus: CustomThemeRequestStatus,
): boolean {
  return CUSTOM_THEME_ALLOWED_TRANSITIONS[fromStatus].includes(toStatus);
}

export function validateTransitionCustomThemeRequestInput(
  rawInput: unknown,
  options: { readonly serviceKind?: ServiceKind } = {},
): ValidatedTransitionCustomThemeRequestInput {
  const rec = asRecord(rawInput);
  const fields: CustomThemeFieldError[] = [];
  const serviceKind: ServiceKind = options.serviceKind ?? "custom_theme";

  let expectedVersion = 0;
  if (
    typeof rec.expectedVersion !== "number" ||
    !Number.isSafeInteger(rec.expectedVersion) ||
    rec.expectedVersion < 1
  ) {
    fields.push({
      field: "expectedVersion",
      code: "INVALID_VERSION",
      message: "expectedVersion wajib berupa bilangan bulat positif.",
    });
  } else {
    expectedVersion = rec.expectedVersion;
  }

  let status: CustomThemeRequestStatus = "new";
  if (typeof rec.status !== "string" || !REQUEST_STATUS_SET.has(rec.status.trim())) {
    fields.push({
      field: "status",
      code: "INVALID_STATUS",
      message: `Status tidak valid. Pilih salah satu dari: ${CUSTOM_THEME_REQUEST_STATUSES.join(", ")}.`,
    });
  } else {
    status = rec.status.trim() as CustomThemeRequestStatus;
  }

  const reason = validateOperatorReasonField(rec.reason, fields);

  let operatorNotes: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(rec, "operatorNotes")) {
    if (rec.operatorNotes === null || rec.operatorNotes === "") {
      operatorNotes = null;
    } else if (typeof rec.operatorNotes !== "string") {
      fields.push({
        field: "operatorNotes",
        code: "INVALID_TYPE",
        message: "Catatan operator harus berupa teks.",
      });
    } else {
      const cleaned = rec.operatorNotes.trim();
      if (
        cleaned.length > CUSTOM_THEME_MAX_OPERATOR_NOTES_LENGTH ||
        hasDisallowedControlChars(cleaned, true)
      ) {
        fields.push({
          field: "operatorNotes",
          code: "INVALID_LENGTH",
          message: `Catatan operator maksimal ${CUSTOM_THEME_MAX_OPERATOR_NOTES_LENGTH} karakter.`,
        });
      } else {
        operatorNotes = cleaned.length > 0 ? cleaned : null;
      }
    }
  }

  let deliveredThemeId: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(rec, "deliveredThemeId")) {
    if (rec.deliveredThemeId === null || rec.deliveredThemeId === "") {
      deliveredThemeId = null;
    } else if (typeof rec.deliveredThemeId !== "string") {
      fields.push({
        field: "deliveredThemeId",
        code: "INVALID_TYPE",
        message: "ID tema kustom harus berupa teks.",
      });
    } else {
      const cleaned = rec.deliveredThemeId.trim().toLowerCase();
      if (!THEME_ID_RE.test(cleaned)) {
        fields.push({
          field: "deliveredThemeId",
          code: "INVALID_THEME_ID",
          message: "Format ID tema kustom tidak valid.",
        });
      } else {
        deliveredThemeId = cleaned;
      }
    }
  }

  let staffUserEmail: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(rec, "staffUserEmail")) {
    if (rec.staffUserEmail === null || rec.staffUserEmail === "") {
      staffUserEmail = null;
    } else if (typeof rec.staffUserEmail !== "string") {
      fields.push({
        field: "staffUserEmail",
        code: "INVALID_STAFF_EMAIL",
        message: "Email akun Tim Setup harus berupa teks.",
      });
    } else {
      const cleaned = rec.staffUserEmail.trim().toLowerCase();
      if (
        cleaned.length > 254 ||
        hasDisallowedControlChars(cleaned, false) ||
        !SIMPLE_STAFF_EMAIL_RE.test(cleaned)
      ) {
        fields.push({
          field: "staffUserEmail",
          code: "INVALID_STAFF_EMAIL",
          message: "Format email akun Tim Setup tidak valid.",
        });
      } else {
        staffUserEmail = cleaned;
      }
    }
  }

  let staffUserId: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(rec, "staffUserId")) {
    if (rec.staffUserId === null || rec.staffUserId === "") {
      staffUserId = null;
    } else if (typeof rec.staffUserId !== "string") {
      fields.push({
        field: "staffUserId",
        code: "INVALID_TYPE",
        message: "ID akun Tim Setup harus berupa teks.",
      });
    } else {
      const cleaned = rec.staffUserId.trim();
      if (cleaned.length < 4 || cleaned.length > 64 || hasDisallowedControlChars(cleaned, false)) {
        fields.push({
          field: "staffUserId",
          code: "INVALID_VALUE",
          message: "Format ID akun Tim Setup tidak valid.",
        });
      } else {
        staffUserId = cleaned;
      }
    }
  }

  if (serviceKind === "custom_theme") {
    if (status === "delivered" && !deliveredThemeId) {
      fields.push({
        field: "deliveredThemeId",
        code: "THEME_GRANT_REQUIRED",
        message:
          "Menandai permintaan sebagai diserahkan (delivered) wajib menautkan ID tema kustom yang sudah diberikan izin ke tenant ini.",
      });
    }
  } else if (serviceKind === "setup" && deliveredThemeId) {
    fields.push({
      field: "deliveredThemeId",
      code: "VALIDATION_ERROR",
      message: "Permintaan Layanan Terima Beres tidak menggunakan tautan izin tema kustom.",
    });
  }

  if (fields.length > 0) {
    const code =
      serviceKind === "custom_theme" &&
      status === "delivered" &&
      fields.some((f) => f.code === "THEME_GRANT_REQUIRED")
        ? "THEME_GRANT_REQUIRED"
        : fields.some((f) => f.code === "INVALID_STAFF_EMAIL")
          ? "INVALID_STAFF_EMAIL"
          : fields.some((f) => f.code === "INVALID_REASON") && fields.length === 1
            ? "INVALID_REASON"
            : "VALIDATION_ERROR";
    throw new CustomThemeValidationError(
      code,
      fields[0]?.message ?? "Transisi status permintaan tidak valid.",
      fields,
    );
  }

  return {
    expectedVersion,
    status,
    reason,
    ...(operatorNotes !== undefined ? { operatorNotes } : {}),
    ...(deliveredThemeId !== undefined ? { deliveredThemeId } : {}),
    ...(staffUserEmail !== undefined ? { staffUserEmail } : {}),
    ...(staffUserId !== undefined ? { staffUserId } : {}),
  };
}

/**
 * Strict Zod v4 schema for Terima Beres setup service request creation
 * (`POST /api/tenants/:tenantId/service-requests`; REQ-070, TASK-069).
 */
export const SetupServiceRequestCreateSchema = z
  .object({
    packageId: z.string().nullable().optional(),
    brandName: z.string(),
    brief: z.string(),
    referenceUrls: z.array(z.string()).optional(),
    budgetRange: z.string().nullable().optional(),
    contactPreference: z.enum(CONTACT_PREFERENCES).optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict();

export function validateCreateSetupServiceRequestInput(
  rawInput: unknown,
  options: { readonly headerIdempotencyKey?: string | null } = {},
): ValidatedCreateCustomThemeRequestInput {
  const parsed = SetupServiceRequestCreateSchema.safeParse(rawInput);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const isUnrecognized = firstIssue?.code === "unrecognized_keys";
    const fieldName = firstIssue?.path.length ? String(firstIssue.path.join(".")) : "body";
    throw new CustomThemeValidationError(
      isUnrecognized ? "UNKNOWN_FIELD" : "VALIDATION_ERROR",
      isUnrecognized
        ? `Field tidak dikenal pada permintaan Layanan Terima Beres.`
        : "Periksa kembali isian formulir permintaan Layanan Terima Beres.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.length ? String(issue.path.join(".")) : fieldName,
        code: issue.code === "unrecognized_keys" ? "UNKNOWN_FIELD" : "VALIDATION_ERROR",
        message: issue.message,
      })),
    );
  }
  return validateCreateCustomThemeRequestInput(parsed.data, {
    headerIdempotencyKey: options.headerIdempotencyKey,
    serviceKind: "setup",
  });
}

export const SETUP_STAFF_ACCESS_ACTIONS = ["approve", "revoke"] as const;
export type SetupStaffAccessAction = (typeof SETUP_STAFF_ACCESS_ACTIONS)[number];

/**
 * Strict Zod v4 schema for owner approval/revocation of Terima Beres staff editor access
 * (`POST /api/tenants/:tenantId/service-requests/:requestId/staff-access`; REQ-070, TASK-069).
 */
export const SetupStaffAccessActionSchema = z
  .object({
    action: z.enum(SETUP_STAFF_ACCESS_ACTIONS),
    expectedVersion: z.number().int().min(1),
    reason: z.string().max(CUSTOM_THEME_MAX_REASON_LENGTH).optional(),
  })
  .strict();

export interface ValidatedSetupStaffAccessActionInput {
  readonly action: SetupStaffAccessAction;
  readonly expectedVersion: number;
  readonly reason: string | null;
}

export function validateSetupStaffAccessActionInput(
  rawInput: unknown,
): ValidatedSetupStaffAccessActionInput {
  const parsed = SetupStaffAccessActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const isUnrecognized = firstIssue?.code === "unrecognized_keys";
    throw new CustomThemeValidationError(
      isUnrecognized ? "UNKNOWN_FIELD" : "VALIDATION_ERROR",
      isUnrecognized
        ? "Field tidak dikenal pada aksi persetujuan Tim Setup."
        : "Payload aksi akses Tim Setup tidak valid.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.length ? String(issue.path.join(".")) : "body",
        code: issue.code === "unrecognized_keys" ? "UNKNOWN_FIELD" : "VALIDATION_ERROR",
        message: issue.message,
      })),
    );
  }

  let cleanReason: string | null = null;
  if (parsed.data.reason !== undefined) {
    const trimmed = parsed.data.reason.trim();
    if (trimmed.length > 0) {
      if (hasDisallowedControlChars(trimmed, false)) {
        throw new CustomThemeValidationError(
          "VALIDATION_ERROR",
          "Alasan tidak boleh mengandung karakter kontrol.",
          [
            {
              field: "reason",
              code: "CONTROL_CHARACTER",
              message: "Alasan tidak boleh mengandung karakter kontrol.",
            },
          ],
        );
      }
      cleanReason = trimmed;
    }
  }

  return {
    action: parsed.data.action,
    expectedVersion: parsed.data.expectedVersion,
    reason: cleanReason,
  };
}
