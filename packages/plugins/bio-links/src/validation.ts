import type { PluginConfigSchemaLike } from "@punyasitus/core/plugins/index";
import { validateIndonesianWhatsAppNumber } from "@punyasitus/core/wa-dispatcher";

/**
 * Input & URL validation helpers for the official `bio-links` plugin (`REQ-099`, `TASK-099`).
 *
 * Security invariants:
 * - Strict URL protocol allowlist: `https:`, `http:`, `tel:`, `mailto:`, and `wa.me/...` shorthand.
 * - Rejects `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, protocol-relative `//`,
 *   embedded credentials, and control characters to prevent XSS and open-redirect abuse.
 */

export const BIO_LINKS_MAX_LINKS = 50 as const;
export const BIO_LINKS_MAX_URL_LENGTH = 2048 as const;
export const BIO_LINKS_DEFAULT_ACCENT = "#0F766E" as const;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TEL_RE = /^tel:\+?[0-9][0-9\s().-]{5,24}$/;
const MAILTO_RE = /^mailto:[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export class BioLinksValidationError extends Error {
  readonly code: "VALIDATION_ERROR" | "INVALID_URL" | "INVALID_PHONE";

  constructor(code: "VALIDATION_ERROR" | "INVALID_URL" | "INVALID_PHONE", message: string) {
    super(message);
    this.name = "BioLinksValidationError";
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

export type UrlValidationResult =
  | { readonly ok: true; readonly url: string; readonly protocol: "https:" | "http:" | "tel:" | "mailto:" }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates and normalizes a bio-link target URL against a strict protocol allowlist.
 * Allows `https:`, `http:`, `tel:`, `mailto:`, and `wa.me/<number>` shorthand (normalized to `https://wa.me/...`).
 * Strictly rejects `javascript:`, `data:`, `vbscript:`, `file:`, protocol-relative `//`, and control characters.
 */
export function validateBioLinkUrl(rawUrl: string): UrlValidationResult {
  if (typeof rawUrl !== "string") {
    return { ok: false, reason: "URL tautan wajib berupa teks." };
  }
  if (hasControlChars(rawUrl, false)) {
    return { ok: false, reason: "URL tautan tidak boleh mengandung karakter kontrol." };
  }

  let candidate = rawUrl.trim();
  if (candidate.length === 0) {
    return { ok: false, reason: "URL tautan wajib diisi." };
  }
  if (candidate.length > BIO_LINKS_MAX_URL_LENGTH) {
    return { ok: false, reason: "URL tautan melebihi batas panjang 2048 karakter." };
  }
  if (candidate.startsWith("//")) {
    return { ok: false, reason: "URL relatif protokol (//) tidak diizinkan." };
  }

  // Normalize convenient `wa.me/...` shorthand to `https://wa.me/...`
  if (/^wa\.me\/[0-9]{8,15}(?:\?.*)?$/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  // Strip accidental leading/embedded scheme obfuscation check
  const lower = candidate.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("file:") ||
    lower.startsWith("blob:")
  ) {
    return {
      ok: false,
      reason: "Skema URL tidak aman ditolak. Gunakan https://, http://, tel:, mailto:, atau wa.me/.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      ok: false,
      reason: "Format URL tidak valid. Gunakan awalan https://, http://, tel:, mailto:, atau wa.me/.",
    };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "https:" || protocol === "http:") {
    if (!parsed.hostname || parsed.hostname.length === 0) {
      return { ok: false, reason: "Hostname URL tidak valid." };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, reason: "URL tidak boleh mengandung kredensial username/password." };
    }
    return { ok: true, url: parsed.toString(), protocol };
  }

  if (protocol === "tel:") {
    if (!TEL_RE.test(candidate)) {
      return { ok: false, reason: "Format tautan telepon (tel:) tidak valid." };
    }
    return { ok: true, url: candidate, protocol: "tel:" };
  }

  if (protocol === "mailto:") {
    if (!MAILTO_RE.test(candidate)) {
      return { ok: false, reason: "Format tautan email (mailto:) tidak valid." };
    }
    return { ok: true, url: candidate, protocol: "mailto:" };
  }

  return {
    ok: false,
    reason: `Skema "${protocol}" tidak diizinkan. Hanya https:, http:, tel:, mailto:, dan wa.me yang diperbolehkan.`,
  };
}

export function validateAvatarUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return "";
  if (hasControlChars(trimmed, false) || trimmed.length > 1024 || trimmed.includes("\\")) {
    throw new BioLinksValidationError("INVALID_URL", "URL avatar tidak valid.");
  }
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }
  const checked = validateBioLinkUrl(trimmed);
  if (!checked.ok || (checked.protocol !== "https:" && checked.protocol !== "http:")) {
    throw new BioLinksValidationError(
      "INVALID_URL",
      "URL avatar hanya boleh menggunakan jalur relatif situs atau https://.",
    );
  }
  return checked.url;
}

