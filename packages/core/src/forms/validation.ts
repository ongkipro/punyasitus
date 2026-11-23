import { normalizeIndonesianWhatsAppNumber, WhatsAppValidationError } from "../wa-dispatcher.ts";
import {
  hasDisallowedFormControlChars,
  type CustomFormField,
  type CustomFormLeadAnswerSnapshot,
  type CustomFormLeadSnapshot,
  type FormValidationIssue,
  type PublishedFormDefinition,
} from "./schema.ts";

/**
 * Server-Side Custom Form Submission Validator & Immutable Lead Snapshot Builder
 * (`packages/core/src/forms/validation.ts`; REQ-080, PLAN §19.2, TASK-080).
 *
 * Security & Consistency Invariants:
 * - Validates STRICTLY against the published versioned form definition (`PublishedFormDefinition`),
 *   never against unpublished draft edits.
 * - Evaluates 1-level `field == value` visibility conditions on the server in two deterministic passes:
 *   - Hidden fields are NOT required, NOT validated for missing values, and NOT stored in the snapshot.
 *   - Visible required fields MUST be present and valid per their closed field type.
 * - Rejects unknown answer keys (`422 VALIDATION_ERROR`).
 * - Snapshots exact field `label`, `type`, `value`, and `displayValue` into `CustomFormLeadSnapshot`
 *   so editing a form later NEVER alters historical submissions.
 */

const SIMPLE_EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SHORT_TEXT_VALUE_LENGTH = 200 as const;
const MAX_LONG_TEXT_VALUE_LENGTH = 2000 as const;
const MAX_EMAIL_VALUE_LENGTH = 254 as const;

export interface ProjectedLeadSummary {
  readonly name: string;
  readonly phoneE164: string;
  readonly email: string | null;
  readonly message: string;
  readonly preferredDate: string | null;
}

export interface ValidatedCustomFormSubmission {
  readonly snapshot: CustomFormLeadSnapshot;
  readonly projectedLead: ProjectedLeadSummary;
  readonly canonicalAnswers: Record<string, string | number | boolean | readonly string[] | null>;
}

export type ValidateCustomFormSubmissionResult =
  | { readonly ok: true; readonly data: ValidatedCustomFormSubmission }
  | { readonly ok: false; readonly message: string; readonly fields: readonly FormValidationIssue[] };

function isValidIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [yStr, mStr, dStr] = value.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function parseBooleanAnswer(raw: unknown): boolean | null {
  if (raw === true) return true;
  if (raw === false) return false;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true" || normalized === "on" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "off" || normalized === "0" || normalized === "no" || normalized === "") {
      return false;
    }
  }
  return null;
}

function normalizeCheckboxGroupRaw(raw: unknown): readonly string[] | null {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") return null;
      const trimmed = item.trim();
      if (trimmed.length > 0 && !out.includes(trimmed)) {
        out.push(trimmed);
      }
    }
    return out;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    // Support single checked checkbox in urlencoded form POST
    return [trimmed];
  }
  return null;
}

