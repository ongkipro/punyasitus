import { z } from "zod";
import { resolveBusinessCategoryDefinition } from "../business-profile/categories.ts";
import { ExternalLinkValidationError, sanitizeExternalLink } from "../link-sanitizer.ts";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, SlugSchema } from "../schemas/common.ts";
import { normalizeIndonesianWhatsAppNumber, WhatsAppValidationError } from "../wa-dispatcher.ts";

/**
 * Tenant-Defined Custom Forms Domain Contracts & Strict Zod v4 Schemas
 * (`packages/core/src/forms/schema.ts`; REQ-080, PLAN §19.2, TASK-080).
 *
 * Hard Invariants:
 * - Max 10 forms per website (`MAX_FORMS_PER_TENANT = 10`).
 * - Max 12 fields per form (`MAX_FIELDS_PER_FORM = 12`), min 1 field.
 * - Closed field type list (10 types): NO file uploads, NO hidden fields, NO payment, NO quiz, NO multi-page.
 * - Vertical list ordering only (no drag-and-drop metadata).
 * - Strict 1-level conditional visibility (`fieldKey == equalsValue`); chained or circular conditions rejected.
 * - Publishing requires non-empty `business_profile.privacy_contact`; health categories surface UU PDP warning.
 * - All schemas use `.strict()` so unknown/unsupported properties fail closed with `422 VALIDATION_ERROR`.
 */

export const MAX_FORMS_PER_TENANT = 10 as const;
export const MAX_FIELDS_PER_FORM = 12 as const;
export const MIN_FIELDS_PER_FORM = 1 as const;
export const MAX_FORM_OPTIONS = 20 as const;
export const MAX_FORM_NAME_LENGTH = 100 as const;
export const MAX_FORM_DESCRIPTION_LENGTH = 500 as const;
export const MAX_FORM_SUBMIT_LABEL_LENGTH = 60 as const;
export const MAX_FIELD_KEY_LENGTH = 48 as const;
export const MAX_FIELD_LABEL_LENGTH = 120 as const;
export const MAX_FIELD_PLACEHOLDER_LENGTH = 160 as const;
export const MAX_FIELD_HELP_TEXT_LENGTH = 240 as const;
export const MAX_OPTION_LENGTH = 120 as const;
export const MAX_AFTER_SUBMIT_MESSAGE_LENGTH = 500 as const;
export const MAX_WA_INTRO_LENGTH = 300 as const;

export const CLOSED_FORM_FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "email",
  "phone_id",
  "select",
  "radio",
  "checkbox_group",
  "consent_checkbox",
  "date",
] as const;

export type CustomFormFieldType = (typeof CLOSED_FORM_FIELD_TYPES)[number];

export const FORM_FIELD_TYPE_LABELS_ID: Readonly<Record<CustomFormFieldType, string>> = {
  short_text: "Teks Singkat",
  long_text: "Teks Panjang",
  number: "Angka",
  email: "Email",
  phone_id: "Nomor WhatsApp / HP Indonesia",
  select: "Pilihan Dropdown",
  radio: "Pilihan Tunggal (Radio)",
  checkbox_group: "Pilihan Ganda (Checkbox)",
  consent_checkbox: "Centang Persetujuan",
  date: "Tanggal",
};

export const CHOICE_FIELD_TYPES: ReadonlySet<CustomFormFieldType> = new Set([
  "select",
  "radio",
  "checkbox_group",
]);

export const AFTER_SUBMIT_ACTIONS = ["text", "whatsapp", "url"] as const;
export type AfterSubmitAction = (typeof AFTER_SUBMIT_ACTIONS)[number];

export const AFTER_SUBMIT_ACTION_LABELS_ID: Readonly<Record<AfterSubmitAction, string>> = {
  text: "Tampilkan Teks Konfirmasi",
  whatsapp: "Lanjut ke WhatsApp dengan Ringkasan Jawaban",
  url: "Arahkan ke Tautan (URL)",
};

export const HEALTH_CATEGORY_UUPDP_WARNING_ID =
  "Kategori usaha kesehatan termasuk data pribadi spesifik menurut UU PDP (UU No. 27 Tahun 2022). Jangan meminta diagnosis medis, keluhan penyakit sensitif, atau rekam medis melalui formulir web publik; kumpulkan data kontak dan penjadwalan saja." as const;

