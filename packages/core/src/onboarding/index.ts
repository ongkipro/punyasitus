import { RESERVED_HANDLES } from "../index.ts";
import { RESERVED_TENANT_HANDLES, TenantHandleSchema } from "../schemas/common.ts";

/**
 * Pure self-service verified signup & unique trial website onboarding contract
 * (`packages/core/src/onboarding/index.ts`; REQ-059, PLAN §17.1-§17.4, TASK-058).
 *
 * Hard invariants:
 * - Server-owned 7-day trial duration is EXACTLY 604,800 seconds (7 * 24 * 60 * 60).
 * - Client-supplied deadlines, statuses, roles, or platform-operator flags are strictly
 *   rejected (`422 FORBIDDEN_CLIENT_FIELD`).
 * - Handles are normalized to lowercase ASCII (`3-40` chars, alphanumeric ends) and
 *   checked against reserved infrastructure labels before hitting D1.
 */

export const ONBOARDING_TRIAL_DURATION_SECONDS = 604_800 as const; // Exact 7 days (168h)
export const ONBOARDING_TRIAL_DURATION_MS = ONBOARDING_TRIAL_DURATION_SECONDS * 1000;
export const ONBOARDING_SAAS_ZONE = "situsku.click" as const;

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const RESEND_VERIFICATION_COOLDOWN_MS = 60 * 1000; // 60 seconds (PLAN §17.4)
export const RESEND_VERIFICATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const RESEND_VERIFICATION_MAX_PER_HOUR = 3 as const; // max 3/hour (PLAN §17.4)

export const ONBOARDING_VERTICAL_IDS = [
  "compro",
  "sales",
  "travel",
  "catalog",
  "resto",
  "dealer",
] as const;

export type OnboardingVertical = (typeof ONBOARDING_VERTICAL_IDS)[number];

export interface OnboardingVerticalOption {
  readonly id: OnboardingVertical;
  readonly label: string;
  readonly description: string;
}

export const ONBOARDING_VERTICAL_OPTIONS: readonly OnboardingVerticalOption[] = [
  {
    id: "compro",
    label: "Profil Perusahaan",
    description: "Jasa profesional, kantor, konsultan, dan lembaga.",
  },
  {
    id: "sales",
    label: "Landing Penjualan",
    description: "Halaman penawaran fokus konversi pesan WhatsApp.",
  },
  {
    id: "travel",
    label: "Tur & Travel",
    description: "Paket wisata, jadwal keberangkatan, dan permintaan tur.",
  },
  {
    id: "catalog",
    label: "Katalog Produk",
    description: "Etalase produk rapi dengan tombol tanya WhatsApp.",
  },
  {
    id: "resto",
    label: "Restoran & Kuliner",
    description: "Daftar menu, lokasi cabang, dan permintaan reservasi.",
  },
  {
    id: "dealer",
    label: "Showroom Kendaraan",
    description: "Mobil & motor baru atau bekas dengan spesifikasi lengkap.",
  },
] as const;

const EXTRA_ONBOARDING_RESERVED_HANDLES = [
  "status",
  "support",
  "help",
  "billing",
  "docs",
  "cdn",
  "static",
  "media",
  "login",
  "logout",
  "signup",
  "register",
  "oauth",
  "oauth2",
  "root",
  "system",
  "punyasitus",
  "situsku",
  "onboarding",
  "verify",
  "verify-email",
] as const;

export const ONBOARDING_RESERVED_HANDLES: ReadonlySet<string> = new Set([
  ...RESERVED_HANDLES,
  ...RESERVED_TENANT_HANDLES,
  ...EXTRA_ONBOARDING_RESERVED_HANDLES,
]);

/**
 * Server-owned or privileged field names that MUST NEVER be accepted from public
 * onboarding clients (REQ-059, PLAN §17.1-§17.3).
 */
export const FORBIDDEN_ONBOARDING_CLIENT_FIELDS = [
  "trialEndsAt",
  "trial_ends_at",
  "trialEndsAtMs",
  "trial_ends_at_ms",
  "trialStartsAt",
  "trial_starts_at",
  "trialDuration",
  "trial_duration",
  "trialDurationSeconds",
  "trial_duration_seconds",
  "grantTrial",
  "grant_trial",
  "status",
  "initialStatus",
  "initial_status",
  "effectiveStatus",
  "effective_status",
  "paidThrough",
  "paid_through",
  "paidThroughMs",
  "paid_through_ms",
  "role",
  "actorRole",
  "actor_role",
  "platformOperator",
  "platform_operator",
  "isPlatformOperator",
  "is_platform_operator",
  "isPlatformAdmin",
  "is_platform_admin",
  "isAdmin",
  "is_admin",
  "isSuperadmin",
  "is_superadmin",
  "operatorHold",
  "operator_hold",
  "tenantId",
  "tenant_id",
  "organizationId",
  "organization_id",
  "userId",
  "user_id",
  "ownerUserId",
  "owner_user_id",
  "emailVerified",
  "email_verified",
  "agencyId",
  "agency_id",
] as const;