function validateSingleFieldValue(
  field: CustomFormField,
  rawValue: unknown,
  issues: FormValidationIssue[],
): {
  readonly value: string | number | boolean | string[] | null;
  readonly displayValue: string;
} {
  const isMissing =
    rawValue === undefined ||
    rawValue === null ||
    (typeof rawValue === "string" && rawValue.trim().length === 0) ||
    (Array.isArray(rawValue) && rawValue.length === 0);

  switch (field.type) {
    case "short_text": {
      if (isMissing) {
        if (field.required) {
          issues.push({
            field: field.key,
            code: "REQUIRED",
            message: `${field.label} wajib diisi.`,
          });
        }
        return { value: null, displayValue: "" };
      }
      if (typeof rawValue !== "string") {
        issues.push({
          field: field.key,
          code: "INVALID_TYPE",
          message: `${field.label} harus berupa teks.`,
        });
        return { value: null, displayValue: "" };
      }
      if (hasDisallowedFormControlChars(rawValue, false)) {
        issues.push({
          field: field.key,
          code: "CONTROL_CHARACTERS",
          message: `${field.label} tidak boleh mengandung karakter kontrol atau baris baru.`,
        });
        return { value: null, displayValue: "" };
      }
      const trimmed = rawValue.trim();
      if (trimmed.length > MAX_SHORT_TEXT_VALUE_LENGTH) {
        issues.push({
          field: field.key,
          code: "TOO_LONG",
          message: `${field.label} maksimal ${MAX_SHORT_TEXT_VALUE_LENGTH} karakter.`,
        });
        return { value: null, displayValue: "" };
      }
      return { value: trimmed, displayValue: trimmed };
    }

    case "long_text": {
      if (isMissing) {
        if (field.required) {
          issues.push({
            field: field.key,
            code: "REQUIRED",
            message: `${field.label} wajib diisi.`,
          });
        }
        return { value: null, displayValue: "" };
      }
      if (typeof rawValue !== "string") {
        issues.push({
          field: field.key,
          code: "INVALID_TYPE",
          message: `${field.label} harus berupa teks.`,
        });
        return { value: null, displayValue: "" };
      }
      if (hasDisallowedFormControlChars(rawValue, true)) {
        issues.push({
          field: field.key,
          code: "CONTROL_CHARACTERS",
          message: `${field.label} mengandung karakter yang tidak diizinkan.`,
        });
        return { value: null, displayValue: "" };
      }
      const trimmed = rawValue.trim();
      if (trimmed.length > MAX_LONG_TEXT_VALUE_LENGTH) {
        issues.push({
          field: field.key,
          code: "TOO_LONG",
          message: `${field.label} maksimal ${MAX_LONG_TEXT_VALUE_LENGTH} karakter.`,
        });
        return { value: null, displayValue: "" };
      }
      return { value: trimmed, displayValue: trimmed };
    }

    case "number": {
      if (isMissing) {
        if (field.required) {
          issues.push({
            field: field.key,
            code: "REQUIRED",
            message: `${field.label} wajib diisi.`,
          });
        }
        return { value: null, displayValue: "" };
      }
      let num: number;
      if (typeof rawValue === "number") {
        num = rawValue;
      } else if (typeof rawValue === "string") {
        const trimmed = rawValue.trim();
        if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
          issues.push({
            field: field.key,
            code: "INVALID_NUMBER",
            message: `${field.label} harus berupa angka yang valid.`,
          });
          return { value: null, displayValue: "" };
        }
        num = Number(trimmed);
      } else {
        issues.push({
          field: field.key,
          code: "INVALID_NUMBER",
          message: `${field.label} harus berupa angka yang valid.`,
        });
        return { value: null, displayValue: "" };
      }
      if (!Number.isFinite(num)) {
        issues.push({
          field: field.key,
          code: "INVALID_NUMBER",
          message: `${field.label} harus berupa angka yang valid.`,
        });
        return { value: null, displayValue: "" };
      }
      if (typeof field.min === "number" && num < field.min) {
        issues.push({
          field: field.key,
          code: "NUMBER_TOO_SMALL",
          message: `${field.label} minimal ${field.min}.`,
        });
        return { value: null, displayValue: "" };
      }
      if (typeof field.max === "number" && num > field.max) {
        issues.push({
          field: field.key,
          code: "NUMBER_TOO_LARGE",
          message: `${field.label} maksimal ${field.max}.`,
        });
        return { value: null, displayValue: "" };
      }
      return { value: num, displayValue: String(num) };
    }

    case "email": {
      if (isMissing) {
        if (field.required) {
          issues.push({
            field: field.key,
            code: "REQUIRED",
            message: `${field.label} wajib diisi.`,
          });
        }
        return { value: null, displayValue: "" };
      }
      if (typeof rawValue !== "string") {
        issues.push({
          field: field.key,
          code: "INVALID_EMAIL",
          message: `${field.label} harus berupa alamat email yang valid.`,
        });
        return { value: null, displayValue: "" };
      }
      const trimmed = rawValue.trim().toLowerCase();
      if (
        trimmed.length > MAX_EMAIL_VALUE_LENGTH ||
        hasDisallowedFormControlChars(trimmed, false) ||
        !SIMPLE_EMAIL_RE.test(trimmed)
      ) {
        issues.push({
          field: field.key,
          code: "INVALID_EMAIL",
          message: `Format ${field.label} tidak valid.`,
        });
        return { value: null, displayValue: "" };
      }
      return { value: trimmed, displayValue: trimmed };
    }

    case "phone_id": {
      if (isMissing) {
        if (field.required) {
          issues.push({
            field: field.key,
            code: "REQUIRED",
            message: `${field.label} wajib diisi.`,
          });
        }
        return { value: null, displayValue: "" };
      }
      if (typeof rawValue !== "string") {
        issues.push({
          field: field.key,
          code: "INVALID_PHONE",
          message: `${field.label} harus berupa nomor WhatsApp Indonesia yang valid.`,
        });
        return { value: null, displayValue: "" };
      }
      try {
        const normalized = normalizeIndonesianWhatsAppNumber(rawValue);
        return { value: normalized, displayValue: `+${normalized}` };
      } catch (err) {
        issues.push({
          field: field.key,
          code: "INVALID_PHONE",
          message:
            err instanceof WhatsAppValidationError
              ? `${field.label} harus berupa nomor seluler Indonesia yang valid (contoh: 081234567890).`
              : `Format ${field.label} tidak valid.`,
        });
        return { value: null, displayValue: "" };
      }
    }

    case "select":
    case "radio": {
      if (isMissing) {
        if (field.required) {
          issues.push({
            field: field.key,
            code: "REQUIRED",
            message: `${field.label} wajib dipilih.`,
          });
        }
        return { value: null, displayValue: "" };
      }
      if (typeof rawValue !== "string") {
        issues.push({
          field: field.key,
          code: "INVALID_OPTION",
          message: `Pilihan untuk ${field.label} tidak valid.`,
        });
        return { value: null, displayValue: "" };
      }
      const trimmed = rawValue.trim();
      const allowed = field.options ?? [];
      if (!allowed.includes(trimmed)) {
        issues.push({
          field: field.key,
          code: "INVALID_OPTION",
          message: `Pilihan "${trimmed}" tidak tersedia untuk ${field.label}.`,
        });
        return { value: null, displayValue: "" };
      }
      return { value: trimmed, displayValue: trimmed };
    }

    case "checkbox_group": {
      const normalized = normalizeCheckboxGroupRaw(rawValue);
      if (normalized === null) {
        issues.push({
          field: field.key,
          code: "INVALID_OPTION",
          message: `Pilihan untuk ${field.label} tidak valid.`,
        });
        return { value: [], displayValue: "" };
      }
      if (normalized.length === 0) {
        if (field.required) {
          issues.push({
            field: field.key,
            code: "REQUIRED",
            message: `Pilih minimal satu opsi untuk ${field.label}.`,
          });
        }
        return { value: [], displayValue: "" };
      }
      const allowed = field.options ?? [];
      for (const item of normalized) {
        if (!allowed.includes(item)) {
          issues.push({
            field: field.key,
            code: "INVALID_OPTION",
            message: `Pilihan "${item}" tidak tersedia untuk ${field.label}.`,
          });
          return { value: [], displayValue: "" };
        }
      }
      const copy = [...normalized];
      return { value: copy, displayValue: copy.join(", ") };
    }

    case "consent_checkbox": {
      const parsed = rawValue === undefined || rawValue === null ? false : parseBooleanAnswer(rawValue);
      if (parsed === null) {
        issues.push({
          field: field.key,
          code: "INVALID_BOOLEAN",
          message: `Nilai persetujuan untuk ${field.label} tidak valid.`,
        });
        return { value: false, displayValue: "Tidak" };
      }
      if (field.required && !parsed) {
        issues.push({
          field: field.key,
          code: "CONSENT_REQUIRED",
          message: `Anda wajib menyetujui: ${field.label}`,
        });
        return { value: false, displayValue: "Tidak" };
      }
      return { value: parsed, displayValue: parsed ? "Ya" : "Tidak" };
    }

    case "date": {
      if (isMissing) {
        if (field.required) {
          issues.push({
            field: field.key,
            code: "REQUIRED",
            message: `${field.label} wajib diisi.`,
          });
        }
        return { value: null, displayValue: "" };
      }
      if (typeof rawValue !== "string" || !isValidIsoCalendarDate(rawValue.trim())) {
        issues.push({
          field: field.key,
          code: "INVALID_DATE",
          message: `${field.label} harus menggunakan format tanggal YYYY-MM-DD yang valid.`,
        });
        return { value: null, displayValue: "" };
      }
      const trimmed = rawValue.trim();
      return { value: trimmed, displayValue: trimmed };
    }
  }
}

