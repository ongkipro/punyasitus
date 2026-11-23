import {
  resolveBusinessCategoryDefinition,
  type IndonesianCredentialKey,
} from "./categories.ts";

/**
 * Optional Indonesian Business Licence & Credential Validators (REQ-091, PLAN §19.5 & §19.8).
 *
 * Truthfulness Hard Invariants:
 * - EVERY credential is strictly OPTIONAL.
 * - Platform NEVER fabricates trust badges, verification checkmarks, or unverified claims.
 * - Credentials render truthfully as self-declared factual labels/identifiers matching visible text.
 */

export const CREDENTIAL_TRUTHFULNESS_NOTICE =
  "Semua nomor izin dan sertifikasi bersifat opsional, diisi langsung oleh pemilik situs, dan ditampilkan apa adanya tanpa lencana verifikasi buatan." as const;

export interface IndonesianBusinessCredentials {
  readonly nib?: string | null;
  readonly isoSniTkdn?: string | null;
  readonly skKemenagPpiu?: string | null;
  readonly asitaIata?: string | null;
  readonly sipStr?: string | null;
  readonly barNotaryJurisdiction?: string | null;
  readonly halalBpjh?: string | null;
  readonly pirt?: string | null;
  readonly lkpNpsn?: string | null;
}

export interface CredentialFieldDefinition {
  readonly key: IndonesianCredentialKey;
  readonly labelId: string;
  readonly schemaPropertyId: string;
  readonly placeholder: string;
  readonly helpTextId: string;
  readonly maxLength: number;
}

export const INDONESIAN_CREDENTIAL_DEFINITIONS: Readonly<
  Record<IndonesianCredentialKey, CredentialFieldDefinition>
> = {
  nib: {
    key: "nib",
    labelId: "NIB (Nomor Induk Berusaha)",
    schemaPropertyId: "NIB",
    placeholder: "1234567890123",
    helpTextId: "13 digit angka NIB dari sistem OSS (opsional).",
    maxLength: 20,
  },
  isoSniTkdn: {
    key: "isoSniTkdn",
    labelId: "Sertifikasi ISO / SNI / TKDN / BPOM / SBUJK",
    schemaPropertyId: "Sertifikasi Industri",
    placeholder: "ISO 9001:2015 / SBUJK F.01.02",
    helpTextId: "Nomor standar mutu atau sertifikasi industri yang dimiliki (opsional).",
    maxLength: 80,
  },
  skKemenagPpiu: {
    key: "skKemenagPpiu",
    labelId: "SK Kemenag PPIU / PIHK",
    schemaPropertyId: "SK Kemenag PPIU/PIHK",
    placeholder: "U.123 Tahun 2024",
    helpTextId: "Nomor izin resmi PPIU/PIHK Kemenag RI bagi penyelenggara Umrah/Haji (opsional).",
    maxLength: 80,
  },
  asitaIata: {
    key: "asitaIata",
    labelId: "Keanggotaan ASITA / IATA",
    schemaPropertyId: "ASITA/IATA",
    placeholder: "ASITA 0123/DPP/2024",
    helpTextId: "Nomor keanggotaan asosiasi perjalanan wisata (opsional).",
    maxLength: 48,
  },
  sipStr: {
    key: "sipStr",
    labelId: "Nomor SIP / STR Praktisi",
    schemaPropertyId: "SIP/STR",
    placeholder: "SIP 446/1234/Dinkes/2025",
    helpTextId: "Surat Izin Praktik atau Surat Tanda Registrasi tenaga medis/kesehatan (opsional).",
    maxLength: 64,
  },
  barNotaryJurisdiction: {
    key: "barNotaryJurisdiction",
    labelId: "Nomor Izin Profesi / Wilayah Kerja (PERADI / Notaris / PPAT / IKPI)",
    schemaPropertyId: "Izin Profesi",
    placeholder: "SK Menkumham AHU-123.AH.02.01 / NIA 12.34567",
    helpTextId: "Nomor izin profesi atau wilayah jabatan yang relevan (opsional).",
    maxLength: 100,
  },
  halalBpjh: {
    key: "halalBpjh",
    labelId: "Sertifikat Halal BPJPH",
    schemaPropertyId: "Halal BPJPH",
    placeholder: "ID31110000123450123",
    helpTextId: "Kode sertifikat halal BPJPH (diawali ID diikuti 12–20 digit, opsional).",
    maxLength: 32,
  },
  pirt: {
    key: "pirt",
    labelId: "Nomor P-IRT / SPP-IRT",
    schemaPropertyId: "P-IRT",
    placeholder: "P-IRT 2063171010123-28",
    helpTextId: "Nomor izin pangan industri rumah tangga (opsional).",
    maxLength: 36,
  },
  lkpNpsn: {
    key: "lkpNpsn",
    labelId: "NPSN / Izin Operasional LKP",
    schemaPropertyId: "NPSN/LKP",
    placeholder: "K5667890 / 421.9/123/Disdik",
    helpTextId: "Nomor Pokok Sekolah Nasional atau izin lembaga kursus (opsional).",
    maxLength: 64,
  },
};