const FORBIDDEN_ONBOARDING_FIELD_LOWER_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_ONBOARDING_CLIENT_FIELDS.map((k) => k.toLowerCase()),
);

const ALLOWED_PROVISION_KEYS: ReadonlySet<string> = new Set([
  "handle",
  "name",
  "vertical",
  "idempotencyKey",
]);

const SAFE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export type OnboardingValidationErrorCode =
  | "VALIDATION_ERROR"
  | "FORBIDDEN_CLIENT_FIELD"
  | "INVALID_HANDLE"
  | "RESERVED_HANDLE";

export class OnboardingValidationError extends Error {
  readonly status: 400 | 422;
  readonly code: OnboardingValidationErrorCode;
  readonly field?: string;

  constructor(
    status: 400 | 422,
    code: OnboardingValidationErrorCode,
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = "OnboardingValidationError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export type HandleValidationPreview =
  | {
      readonly ok: true;
      readonly normalizedHandle: string;
      readonly primaryHost: string;
      readonly saasZone: string;
    }
  | {
      readonly ok: false;
      readonly normalizedHandle: string;
      readonly code: "INVALID_HANDLE" | "RESERVED_HANDLE";
      readonly message: string;
    };

/**
 * Normalizes and validates a candidate tenant handle without touching D1.
 */
export function validateOnboardingHandleFormat(
  rawHandle: string,
  saasZone: string = ONBOARDING_SAAS_ZONE,
): HandleValidationPreview {
  const normalized = typeof rawHandle === "string" ? rawHandle.trim().toLowerCase() : "";
  const cleanZone = saasZone.trim().toLowerCase() || ONBOARDING_SAAS_ZONE;

  if (!normalized) {
    return {
      ok: false,
      normalizedHandle: "",
      code: "INVALID_HANDLE",
      message: "Alamat situs (handle) wajib diisi.",
    };
  }

  if (normalized.length < 3 || normalized.length > 40) {
    return {
      ok: false,
      normalizedHandle: normalized,
      code: "INVALID_HANDLE",
      message: "Handle situs harus terdiri dari 3 hingga 40 karakter.",
    };
  }

  if (ONBOARDING_RESERVED_HANDLES.has(normalized)) {
    return {
      ok: false,
      normalizedHandle: normalized,
      code: "RESERVED_HANDLE",
      message: `Handle "${normalized}" dicadangkan oleh platform dan tidak dapat digunakan.`,
    };
  }

  const parsed = TenantHandleSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false,
      normalizedHandle: normalized,
      code: "INVALID_HANDLE",
      message:
        "Handle situs hanya boleh berisi huruf kecil a-z, angka 0-9, serta tanda hubung di tengah (diawali dan diakhiri huruf atau angka).",
    };
  }

  return {
    ok: true,
    normalizedHandle: parsed.data,
    primaryHost: `${parsed.data}.${cleanZone}`,
    saasZone: cleanZone,
  };
}

/**
 * Suggests a clean URL-safe handle slug from a business display name.
 */
export function suggestHandleFromBusinessName(rawName: string): string {
  const slug = rawName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");

  if (slug.length < 3 || ONBOARDING_RESERVED_HANDLES.has(slug)) {
    return "";
  }
  return slug;
}

/**
 * Normalizes a business name into a stable lowercase alphanumeric fingerprint
 * for anti-duplicate-trial detection against `deletion_tombstones` (REQ-059, PLAN §17.1).
 */
export function normalizeBusinessNameForTrialKey(rawName: string): string {
  return rawName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Computes the authoritative server-owned 7-day trial window (`604,800` seconds exact).
 */
export function computeServerTrialWindow(nowMs: number): {
  readonly trialStartsAtMs: number;
  readonly trialEndsAtMs: number;
  readonly durationSeconds: typeof ONBOARDING_TRIAL_DURATION_SECONDS;
} {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be a finite epoch millisecond timestamp");
  }
  const start = Math.trunc(nowMs);
  return {
    trialStartsAtMs: start,
    trialEndsAtMs: start + ONBOARDING_TRIAL_DURATION_MS,
    durationSeconds: ONBOARDING_TRIAL_DURATION_SECONDS,
  };
}