export const RESERVED_FORM_FIELD_KEYS: ReadonlySet<string> = new Set([
  ...FORBIDDEN_TENANT_SELECTOR_KEYS.map((k) => k.toLowerCase()),
  "__proto__",
  "constructor",
  "prototype",
  "formslug",
  "form_slug",
  "formid",
  "form_id",
  "answers",
  "customfields",
  "custom_fields",
  "idempotencykey",
  "idempotency_key",
  "returnto",
  "return_to",
  "sourcepath",
  "source_path",
  "pagepath",
  "page_path",
  "sourcecategory",
  "source_category",
  "utm",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "privacyconsent",
  "privacy_consent",
  "honeypot",
  "hp_website",
  "_hp_field",
  "website_url",
  "cf-turnstile-response",
  "turnstiletoken",
]);

export const FIELD_KEY_REGEX = /^[a-z][a-z0-9_]{0,47}$/;
const SAFE_RELATIVE_REDIRECT_RE = /^\/[A-Za-z0-9/_\-.~%]*$/;
const PATH_TRAVERSAL_RE = /(?:^|\/)\.\.(?:\/|$)/;

export interface FormValidationIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export function hasDisallowedFormControlChars(value: string, allowMultiline: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
    if (code <= 0x1f) {
      if (allowMultiline && (code === 0x09 || code === 0x0a || code === 0x0d)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Returns `true` when the tenant's business category belongs to the regulated health vertical
 * (`medical_clinic`, `dentist`, `health_and_beauty`) where UU PDP sensitive-data warnings apply.
 */
export function isHealthSensitiveBusinessCategory(rawCategory: string | null | undefined): boolean {
  if (!rawCategory || !rawCategory.trim()) return false;
  const def = resolveBusinessCategoryDefinition(rawCategory);
  return def.credentialGroup === "regulated_health";
}

/**
 * Validates an after-submit redirect URL: allows ONLY a public HTTPS URL (via `sanitizeExternalLink`,
 * blocking `javascript:`, `data:`, `http:`, credentials, loopback/private IPs) OR a clean same-site
 * relative path (`^/[A-Za-z0-9/_\-.~%]*$`, no `//`, no `..`).
 */
export function validateSafeAfterSubmitUrl(
  rawUrl: string,
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string } {
  if (typeof rawUrl !== "string" || hasDisallowedFormControlChars(rawUrl, false)) {
    return { ok: false, message: "Tautan tujuan tidak boleh mengandung karakter kontrol." };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, message: "Tautan tujuan wajib diisi untuk aksi redirect URL." };
  }

  // Allow safe relative same-site path (e.g. "/terima-kasih")
  if (trimmed.startsWith("/")) {
    if (
      trimmed.length > 256 ||
      trimmed.startsWith("//") ||
      !SAFE_RELATIVE_REDIRECT_RE.test(trimmed) ||
      PATH_TRAVERSAL_RE.test(trimmed)
    ) {
      return {
        ok: false,
        message: "Path relatif tujuan harus diawali satu '/' dan tanpa karakter berbahaya.",
      };
    }
    try {
      const decoded = decodeURIComponent(trimmed);
      if (
        hasDisallowedFormControlChars(decoded, false) ||
        /["'<>\\]/.test(decoded) ||
        PATH_TRAVERSAL_RE.test(decoded)
      ) {
        return { ok: false, message: "Path relatif tujuan tidak valid." };
      }
    } catch {
      return { ok: false, message: "Encoding path relatif tujuan tidak valid." };
    }
    return { ok: true, url: trimmed };
  }

  // Otherwise MUST be a public HTTPS URL (blocks javascript:, data:, http:, localhost, private IPs)
  try {
    const sanitized = sanitizeExternalLink(trimmed);
    return { ok: true, url: sanitized.href };
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof ExternalLinkValidationError
          ? "Tautan tujuan harus berupa URL HTTPS publik yang valid atau path internal situs (contoh: /terima-kasih)."
          : "Format tautan tujuan tidak valid.",
    };
  }
}

export const FormFieldConditionSchema = z
  .object({
    fieldKey: z
      .string()
      .trim()
      .regex(FIELD_KEY_REGEX, "Kunci field kondisi harus berupa huruf kecil, angka, atau garis bawah."),
    equalsValue: z
      .string()
      .trim()
      .min(1, "Nilai kondisi wajib diisi.")
      .max(MAX_OPTION_LENGTH, `Nilai kondisi maksimal ${MAX_OPTION_LENGTH} karakter.`),
  })
  .strict();

export type FormFieldCondition = z.infer<typeof FormFieldConditionSchema>;

export const CustomFormFieldSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1, "Kunci field wajib diisi.")
      .max(MAX_FIELD_KEY_LENGTH, `Kunci field maksimal ${MAX_FIELD_KEY_LENGTH} karakter.`)
      .regex(
        FIELD_KEY_REGEX,
        "Kunci field harus diawali huruf kecil dan hanya berisi huruf kecil, angka, atau garis bawah (_).",
      ),
    type: z.enum(CLOSED_FORM_FIELD_TYPES),
    label: z
      .string()
      .trim()
      .min(1, "Label field wajib diisi.")
      .max(MAX_FIELD_LABEL_LENGTH, `Label field maksimal ${MAX_FIELD_LABEL_LENGTH} karakter.`),
    required: z.boolean(),
    placeholder: z
      .string()
      .trim()
      .max(MAX_FIELD_PLACEHOLDER_LENGTH, `Placeholder maksimal ${MAX_FIELD_PLACEHOLDER_LENGTH} karakter.`)
      .nullable()
      .optional(),
    helpText: z
      .string()
      .trim()
      .max(MAX_FIELD_HELP_TEXT_LENGTH, `Teks bantuan maksimal ${MAX_FIELD_HELP_TEXT_LENGTH} karakter.`)
      .nullable()
      .optional(),
    options: z
      .array(
        z
          .string()
          .trim()
          .min(1, "Opsi pilihan tidak boleh kosong.")
          .max(MAX_OPTION_LENGTH, `Setiap opsi maksimal ${MAX_OPTION_LENGTH} karakter.`),
      )
      .max(MAX_FORM_OPTIONS, `Maksimal ${MAX_FORM_OPTIONS} opsi pilihan per field.`)
      .optional(),
    min: z.number().finite().nullable().optional(),
    max: z.number().finite().nullable().optional(),
    condition: FormFieldConditionSchema.nullable().optional(),
  })
  .strict();

