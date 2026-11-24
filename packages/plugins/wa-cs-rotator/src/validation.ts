import type { PluginConfigSchemaLike } from "@punyasitus/core/plugins/index";
import { validateIndonesianWhatsAppNumber } from "@punyasitus/core/wa-dispatcher";

/**
 * Input validation helpers for `wa-cs-rotator` (`REQ-099`, `TASK-099`).
 *
 * Security invariants:
 * - Strictly validates Indonesian mobile E.164 numbers (`08...`, `628...`, `+628...`).
 * - Validates weights (`1..100`), `HH:MM` active-hour windows, weekday sets (`0..6`),
 *   and IANA timezones (default `Asia/Jakarta` WIB).
 */

export const WA_CS_MAX_AGENTS = 30 as const;
export const WA_CS_DEFAULT_TIMEZONE = "Asia/Jakarta" as const;
export const WA_CS_DEFAULT_DAYS = [1, 2, 3, 4, 5, 6] as const;
export const WA_CS_ALLOWED_STRATEGIES = ["round_robin", "weighted"] as const;
export type WaRotationStrategy = (typeof WA_CS_ALLOWED_STRATEGIES)[number];

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SAFE_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export const SUPPORTED_INDONESIAN_TIMEZONES = [
  "Asia/Jakarta",
  "Asia/Makassar",
  "Asia/Jayapura",
  "UTC",
] as const;

export class WaCsRotatorValidationError extends Error {
  readonly code: "VALIDATION_ERROR" | "INVALID_PHONE" | "INVALID_SCHEDULE" | "CONFLICT";

  constructor(
    code: "VALIDATION_ERROR" | "INVALID_PHONE" | "INVALID_SCHEDULE" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "WaCsRotatorValidationError";
    this.code = code;
  }
}