export const ALLOWED_CREDENTIAL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(INDONESIAN_CREDENTIAL_DEFINITIONS),
);

export interface CredentialValidationIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface TruthfulCredentialItem {
  readonly key: IndonesianCredentialKey;
  readonly label: string;
  readonly schemaPropertyId: string;
  readonly value: string;
  /** Always `true`: credentials are owner-supplied facts, never platform-verified badges. */
  readonly selfDeclared: true;
  /** Always `false`: platform never fabricates verification badges. */
  readonly verifiedByPlatform: false;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function countDigits(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) count += 1;
  }
  return count;
}

function containsMarkupOrUrl(value: string): boolean {
  return /[<>"'`]|https?:\/\/|javascript:/i.test(value);
}

/**
 * Validates and normalizes a single Indonesian credential value.
 * Returns `{ ok: true, value: string | null }` or `{ ok: false, issue }`.
 */
export function validateSingleCredential(
  key: IndonesianCredentialKey,
  rawValue: unknown,
  fieldPrefix = "businessProfile.credentials",
):
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly issue: CredentialValidationIssue } {
  const field = `${fieldPrefix}.${key}`;
  const def = INDONESIAN_CREDENTIAL_DEFINITIONS[key];

  if (rawValue === null || rawValue === undefined) {
    return { ok: true, value: null };
  }
  if (typeof rawValue !== "string") {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_CREDENTIAL",
        message: `${def.labelId} harus berupa teks.`,
      },
    };
  }
  if (hasControlChars(rawValue)) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_CREDENTIAL",
        message: `${def.labelId} tidak boleh mengandung karakter kontrol.`,
      },
    };
  }

  const trimmed = rawValue.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > def.maxLength) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_CREDENTIAL",
        message: `${def.labelId} maksimal ${def.maxLength} karakter.`,
      },
    };
  }
  if (containsMarkupOrUrl(trimmed)) {
    return {
      ok: false,
      issue: {
        field,
        code: "INVALID_CREDENTIAL",
        message: `${def.labelId} tidak boleh mengandung HTML atau tautan URL.`,
      },
    };
  }

  switch (key) {
    case "nib": {
      const compactDigits = trimmed.replace(/[\s-]/g, "");
      if (!/^\d{13}$/.test(compactDigits)) {
        return {
          ok: false,
          issue: {
            field,
            code: "INVALID_NIB_FORMAT",
            message: "NIB harus terdiri dari tepat 13 digit angka (contoh: 1234567890123).",
          },
        };
      }
      return { ok: true, value: compactDigits };
    }

    case "halalBpjh": {
      const compact = trimmed.replace(/[\s-]/g, "").toUpperCase();
      if (!/^ID\d{12,20}$/.test(compact)) {
        return {
          ok: false,
          issue: {
            field,
            code: "INVALID_HALAL_FORMAT",
            message:
              "Nomor Sertifikat Halal BPJPH harus diawali 'ID' diikuti 12–20 digit angka (contoh: ID31110000123450123).",
          },
        };
      }
      return { ok: true, value: compact };
    }

    case "pirt": {
      if (!/^(?:(?:P-?IRT|SPP-?IRT)\s+)?[0-9][0-9\s-]{9,24}[0-9]$/i.test(trimmed)) {
        return {
          ok: false,
          issue: {
            field,
            code: "INVALID_PIRT_FORMAT",
            message:
              "Nomor P-IRT tidak valid (contoh: P-IRT 2063171010123-28 atau 15 digit nomor P-IRT).",
          },
        };
      }
      const digits = countDigits(trimmed);
      if (digits < 12 || digits > 16) {
        return {
          ok: false,
          issue: {
            field,
            code: "INVALID_PIRT_FORMAT",
            message: "Nomor P-IRT harus memuat 12–16 digit angka.",
          },
        };
      }
      return { ok: true, value: trimmed };
    }

    case "skKemenagPpiu": {
      if (trimmed.length < 4 || !/^[A-Za-z0-9./ -]+$/.test(trimmed) || countDigits(trimmed) < 2) {
        return {
          ok: false,
          issue: {
            field,
            code: "INVALID_SK_KEMENAG_FORMAT",
            message:
              "Format SK Kemenag PPIU/PIHK tidak valid (contoh: U.123 Tahun 2024 atau HK.02.01/123/2024).",
          },
        };
      }
      return { ok: true, value: trimmed };
    }

    case "sipStr": {
      if (trimmed.length < 4 || !/^[A-Za-z0-9./ -]+$/.test(trimmed) || countDigits(trimmed) < 3) {
        return {
          ok: false,
          issue: {
            field,
            code: "INVALID_SIP_STR_FORMAT",
            message:
              "Format nomor SIP/STR tidak valid (contoh: SIP 446/1234/Dinkes/2025 atau STR 3111100123456789).",
          },
        };
      }
      return { ok: true, value: trimmed };
    }

    case "asitaIata":
    case "barNotaryJurisdiction":
    case "isoSniTkdn":
    case "lkpNpsn": {
      if (trimmed.length < 3 || !/^[A-Za-z0-9./: ,()-]+$/.test(trimmed) || countDigits(trimmed) < 1) {
        return {
          ok: false,
          issue: {
            field,
            code: "INVALID_CREDENTIAL",
            message: `Format ${def.labelId} tidak valid.`,
          },
        };
      }
      return { ok: true, value: trimmed };
    }
  }
}

