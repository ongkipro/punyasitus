/**
 * Canonical constants, statuses, transitions, and error types for
 * Custom Theme Service Packages & Requests (REQ-063, PLAN §11.4 & §13, TASK-061).
 */

export const SERVICE_KINDS = ["custom_theme", "setup", "custom_plugin"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const SERVICE_KIND_LABELS_ID: Readonly<Record<ServiceKind, string>> = {
  custom_theme: "Tema Kustom",
  setup: "Layanan Terima Beres",
  custom_plugin: "Plugin Kustom",
};

export const STAFF_ACCESS_STATES = [
  "none",
  "awaiting_owner_approval",
  "waiting_seat",
  "active",
  "revoked",
] as const;
export type StaffAccessState = (typeof STAFF_ACCESS_STATES)[number];

export const STAFF_ACCESS_STATE_LABELS_ID: Readonly<Record<StaffAccessState, string>> = {
  none: "Belum ada penugasan tim",
  awaiting_owner_approval: "Menunggu persetujuan Pemilik Situs",
  waiting_seat: "Menunggu kursi anggota kosong",
  active: "Tim Setup aktif (Editor)",
  revoked: "Akses Tim Setup dicabut",
};

export const SETUP_SERVICE_SEAT_FULL_EXPLANATION =
  "Semua 5 kursi anggota situs sedang terpakai. Hapus anggota atau batalkan undangan tertunda di Pengaturan > Anggota, lalu setujui kembali akses Tim Setup agar pengerjaan dapat dimulai." as const;

export const CUSTOM_THEME_REQUEST_STATUSES = [
  "new",
  "contacted",
  "quoted",
  "in_progress",
  "delivered",
  "declined",
  "cancelled",
] as const;
export type CustomThemeRequestStatus = (typeof CUSTOM_THEME_REQUEST_STATUSES)[number];

export const CUSTOM_THEME_TERMINAL_STATUSES: ReadonlySet<CustomThemeRequestStatus> = new Set([
  "delivered",
  "declined",
  "cancelled",
]);

/**
 * Forward-only status flow per PLAN §11.4:
 * `new -> contacted -> quoted -> in_progress -> delivered`, or `declined` / `cancelled`.
 */
export const CUSTOM_THEME_ALLOWED_TRANSITIONS: Readonly<
  Record<CustomThemeRequestStatus, readonly CustomThemeRequestStatus[]>
> = {
  new: ["contacted", "quoted", "in_progress", "delivered", "declined", "cancelled"],
  contacted: ["quoted", "in_progress", "delivered", "declined", "cancelled"],
  quoted: ["in_progress", "delivered", "declined", "cancelled"],
  in_progress: ["delivered", "declined", "cancelled"],
  delivered: [],
  declined: [],
  cancelled: [],
};

export const CONTACT_PREFERENCES = ["whatsapp", "email", "both"] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number];

export const CUSTOM_THEME_MAX_REFERENCE_URLS = 5 as const;
export const CUSTOM_THEME_DAILY_REQUEST_LIMIT = 3 as const;
export const CUSTOM_THEME_MAX_BRAND_NAME_LENGTH = 100 as const;
export const CUSTOM_THEME_MAX_BRIEF_LENGTH = 2000 as const;
export const CUSTOM_THEME_MAX_BUDGET_RANGE_LENGTH = 120 as const;
export const CUSTOM_THEME_MAX_OPERATOR_NOTES_LENGTH = 1000 as const;
export const CUSTOM_THEME_MAX_STARTING_PRICE_IDR = 999_999_999_999 as const;
export const CUSTOM_THEME_MAX_PACKAGE_INCLUSIONS = 20 as const;
export const CUSTOM_THEME_MAX_INCLUSION_LENGTH = 200 as const;
export const CUSTOM_THEME_MAX_SORT_ORDER = 10_000 as const;
export const CUSTOM_THEME_MIN_REASON_LENGTH = 10 as const;
export const CUSTOM_THEME_MAX_REASON_LENGTH = 500 as const;

export const CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL = "Belum tahu / Konsultasi dulu" as const;
export const CUSTOM_THEME_QUOTE_ONLY_PRICE_LABEL = "Harga berdasarkan penawaran" as const;

export const CUSTOM_THEME_STATUS_LABELS_ID: Readonly<Record<CustomThemeRequestStatus, string>> = {
  new: "Baru",
  contacted: "Dihubungi",
  quoted: "Penawaran Dikirim",
  in_progress: "Dikerjakan",
  delivered: "Diserahkan",
  declined: "Ditolak",
  cancelled: "Dibatalkan",
};

export const CONTACT_PREFERENCE_LABELS_ID: Readonly<Record<ContactPreference, string>> = {
  whatsapp: "WhatsApp",
  email: "Email",
  both: "WhatsApp & Email",
};

export interface CustomThemeFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export type CustomThemeValidationErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_REFERENCE_URL"
  | "TOO_MANY_REFERENCE_URLS"
  | "INVALID_IDEMPOTENCY_KEY"
  | "INVALID_REASON"
  | "THEME_GRANT_REQUIRED"
  | "INVALID_STAFF_EMAIL"
  | "UNKNOWN_FIELD";

export class CustomThemeValidationError extends Error {
  readonly status = 422 as const;
  readonly code: CustomThemeValidationErrorCode;
  readonly fields: readonly CustomThemeFieldError[];

  constructor(
    code: CustomThemeValidationErrorCode,
    message: string,
    fields: readonly CustomThemeFieldError[] = [],
  ) {
    super(message);
    this.name = "CustomThemeValidationError";
    this.code = code;
    this.fields = fields;
  }
}

export interface CustomThemePackageRecord {
  readonly id: string;
  readonly serviceKind: ServiceKind;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly inclusions: readonly string[];
  readonly startingPriceIdr: number | null;
  readonly priceLabel: string;
  readonly estimatedDuration: string;
  readonly sortOrder: number;
  readonly active: boolean;
  readonly createdByUserId: string | null;
  readonly updatedByUserId: string | null;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface CustomThemeRequestRecord {
  readonly id: string;
  readonly requestCode: string;
  readonly serviceKind: ServiceKind;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly packageId: string | null;
  readonly packageName: string;
  readonly requestedByUserId: string;
  readonly idempotencyKey: string;
  readonly dayBucket: string;
  readonly status: CustomThemeRequestStatus;
  readonly brandName: string;
  readonly brief: string;
  readonly referenceUrls: readonly string[];
  readonly budgetRange: string | null;
  readonly contactPreference: ContactPreference;
  readonly deliveredThemeId: string | null;
  readonly deliveredThemeGrantId: string | null;
  readonly statusReason: string | null;
  readonly operatorNotes: string | null;
  readonly staffUserId: string | null;
  readonly staffEmail: string | null;
  readonly staffName: string | null;
  readonly staffAccessState: StaffAccessState;
  readonly staffApprovedByUserId: string | null;
  readonly staffApprovedAtMs: number | null;
  readonly staffApprovedAtIso: string | null;
  readonly staffMemberId: string | null;
  readonly staffJoinedAtMs: number | null;
  readonly staffJoinedAtIso: string | null;
  readonly staffRevokedAtMs: number | null;
  readonly staffRevokedAtIso: string | null;
  readonly staffWaitReason: string | null;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}