export type CustomFormField = z.infer<typeof CustomFormFieldSchema>;

export const AfterSubmitConfigSchema = z
  .object({
    message: z
      .string()
      .trim()
      .max(
        MAX_AFTER_SUBMIT_MESSAGE_LENGTH,
        `Pesan konfirmasi maksimal ${MAX_AFTER_SUBMIT_MESSAGE_LENGTH} karakter.`,
      )
      .optional(),
    whatsappPhoneOverride: z.string().trim().max(32).nullable().optional(),
    whatsappIntro: z
      .string()
      .trim()
      .max(MAX_WA_INTRO_LENGTH, `Teks pembuka WhatsApp maksimal ${MAX_WA_INTRO_LENGTH} karakter.`)
      .nullable()
      .optional(),
    redirectUrl: z.string().trim().max(2048).nullable().optional(),
  })
  .strict();

export type AfterSubmitConfig = z.infer<typeof AfterSubmitConfigSchema>;

export const CustomFormDraftInputSchema = z
  .object({
    slug: SlugSchema,
    name: z
      .string()
      .trim()
      .min(1, "Nama formulir wajib diisi.")
      .max(MAX_FORM_NAME_LENGTH, `Nama formulir maksimal ${MAX_FORM_NAME_LENGTH} karakter.`),
    description: z
      .string()
      .trim()
      .max(
        MAX_FORM_DESCRIPTION_LENGTH,
        `Deskripsi formulir maksimal ${MAX_FORM_DESCRIPTION_LENGTH} karakter.`,
      )
      .nullable()
      .optional(),
    submitLabel: z
      .string()
      .trim()
      .min(1, "Label tombol kirim tidak boleh kosong.")
      .max(
        MAX_FORM_SUBMIT_LABEL_LENGTH,
        `Label tombol kirim maksimal ${MAX_FORM_SUBMIT_LABEL_LENGTH} karakter.`,
      )
      .optional(),
    templateKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{1,48}$/)
      .nullable()
      .optional(),
    fields: z
      .array(CustomFormFieldSchema)
      .min(MIN_FIELDS_PER_FORM, "Formulir harus memiliki minimal 1 field.")
      .max(MAX_FIELDS_PER_FORM, `Maksimal ${MAX_FIELDS_PER_FORM} field per formulir.`),
    afterSubmitAction: z.enum(AFTER_SUBMIT_ACTIONS),
    afterSubmitConfig: AfterSubmitConfigSchema,
    active: z.boolean().optional(),
  })
  .strict();