/**
 * Validates and normalizes an entire `credentials` object with strict unknown-field rejection.
 */
export function validateIndonesianCredentials(
  raw: unknown,
  fieldPrefix = "businessProfile.credentials",
):
  | { readonly ok: true; readonly value: IndonesianBusinessCredentials }
  | { readonly ok: false; readonly issues: readonly CredentialValidationIssue[] } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      issues: [
        {
          field: fieldPrefix,
          code: "INVALID_CREDENTIAL",
          message: "credentials harus berupa objek JSON.",
        },
      ],
    };
  }

  const rec = raw as Record<string, unknown>;
  const issues: CredentialValidationIssue[] = [];
  const normalized: Record<string, string> = {};

  for (const key of Object.keys(rec)) {
    if (!ALLOWED_CREDENTIAL_KEYS.has(key)) {
      issues.push({
        field: `${fieldPrefix}.${key}`,
        code: "UNKNOWN_FIELD",
        message: `Field kredensial tidak dikenal "${key}".`,
      });
      continue;
    }
    const res = validateSingleCredential(key as IndonesianCredentialKey, rec[key], fieldPrefix);
    if (!res.ok) {
      issues.push(res.issue);
    } else if (res.value !== null) {
      normalized[key] = res.value;
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: normalized as IndonesianBusinessCredentials };
}

/**
 * Returns the ordered list of contextual credential field definitions prompted prominently
 * for the selected `businessCategory` (REQ-091).
 */
export function getPromptedCredentialsForCategory(
  businessCategory: string | null | undefined,
): readonly CredentialFieldDefinition[] {
  const def = resolveBusinessCategoryDefinition(businessCategory);
  return def.promptedCredentials.map((key) => INDONESIAN_CREDENTIAL_DEFINITIONS[key]);
}

/**
 * Projects validated credentials into truthful, plain-fact display & Schema.org items.
 * Never fabricates trust badges, ratings, or unentered credentials.
 */
export function formatTruthfulCredentialItems(
  credentials: IndonesianBusinessCredentials | null | undefined,
  businessCategory?: string | null,
): readonly TruthfulCredentialItem[] {
  if (!credentials) return [];

  const categoryDef = resolveBusinessCategoryDefinition(businessCategory);
  const preferredOrder: IndonesianCredentialKey[] = [
    ...categoryDef.promptedCredentials,
    ...(Object.keys(INDONESIAN_CREDENTIAL_DEFINITIONS) as IndonesianCredentialKey[]).filter(
      (k) => !categoryDef.promptedCredentials.includes(k),
    ),
  ];

  const items: TruthfulCredentialItem[] = [];
  for (const key of preferredOrder) {
    const rawVal = credentials[key];
    if (typeof rawVal !== "string") continue;
    const check = validateSingleCredential(key, rawVal);
    if (!check.ok || !check.value) continue;
    const def = INDONESIAN_CREDENTIAL_DEFINITIONS[key];
    items.push({
      key,
      label: def.labelId,
      schemaPropertyId: def.schemaPropertyId,
      value: check.value,
      selfDeclared: true,
      verifiedByPlatform: false,
    });
  }
  return items;
}