export function validateAccentHex(rawHex: unknown): string {
  if (typeof rawHex !== "string") return BIO_LINKS_DEFAULT_ACCENT;
  const trimmed = rawHex.trim();
  if (!HEX_COLOR_RE.test(trimmed)) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      "Warna aksen harus berupa kode hex 6 digit (contoh: #0F766E).",
    );
  }
  return trimmed.toUpperCase();
}

export function isValidBioLinkId(rawId: string): boolean {
  return typeof rawId === "string" && SAFE_ID_RE.test(rawId.trim().toLowerCase());
}

export interface BioLinksPluginConfig {
  readonly displayName: string;
  readonly headline: string;
  readonly themeAccent: string;
  readonly showWhatsappButton: boolean;
  readonly whatsappPhone: string;
}

export const DEFAULT_BIO_LINKS_CONFIG: BioLinksPluginConfig = {
  displayName: "",
  headline: "",
  themeAccent: BIO_LINKS_DEFAULT_ACCENT,
  showWhatsappButton: true,
  whatsappPhone: "",
};

export const BioLinksConfigSchema: PluginConfigSchemaLike = {
  safeParse(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { success: false };
    }
    const obj = input as Record<string, unknown>;

    const displayName =
      typeof obj.displayName === "string" ? obj.displayName.trim() : "";
    if (displayName.length > 80 || hasControlChars(displayName, false)) {
      return { success: false };
    }

    const headline = typeof obj.headline === "string" ? obj.headline.trim() : "";
    if (headline.length > 160 || hasControlChars(headline, false)) {
      return { success: false };
    }

    const rawAccent =
      typeof obj.themeAccent === "string" && obj.themeAccent.trim().length > 0
        ? obj.themeAccent.trim()
        : BIO_LINKS_DEFAULT_ACCENT;
    if (!HEX_COLOR_RE.test(rawAccent)) {
      return { success: false };
    }

    const showWhatsappButton =
      typeof obj.showWhatsappButton === "boolean" ? obj.showWhatsappButton : true;

    let whatsappPhone = "";
    if (typeof obj.whatsappPhone === "string" && obj.whatsappPhone.trim().length > 0) {
      const phoneRes = validateIndonesianWhatsAppNumber(obj.whatsappPhone);
      if (!phoneRes.ok) {
        return { success: false };
      }
      whatsappPhone = phoneRes.phone;
    }

    return {
      success: true,
      data: {
        displayName,
        headline,
        themeAccent: rawAccent.toUpperCase(),
        showWhatsappButton,
        whatsappPhone,
      },
    };
  },
};

export interface BioLinkProfileInput {
  readonly displayName?: unknown;
  readonly headline?: unknown;
  readonly bioText?: unknown;
  readonly avatarUrl?: unknown;
  readonly themeAccent?: unknown;
  readonly whatsappPhone?: unknown;
  readonly whatsappLabel?: unknown;
  readonly whatsappMessage?: unknown;
  readonly showWhatsappButton?: unknown;
}

export interface ValidatedBioLinkProfileInput {
  readonly displayName: string;
  readonly headline: string;
  readonly bioText: string;
  readonly avatarUrl: string;
  readonly themeAccent: string;
  readonly whatsappPhone: string;
  readonly whatsappLabel: string;
  readonly whatsappMessage: string;
  readonly showWhatsappButton: boolean;
}