export type CustomFormDraftInput = z.infer<typeof CustomFormDraftInputSchema>;

export interface NormalizedCustomFormDefinition {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly submitLabel: string;
  readonly templateKey: string | null;
  readonly fields: readonly CustomFormField[];
  readonly afterSubmitAction: AfterSubmitAction;
  readonly afterSubmitConfig: {
    readonly message: string;
    readonly whatsappPhoneOverride: string | null;
    readonly whatsappIntro: string | null;
    readonly redirectUrl: string | null;
  };
  readonly active: boolean;
}

export const PublishedFormDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    formId: z.number().int().positive(),
    slug: SlugSchema,
    name: z.string().min(1).max(MAX_FORM_NAME_LENGTH),
    description: z.string().max(MAX_FORM_DESCRIPTION_LENGTH).nullable(),
    submitLabel: z.string().min(1).max(MAX_FORM_SUBMIT_LABEL_LENGTH),
    templateKey: z.string().max(48).nullable(),
    fields: z.array(CustomFormFieldSchema).min(MIN_FIELDS_PER_FORM).max(MAX_FIELDS_PER_FORM),
    afterSubmitAction: z.enum(AFTER_SUBMIT_ACTIONS),
    afterSubmitConfig: z
      .object({
        message: z.string().max(MAX_AFTER_SUBMIT_MESSAGE_LENGTH),
        whatsappPhoneOverride: z.string().max(20).nullable(),
        whatsappIntro: z.string().max(MAX_WA_INTRO_LENGTH).nullable(),
        redirectUrl: z.string().max(2048).nullable(),
      })
      .strict(),
    publishedVersion: z.number().int().positive(),
    publishedAt: z.string().min(1),
  })
  .strict();

export type PublishedFormDefinition = z.infer<typeof PublishedFormDefinitionSchema>;

export const CustomFormLeadAnswerSnapshotSchema = z
  .object({
    key: z.string().min(1).max(MAX_FIELD_KEY_LENGTH),
    label: z.string().min(1).max(MAX_FIELD_LABEL_LENGTH),
    type: z.enum(CLOSED_FORM_FIELD_TYPES),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).nullable(),
    displayValue: z.string().max(2400),
  })
  .strict();

export type CustomFormLeadAnswerSnapshot = z.infer<typeof CustomFormLeadAnswerSnapshotSchema>;

export const CustomFormLeadSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    formId: z.number().int().positive(),
    formSlug: SlugSchema,
    formName: z.string().min(1).max(MAX_FORM_NAME_LENGTH),
    publishedVersion: z.number().int().positive(),
    submittedAt: z.string().min(1),
    answers: z.array(CustomFormLeadAnswerSnapshotSchema).max(MAX_FIELDS_PER_FORM),
  })
  .strict();

export type CustomFormLeadSnapshot = z.infer<typeof CustomFormLeadSnapshotSchema>;

export const DEFAULT_CONFIRMATION_MESSAGE_ID =
  "Terima kasih! Formulir Anda telah kami terima. Tim kami akan segera menindaklanjuti." as const;

export const DEFAULT_SUBMIT_LABEL_ID = "Kirim Formulir" as const;

export type ValidateFormDefinitionResult =
  | { readonly ok: true; readonly data: NormalizedCustomFormDefinition }
  | { readonly ok: false; readonly message: string; readonly issues: readonly FormValidationIssue[] };