function hasControlChars(value: string, allowNewlines = false): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code <= 0x1f) {
      if (allowNewlines && (code === 0x0a || code === 0x0d || code === 0x09)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function isValidAgentId(rawId: string): boolean {
  return typeof rawId === "string" && SAFE_AGENT_ID_RE.test(rawId.trim().toLowerCase());
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64 || hasControlChars(tz, false)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function parseHhMmToMinutes(raw: string, allow2400 = false): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (allow2400 && trimmed === "24:00") return 24 * 60;
  const m = HHMM_RE.exec(trimmed);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function normalizeScheduleDays(raw: unknown): number[] {
  let parts: unknown[];
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    const rawSegments = trimmed.split(",");
    for (const seg of rawSegments) {
      if (seg.trim().length === 0) {
        throw new WaCsRotatorValidationError(
          "INVALID_SCHEDULE",
          "Format daftar hari aktif mengandung segmen kosong (contoh: '1,,2').",
        );
      }
    }
    parts = rawSegments.map((s) => Number(s.trim()));
  } else if (raw === undefined || raw === null) {
    return [...WA_CS_DEFAULT_DAYS];
  } else {
    throw new WaCsRotatorValidationError(
      "INVALID_SCHEDULE",
      "Hari aktif agen harus berupa daftar angka 0 (Minggu) hingga 6 (Sabtu).",
    );
  }

  const unique = new Set<number>();
  for (const item of parts) {
    if (typeof item === "string" && item.trim().length === 0) {
      throw new WaCsRotatorValidationError(
        "INVALID_SCHEDULE",
        "Hari aktif harus angka bulat 0 (Minggu) sampai 6 (Sabtu).",
      );
    }
    const n = typeof item === "number" ? item : Number(item);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      throw new WaCsRotatorValidationError(
        "INVALID_SCHEDULE",
        "Hari aktif harus angka bulat 0 (Minggu) sampai 6 (Sabtu).",
      );
    }
    unique.add(n);
  }
  return [...unique].sort((a, b) => a - b);
}

export function serializeScheduleDays(days: readonly number[]): string {
  return [...new Set(days)].sort((a, b) => a - b).join(",");
}

export interface WaCsRotatorPluginConfig {
  readonly strategy: WaRotationStrategy;
  readonly fallbackWhatsappPhone: string;
  readonly timezone: string;
  readonly defaultMessage: string;
  readonly ctaLabel: string;
}

export const DEFAULT_WA_CS_ROTATOR_CONFIG: WaCsRotatorPluginConfig = {
  strategy: "round_robin",
  fallbackWhatsappPhone: "",
  timezone: WA_CS_DEFAULT_TIMEZONE,
  defaultMessage: "Halo, saya ingin berkonsultasi mengenai layanan Anda.",
  ctaLabel: "Chat Tim Sales via WhatsApp",
};

export const WaCsRotatorConfigSchema: PluginConfigSchemaLike = {
  safeParse(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { success: false };
    }
    const obj = input as Record<string, unknown>;

    const rawStrategy = typeof obj.strategy === "string" ? obj.strategy.trim() : "round_robin";
    if (rawStrategy !== "round_robin" && rawStrategy !== "weighted") {
      return { success: false };
    }

    let fallbackWhatsappPhone = "";
    if (
      typeof obj.fallbackWhatsappPhone === "string" &&
      obj.fallbackWhatsappPhone.trim().length > 0
    ) {
      const phoneRes = validateIndonesianWhatsAppNumber(obj.fallbackWhatsappPhone);
      if (!phoneRes.ok) {
        return { success: false };
      }
      fallbackWhatsappPhone = phoneRes.phone;
    }

    const timezone =
      typeof obj.timezone === "string" && obj.timezone.trim().length > 0
        ? obj.timezone.trim()
        : WA_CS_DEFAULT_TIMEZONE;
    if (!isValidTimeZone(timezone)) {
      return { success: false };
    }

    const defaultMessage =
      typeof obj.defaultMessage === "string" && obj.defaultMessage.trim().length > 0
        ? obj.defaultMessage.trim()
        : DEFAULT_WA_CS_ROTATOR_CONFIG.defaultMessage;
    if (defaultMessage.length > 500 || hasControlChars(defaultMessage, true)) {
      return { success: false };
    }

    const ctaLabel =
      typeof obj.ctaLabel === "string" && obj.ctaLabel.trim().length > 0
        ? obj.ctaLabel.trim()
        : DEFAULT_WA_CS_ROTATOR_CONFIG.ctaLabel;
    if (ctaLabel.length > 60 || hasControlChars(ctaLabel, false)) {
      return { success: false };
    }

    return {
      success: true,
      data: {
        strategy: rawStrategy,
        fallbackWhatsappPhone,
        timezone,
        defaultMessage,
        ctaLabel,
      },
    };
  },
};

export interface WaAgentInput {
  readonly name?: unknown;
  readonly roleLabel?: unknown;
  readonly phone?: unknown;
  readonly phoneE164?: unknown;
  readonly weight?: unknown;
  readonly scheduleDays?: unknown;
  readonly startTime?: unknown;
  readonly endTime?: unknown;
  readonly timezone?: unknown;
  readonly isActive?: unknown;
  readonly sortOrder?: unknown;
}

export interface ValidatedWaAgentInput {
  readonly name: string;
  readonly roleLabel: string;
  readonly phoneE164: string;
  readonly weight: number;
  readonly scheduleDays: readonly number[];
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export function validateWaAgentInput(input: WaAgentInput): ValidatedWaAgentInput {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 80 || hasControlChars(name, false)) {
    throw new WaCsRotatorValidationError(
      "VALIDATION_ERROR",
      "Nama agen sales wajib diisi (1-80 karakter).",
    );
  }

  const roleLabel =
    typeof input.roleLabel === "string" && input.roleLabel.trim().length > 0
      ? input.roleLabel.trim()
      : "Sales CS";
  if (roleLabel.length > 60 || hasControlChars(roleLabel, false)) {
    throw new WaCsRotatorValidationError(
      "VALIDATION_ERROR",
      "Label peran agen maksimal 60 karakter.",
    );
  }