export function validateBioLinkProfileInput(
  input: BioLinkProfileInput,
): ValidatedBioLinkProfileInput {
  const displayName =
    typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (displayName.length > 80 || hasControlChars(displayName, false)) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      "Nama tampilan maksimal 80 karakter tanpa karakter kontrol.",
    );
  }

  const headline = typeof input.headline === "string" ? input.headline.trim() : "";
  if (headline.length > 160 || hasControlChars(headline, false)) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      "Tagline maksimal 160 karakter tanpa karakter kontrol.",
    );
  }

  const bioText = typeof input.bioText === "string" ? input.bioText.trim() : "";
  if (bioText.length > 400 || hasControlChars(bioText, true)) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      "Deskripsi bio maksimal 400 karakter.",
    );
  }

  const avatarUrl =
    typeof input.avatarUrl === "string" ? validateAvatarUrl(input.avatarUrl) : "";

  const themeAccent =
    typeof input.themeAccent === "string" && input.themeAccent.trim().length > 0
      ? validateAccentHex(input.themeAccent)
      : BIO_LINKS_DEFAULT_ACCENT;

  let whatsappPhone = "";
  if (typeof input.whatsappPhone === "string" && input.whatsappPhone.trim().length > 0) {
    const phoneRes = validateIndonesianWhatsAppNumber(input.whatsappPhone);
    if (!phoneRes.ok) {
      throw new BioLinksValidationError(
        "INVALID_PHONE",
        "Nomor WhatsApp harus format Indonesia yang valid (08... atau +628...).",
      );
    }
    whatsappPhone = phoneRes.phone;
  }

  const whatsappLabel =
    typeof input.whatsappLabel === "string" && input.whatsappLabel.trim().length > 0
      ? input.whatsappLabel.trim()
      : "Hubungi via WhatsApp";
  if (whatsappLabel.length > 60 || hasControlChars(whatsappLabel, false)) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      "Label tombol WhatsApp maksimal 60 karakter.",
    );
  }

  const whatsappMessage =
    typeof input.whatsappMessage === "string" ? input.whatsappMessage.trim() : "";
  if (whatsappMessage.length > 400 || hasControlChars(whatsappMessage, true)) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      "Pesan bawaan WhatsApp maksimal 400 karakter.",
    );
  }

  const showWhatsappButton =
    typeof input.showWhatsappButton === "boolean" ? input.showWhatsappButton : true;

  return {
    displayName,
    headline,
    bioText,
    avatarUrl,
    themeAccent,
    whatsappPhone,
    whatsappLabel,
    whatsappMessage,
    showWhatsappButton,
  };
}

export interface BioLinkCreateInput {
  readonly label?: unknown;
  readonly url?: unknown;
  readonly subtitle?: unknown;
  readonly badge?: unknown;
  readonly sortOrder?: unknown;
  readonly isActive?: unknown;
}

export interface ValidatedBioLinkInput {
  readonly label: string;
  readonly url: string;
  readonly subtitle: string;
  readonly badge: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export function validateBioLinkCreateInput(input: BioLinkCreateInput): ValidatedBioLinkInput {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label.length < 1 || label.length > 80 || hasControlChars(label, false)) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      "Label tautan wajib diisi (1-80 karakter).",
    );
  }

  const rawUrl = typeof input.url === "string" ? input.url : "";
  const urlRes = validateBioLinkUrl(rawUrl);
  if (!urlRes.ok) {
    throw new BioLinksValidationError("INVALID_URL", urlRes.reason);
  }

  const subtitle = typeof input.subtitle === "string" ? input.subtitle.trim() : "";
  if (subtitle.length > 120 || hasControlChars(subtitle, false)) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      "Subjudul tautan maksimal 120 karakter.",
    );
  }

  const badge = typeof input.badge === "string" ? input.badge.trim() : "";
  if (badge.length > 24 || hasControlChars(badge, false)) {
    throw new BioLinksValidationError(
      "VALIDATION_ERROR",
      "Lencana tautan maksimal 24 karakter.",
    );
  }

  const sortOrder =
    typeof input.sortOrder === "number" &&
    Number.isInteger(input.sortOrder) &&
    input.sortOrder >= 0 &&
    input.sortOrder <= 10_000
      ? input.sortOrder
      : 0;

  const isActive = typeof input.isActive === "boolean" ? input.isActive : true;

  return {
    label,
    url: urlRes.url,
    subtitle,
    badge,
    sortOrder,
    isActive,
  };
}

export function formatJakartaDayBucket(nowMs: number): string {
  const jakartaMs = nowMs + 7 * 60 * 60 * 1000;
  const d = new Date(jakartaMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