/**
 * Strictly validates and normalizes a custom form draft/publish payload:
 * - Enforces Zod `.strict()` schema (rejecting unknown keys, unsupported field types like `file`/`hidden`).
 * - Enforces <= 12 fields, unique keys, no reserved transport keys, no control characters.
 * - Enforces choice options rules and numeric `min <= max`.
 * - Enforces strict **1-level** conditional visibility (`fieldKey == equalsValue`):
 *   - No self-reference, no missing target, no chained/nested conditions (target MUST NOT have its own condition),
 *   - Target value matches target options when target is choice or consent_checkbox.
 * - Validates `afterSubmitConfig` strictly per `afterSubmitAction` (`text`, `whatsapp`, `url`).
 */
export function validateFormDefinition(rawInput: unknown): ValidateFormDefinitionResult {
  const parsed = CustomFormDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues: FormValidationIssue[] = parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "form",
      code: issue.code.toUpperCase(),
      message: issue.message,
    }));
    return {
      ok: false,
      message: "Konfigurasi formulir tidak valid. Periksa kembali isian yang ditandai.",
      issues,
    };
  }

  const input = parsed.data;
  const issues: FormValidationIssue[] = [];

  if (hasDisallowedFormControlChars(input.name, false)) {
    issues.push({
      field: "name",
      code: "CONTROL_CHARACTERS",
      message: "Nama formulir tidak boleh mengandung karakter kontrol atau baris baru.",
    });
  }
  if (input.description && hasDisallowedFormControlChars(input.description, true)) {
    issues.push({
      field: "description",
      code: "CONTROL_CHARACTERS",
      message: "Deskripsi formulir mengandung karakter kontrol yang tidak diizinkan.",
    });
  }
  const submitLabel = input.submitLabel?.trim() || DEFAULT_SUBMIT_LABEL_ID;
  if (hasDisallowedFormControlChars(submitLabel, false)) {
    issues.push({
      field: "submitLabel",
      code: "CONTROL_CHARACTERS",
      message: "Label tombol kirim tidak boleh mengandung karakter kontrol.",
    });
  }

  // First pass: check individual fields, keys, options, min/max
  const fieldByKey = new Map<string, CustomFormField>();
  const normalizedFields: CustomFormField[] = [];

  for (let i = 0; i < input.fields.length; i += 1) {
    const f = input.fields[i]!;
    const prefix = `fields.${i}`;

    if (RESERVED_FORM_FIELD_KEYS.has(f.key.toLowerCase())) {
      issues.push({
        field: `${prefix}.key`,
        code: "RESERVED_FIELD_KEY",
        message: `Kunci field "${f.key}" dicadangkan oleh sistem dan tidak dapat digunakan.`,
      });
    } else if (fieldByKey.has(f.key)) {
      issues.push({
        field: `${prefix}.key`,
        code: "DUPLICATE_FIELD_KEY",
        message: `Kunci field "${f.key}" sudah digunakan oleh field lain di formulir ini.`,
      });
    }

    if (hasDisallowedFormControlChars(f.label, false)) {
      issues.push({
        field: `${prefix}.label`,
        code: "CONTROL_CHARACTERS",
        message: "Label field tidak boleh mengandung karakter kontrol atau baris baru.",
      });
    }
    if (f.placeholder && hasDisallowedFormControlChars(f.placeholder, false)) {
      issues.push({
        field: `${prefix}.placeholder`,
        code: "CONTROL_CHARACTERS",
        message: "Placeholder tidak boleh mengandung karakter kontrol.",
      });
    }
    if (f.helpText && hasDisallowedFormControlChars(f.helpText, false)) {
      issues.push({
        field: `${prefix}.helpText`,
        code: "CONTROL_CHARACTERS",
        message: "Teks bantuan tidak boleh mengandung karakter kontrol.",
      });
    }

    let cleanedOptions: string[] | undefined;
    if (CHOICE_FIELD_TYPES.has(f.type)) {
      const minOpts = f.type === "checkbox_group" ? 1 : 2;
      const rawOpts = f.options ?? [];
      if (rawOpts.length < minOpts) {
        issues.push({
          field: `${prefix}.options`,
          code: "INSUFFICIENT_OPTIONS",
          message: `Field tipe "${FORM_FIELD_TYPE_LABELS_ID[f.type]}" membutuhkan minimal ${minOpts} pilihan.`,
        });
      }
      const seenOpts = new Set<string>();
      cleanedOptions = [];
      for (let oi = 0; oi < rawOpts.length; oi += 1) {
        const opt = rawOpts[oi]!;
        if (hasDisallowedFormControlChars(opt, false)) {
          issues.push({
            field: `${prefix}.options.${oi}`,
            code: "CONTROL_CHARACTERS",
            message: "Teks pilihan tidak boleh mengandung karakter kontrol.",
          });
          continue;
        }
        const lowered = opt.toLowerCase();
        if (seenOpts.has(lowered)) {
          issues.push({
            field: `${prefix}.options.${oi}`,
            code: "DUPLICATE_OPTION",
            message: `Opsi pilihan "${opt}" tidak boleh duplikat.`,
          });
          continue;
        }
        seenOpts.add(lowered);
        cleanedOptions.push(opt);
      }
    } else if (f.options && f.options.length > 0) {
      issues.push({
        field: `${prefix}.options`,
        code: "UNEXPECTED_OPTIONS",
        message: `Field tipe "${FORM_FIELD_TYPE_LABELS_ID[f.type]}" tidak mendukung daftar opsi.`,
      });
    }

    if (f.type === "number") {
      if (
        typeof f.min === "number" &&
        typeof f.max === "number" &&
        f.min > f.max
      ) {
        issues.push({
          field: `${prefix}.max`,
          code: "INVALID_RANGE",
          message: "Nilai maksimum angka tidak boleh lebih kecil dari nilai minimum.",
        });
      }
    } else if (f.min !== undefined && f.min !== null) {
      issues.push({
        field: `${prefix}.min`,
        code: "UNEXPECTED_MIN_MAX",
        message: "Batas minimum hanya berlaku untuk field tipe Angka.",
      });
    } else if (f.max !== undefined && f.max !== null) {
      issues.push({
        field: `${prefix}.max`,
        code: "UNEXPECTED_MIN_MAX",
        message: "Batas maksimum hanya berlaku untuk field tipe Angka.",
      });
    }

    const normalizedField: CustomFormField = {
      key: f.key,
      type: f.type,
      label: f.label,
      required: f.required,
      placeholder: f.placeholder && f.placeholder.length > 0 ? f.placeholder : null,
      helpText: f.helpText && f.helpText.length > 0 ? f.helpText : null,
      ...(cleanedOptions ? { options: cleanedOptions } : {}),
      ...(f.type === "number" && typeof f.min === "number" ? { min: f.min } : {}),
      ...(f.type === "number" && typeof f.max === "number" ? { max: f.max } : {}),
      condition: f.condition ?? null,
    };

    fieldByKey.set(normalizedField.key, normalizedField);
    normalizedFields.push(normalizedField);
  }

  // Second pass: enforce STRICT 1-level conditional visibility (`fieldKey == equalsValue`)
  for (let i = 0; i < normalizedFields.length; i += 1) {
    const f = normalizedFields[i]!;
    if (!f.condition) continue;
    const prefix = `fields.${i}.condition`;

    if (hasDisallowedFormControlChars(f.condition.equalsValue, false)) {
      issues.push({
        field: `${prefix}.equalsValue`,
        code: "CONTROL_CHARACTERS",
        message: "Nilai kondisi tidak boleh mengandung karakter kontrol.",
      });
    }

    if (f.condition.fieldKey === f.key) {
      issues.push({
        field: `${prefix}.fieldKey`,
        code: "SELF_CONDITION",
        message: "Field tidak boleh bergantung pada dirinya sendiri.",
      });
      continue;
    }

    const target = fieldByKey.get(f.condition.fieldKey);
    if (!target) {
      issues.push({
        field: `${prefix}.fieldKey`,
        code: "UNKNOWN_CONDITION_TARGET",
        message: `Field acuan kondisi "${f.condition.fieldKey}" tidak ditemukan pada formulir ini.`,
      });
      continue;
    }

    // Strict 1-level rule: target field MUST NOT have its own condition (prevents chaining/cycles!)
    if (target.condition) {
      issues.push({
        field: `${prefix}.fieldKey`,
        code: "NESTED_CONDITION_FORBIDDEN",
        message:
          "Kondisi tampilan hanya mendukung 1 tingkat. Field acuan tidak boleh memiliki kondisi lanjutan.",
      });
      continue;
    }

    if (target.type === "long_text") {
      issues.push({
        field: `${prefix}.fieldKey`,
        code: "INVALID_CONDITION_TARGET_TYPE",
        message: "Field Teks Panjang tidak dapat digunakan sebagai acuan kondisi.",
      });
      continue;
    }

    if (CHOICE_FIELD_TYPES.has(target.type)) {
      const targetOpts = target.options ?? [];
      if (!targetOpts.includes(f.condition.equalsValue)) {
        issues.push({
          field: `${prefix}.equalsValue`,
          code: "INVALID_CONDITION_VALUE",
          message: `Nilai kondisi "${f.condition.equalsValue}" harus sesuai dengan salah satu opsi pada field "${target.label}".`,
        });
      }
    } else if (target.type === "consent_checkbox") {
      if (f.condition.equalsValue !== "true" && f.condition.equalsValue !== "false") {
        issues.push({
          field: `${prefix}.equalsValue`,
          code: "INVALID_CONDITION_VALUE",
          message: 'Nilai kondisi untuk field persetujuan harus "true" atau "false".',
        });
      }
    }
  }

  // Validate after-submit config strictly per action
  const rawAfter = input.afterSubmitConfig;
  const rawMsg = rawAfter.message?.trim() ?? "";
  if (rawMsg && hasDisallowedFormControlChars(rawMsg, true)) {
    issues.push({
      field: "afterSubmitConfig.message",
      code: "CONTROL_CHARACTERS",
      message: "Pesan setelah kirim mengandung karakter kontrol yang tidak diizinkan.",
    });
  }
  const message = rawMsg || DEFAULT_CONFIRMATION_MESSAGE_ID;

  let whatsappPhoneOverride: string | null = null;
  let whatsappIntro: string | null = null;
  let redirectUrl: string | null = null;

  if (input.afterSubmitAction === "text") {
    if (!rawMsg) {
      issues.push({
        field: "afterSubmitConfig.message",
        code: "REQUIRED",
        message: "Pesan konfirmasi wajib diisi untuk aksi Teks Konfirmasi.",
      });
    }
  } else if (input.afterSubmitAction === "whatsapp") {
    if (rawAfter.whatsappPhoneOverride && rawAfter.whatsappPhoneOverride.trim().length > 0) {
      try {
        whatsappPhoneOverride = normalizeIndonesianWhatsAppNumber(rawAfter.whatsappPhoneOverride);
      } catch (err) {
        issues.push({
          field: "afterSubmitConfig.whatsappPhoneOverride",
          code: "INVALID_PHONE",
          message:
            err instanceof WhatsAppValidationError
              ? "Nomor WhatsApp tujuan harus berupa nomor seluler Indonesia yang valid (08... atau +628...)."
              : "Format nomor WhatsApp tujuan tidak valid.",
        });
      }
    }
    if (rawAfter.whatsappIntro && rawAfter.whatsappIntro.trim().length > 0) {
      if (hasDisallowedFormControlChars(rawAfter.whatsappIntro, true)) {
        issues.push({
          field: "afterSubmitConfig.whatsappIntro",
          code: "CONTROL_CHARACTERS",
          message: "Teks pembuka WhatsApp mengandung karakter kontrol yang tidak diizinkan.",
        });
      } else {
        whatsappIntro = rawAfter.whatsappIntro.trim();
      }
    }
  } else if (input.afterSubmitAction === "url") {
    const rawUrl = rawAfter.redirectUrl?.trim() ?? "";
    const urlCheck = validateSafeAfterSubmitUrl(rawUrl);
    if (!urlCheck.ok) {
      issues.push({
        field: "afterSubmitConfig.redirectUrl",
        code: "INVALID_REDIRECT_URL",
        message: urlCheck.message,
      });
    } else {
      redirectUrl = urlCheck.url;
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      message: "Konfigurasi formulir tidak valid. Periksa kembali isian yang ditandai.",
      issues,
    };
  }

  return {
    ok: true,
    data: {
      slug: input.slug,
      name: input.name,
      description: input.description && input.description.length > 0 ? input.description : null,
      submitLabel,
      templateKey: input.templateKey ?? null,
      fields: normalizedFields,
      afterSubmitAction: input.afterSubmitAction,
      afterSubmitConfig: {
        message,
        whatsappPhoneOverride,
        whatsappIntro,
        redirectUrl,
      },
      active: input.active ?? true,
    },
  };
}