/**
 * Evaluates a 1-level visibility condition against already-validated top-level values.
 */
export function isCustomFormFieldVisible(
  field: CustomFormField,
  topLevelValues: ReadonlyMap<string, string | number | boolean | readonly string[] | null>,
): boolean {
  if (!field.condition) return true;
  const targetValue = topLevelValues.get(field.condition.fieldKey);
  if (targetValue === undefined || targetValue === null) return false;
  if (Array.isArray(targetValue)) {
    return targetValue.includes(field.condition.equalsValue);
  }
  if (typeof targetValue === "boolean") {
    return String(targetValue) === field.condition.equalsValue;
  }
  return String(targetValue) === field.condition.equalsValue;
}

/**
 * Validates raw submitted answers against a published versioned custom form definition
 * and builds an immutable `CustomFormLeadSnapshot` + projected `leads` columns.
 */
export function validateCustomFormSubmission(
  publishedDef: PublishedFormDefinition,
  rawAnswers: Readonly<Record<string, unknown>>,
  options: {
    readonly explicitPrivacyConsent?: boolean;
    readonly nowIso?: string;
  } = {},
): ValidateCustomFormSubmissionResult {
  const issues: FormValidationIssue[] = [];
  const declaredKeys = new Set(publishedDef.fields.map((f) => f.key));

  for (const key of Object.keys(rawAnswers)) {
    if (!declaredKeys.has(key)) {
      issues.push({
        field: key,
        code: "UNKNOWN_FIELD",
        message: `Field "${key}" tidak terdaftar pada formulir "${publishedDef.name}".`,
      });
    }
  }

  // Pass 1: validate unconditional top-level fields
  const topLevelValues = new Map<string, string | number | boolean | readonly string[] | null>();
  const validatedByKey = new Map<
    string,
    {
      readonly value: string | number | boolean | string[] | null;
      readonly displayValue: string;
    }
  >();

  for (const field of publishedDef.fields) {
    if (field.condition) continue;
    const res = validateSingleFieldValue(field, rawAnswers[field.key], issues);
    topLevelValues.set(field.key, res.value);
    validatedByKey.set(field.key, res);
  }

  // Pass 2: evaluate 1-level visibility for conditional fields & validate ONLY visible ones
  const visibleAnswers: CustomFormLeadAnswerSnapshot[] = [];
  const canonicalAnswers: Record<string, string | number | boolean | readonly string[] | null> = {};

  for (const field of publishedDef.fields) {
    if (field.condition) {
      const visible = isCustomFormFieldVisible(field, topLevelValues);
      if (!visible) {
        // Hidden conditional field: NOT required, NOT validated, NOT stored!
        continue;
      }
      const res = validateSingleFieldValue(field, rawAnswers[field.key], issues);
      validatedByKey.set(field.key, res);
    }

    const entry = validatedByKey.get(field.key);
    if (!entry) continue;
    visibleAnswers.push({
      key: field.key,
      label: field.label,
      type: field.type,
      value: entry.value,
      displayValue: entry.displayValue,
    });
    canonicalAnswers[field.key] = entry.value;
  }

  // Mandatory UU PDP privacy consent check: ALWAYS requires explicit `privacyConsent` acknowledgement.
  // Custom `consent_checkbox` fields are additional form-specific opt-ins and NEVER bypass UU PDP consent.
  if (!options.explicitPrivacyConsent) {
    issues.push({
      field: "privacyConsent",
      code: "PRIVACY_CONSENT_REQUIRED",
      message: "Anda harus menyetujui pemrosesan data kontak sebelum mengirim formulir.",
    });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      message: "Mohon periksa kembali isian formulir Anda.",
      fields: issues,
    };
  }

  // Project canonical `leads` columns while keeping full tenant labels in `message` & `snapshot`
  const nameAnswer =
    visibleAnswers.find(
      (a) =>
        a.type === "short_text" &&
        typeof a.value === "string" &&
        a.value.length > 0 &&
        /nama|name|pic/i.test(`${a.key} ${a.label}`),
    ) ??
    visibleAnswers.find(
      (a) => a.type === "short_text" && typeof a.value === "string" && a.value.length > 0,
    );
  const phoneAnswer = visibleAnswers.find(
    (a) => a.type === "phone_id" && typeof a.value === "string" && a.value.length > 0,
  );
  const emailAnswer = visibleAnswers.find(
    (a) => a.type === "email" && typeof a.value === "string" && a.value.length > 0,
  );
  const dateAnswer = visibleAnswers.find(
    (a) => a.type === "date" && typeof a.value === "string" && a.value.length > 0,
  );

  const summaryLines: string[] = [`[${publishedDef.name}]`];
  for (const ans of visibleAnswers) {
    if (ans.type === "consent_checkbox") continue;
    if (!ans.displayValue) continue;
    summaryLines.push(`${ans.label}: ${ans.displayValue}`);
  }
  const formattedMessage = summaryLines.join("\n").slice(0, 2000);

  const snapshot: CustomFormLeadSnapshot = {
    schemaVersion: 1,
    formId: publishedDef.formId,
    formSlug: publishedDef.slug,
    formName: publishedDef.name,
    publishedVersion: publishedDef.publishedVersion,
    submittedAt: options.nowIso ?? new Date().toISOString(),
    answers: visibleAnswers,
  };

  return {
    ok: true,
    data: {
      snapshot,
      projectedLead: {
        name:
          (typeof nameAnswer?.value === "string" ? nameAnswer.value : null)?.slice(0, 100) ??
          `Pengirim ${publishedDef.name}`.slice(0, 100),
        phoneE164:
          typeof phoneAnswer?.value === "string" ? phoneAnswer.value : "-",
        email: typeof emailAnswer?.value === "string" ? emailAnswer.value : null,
        message: formattedMessage || `[${publishedDef.name}]`,
        preferredDate: typeof dateAnswer?.value === "string" ? dateAnswer.value : null,
      },
      canonicalAnswers,
    },
  };
}