/**
 * Rejects any client-supplied server-owned or privileged field (`422 FORBIDDEN_CLIENT_FIELD`).
 */
export function assertNoForbiddenOnboardingFields(body: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_ONBOARDING_FIELD_LOWER_SET.has(key.toLowerCase())) {
      throw new OnboardingValidationError(
        422,
        "FORBIDDEN_CLIENT_FIELD",
        `Kolom "${key}" dikelola sepenuhnya oleh server dan tidak boleh dikirim oleh klien.`,
        key,
      );
    }
  }
}

export interface ValidatedOnboardingProvisionPayload {
  readonly handle: string;
  readonly name: string;
  readonly vertical: OnboardingVertical;
  readonly idempotencyKey: string | null;
}

/**
 * Strictly validates a self-service website provisioning JSON payload:
 * - Rejects forged server/privilege fields (`422 FORBIDDEN_CLIENT_FIELD`).
 * - Rejects unknown keys (`422 VALIDATION_ERROR`).
 * - Validates handle format/reservations, business name (`2..160`), vertical, and optional idempotency key.
 */
export function validateOnboardingProvisionPayload(
  rawBody: unknown,
): ValidatedOnboardingProvisionPayload {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    throw new OnboardingValidationError(
      400,
      "VALIDATION_ERROR",
      "Format isi permintaan JSON harus berupa objek.",
    );
  }

  const record = rawBody as Record<string, unknown>;
  assertNoForbiddenOnboardingFields(record);

  for (const key of Object.keys(record)) {
    if (!ALLOWED_PROVISION_KEYS.has(key)) {
      throw new OnboardingValidationError(
        422,
        "VALIDATION_ERROR",
        `Kolom "${key}" tidak dikenali pada permintaan pembuatan situs.`,
        key,
      );
    }
  }

  if (typeof record.handle !== "string") {
    throw new OnboardingValidationError(
      422,
      "INVALID_HANDLE",
      "Alamat situs (handle) wajib diisi.",
      "handle",
    );
  }

  const handleCheck = validateOnboardingHandleFormat(record.handle);
  if (!handleCheck.ok) {
    throw new OnboardingValidationError(422, handleCheck.code, handleCheck.message, "handle");
  }

  if (typeof record.name !== "string") {
    throw new OnboardingValidationError(
      422,
      "VALIDATION_ERROR",
      "Nama bisnis atau website wajib diisi.",
      "name",
    );
  }
  const cleanName = record.name.replace(/[\r\n\t\0]+/g, " ").trim();
  if (cleanName.length < 2 || cleanName.length > 160) {
    throw new OnboardingValidationError(
      422,
      "VALIDATION_ERROR",
      "Nama bisnis/situs harus terdiri dari 2 hingga 160 karakter.",
      "name",
    );
  }

  let vertical: OnboardingVertical = "compro";
  if (record.vertical !== undefined) {
    if (
      typeof record.vertical !== "string" ||
      !(ONBOARDING_VERTICAL_IDS as readonly string[]).includes(record.vertical)
    ) {
      throw new OnboardingValidationError(
        422,
        "VALIDATION_ERROR",
        "Pilihan jenis bisnis/tema bawaan tidak valid.",
        "vertical",
      );
    }
    vertical = record.vertical as OnboardingVertical;
  }

  let idempotencyKey: string | null = null;
  if (record.idempotencyKey !== undefined) {
    if (
      typeof record.idempotencyKey !== "string" ||
      !SAFE_IDEMPOTENCY_KEY_RE.test(record.idempotencyKey.trim())
    ) {
      throw new OnboardingValidationError(
        422,
        "VALIDATION_ERROR",
        "Idempotency-Key harus berupa 8-128 karakter alfanumerik aman.",
        "idempotencyKey",
      );
    }
    idempotencyKey = record.idempotencyKey.trim();
  }

  return {
    handle: handleCheck.normalizedHandle,
    name: cleanName,
    vertical,
    idempotencyKey,
  };
}

/**
 * Generates a cryptographically strong hex token using Web Crypto.
 */
export function generateSecureHexToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i += 1) {
    out += (buf[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Computes a lowercase SHA-256 hex digest using Web Crypto.
 */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}