  const rawPhone =
    typeof input.phone === "string"
      ? input.phone
      : typeof input.phoneE164 === "string"
        ? input.phoneE164
        : "";
  const phoneRes = validateIndonesianWhatsAppNumber(rawPhone);
  if (!phoneRes.ok) {
    throw new WaCsRotatorValidationError(
      "INVALID_PHONE",
      "Nomor WhatsApp agen harus format Indonesia yang valid (08... atau +628...).",
    );
  }

  const weight =
    input.weight === undefined || input.weight === null ? 1 : Number(input.weight);
  if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
    throw new WaCsRotatorValidationError(
      "VALIDATION_ERROR",
      "Bobot distribusi agen harus bilangan bulat antara 1 hingga 100.",
    );
  }

  const scheduleDays = normalizeScheduleDays(input.scheduleDays);

  const startTime =
    typeof input.startTime === "string" && input.startTime.trim().length > 0
      ? input.startTime.trim()
      : "08:00";
  const endTime =
    typeof input.endTime === "string" && input.endTime.trim().length > 0
      ? input.endTime.trim()
      : "17:00";

  if (parseHhMmToMinutes(startTime, false) === null) {
    throw new WaCsRotatorValidationError(
      "INVALID_SCHEDULE",
      "Jam mulai aktif harus berformat HH:MM (00:00 - 23:59).",
    );
  }
  if (parseHhMmToMinutes(endTime, true) === null) {
    throw new WaCsRotatorValidationError(
      "INVALID_SCHEDULE",
      "Jam selesai aktif harus berformat HH:MM (00:00 - 24:00).",
    );
  }

  const timezone =
    typeof input.timezone === "string" && input.timezone.trim().length > 0
      ? input.timezone.trim()
      : WA_CS_DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone)) {
    throw new WaCsRotatorValidationError(
      "INVALID_SCHEDULE",
      `Zona waktu "${timezone}" tidak valid. Gunakan zona IANA seperti Asia/Jakarta.`,
    );
  }

  const isActive = typeof input.isActive === "boolean" ? input.isActive : true;
  const sortOrder =
    typeof input.sortOrder === "number" &&
    Number.isInteger(input.sortOrder) &&
    input.sortOrder >= 0 &&
    input.sortOrder <= 10_000
      ? input.sortOrder
      : 0;

  return {
    name,
    roleLabel,
    phoneE164: phoneRes.phone,
    weight,
    scheduleDays,
    startTime,
    endTime,
    timezone,
    isActive,
    sortOrder,
  };
}

/**
 * Sanitizes a public `source_path` before persistence into `plg_wa_cs_rotator__clicks`:
 * - Strictly strips query strings (`?...`) and fragments (`#...`) so visitor URLs
 *   containing emails, phones, or auth tokens can NEVER be stored (zero PII).
 * - Rejects protocol-relative paths (`//`), backslashes, and control characters.
 */
export function sanitizeSourcePath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const trimmed = raw.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/";
  }
  const withoutQueryOrFragment = trimmed.split(/[?#]/, 1)[0] ?? "/";
  const cleaned = withoutQueryOrFragment
    .replace(/\\/g, "")
    .replace(/[\r\n\t\0]/g, "");
  if (cleaned.length === 0 || !cleaned.startsWith("/") || cleaned.startsWith("//")) {
    return "/";
  }
  return cleaned.slice(0, 160);
}

export const WA_ITEM_TITLE_MAX_LEN = 120 as const;

/**
 * Sanitizes query-supplied `/wa-rotator?item=...` before inserting into prefilled WA text:
 * strips control characters and caps length to 120 characters.
 */
export function sanitizeWaItemTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let cleaned = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      cleaned += " ";
    } else {
      cleaned += raw[i]!;
    }
  }
  const collapsed = cleaned.replace(/\s+/g, " ").trim().slice(0, WA_ITEM_TITLE_MAX_LEN);
  return collapsed.length > 0 ? collapsed : undefined;
}

export function formatDayBucketInTimezone(nowMs: number, timezone: string): string {
  const tz = isValidTimeZone(timezone) ? timezone : WA_CS_DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}
