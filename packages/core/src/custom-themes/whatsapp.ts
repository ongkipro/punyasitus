import {
  normalizeIndonesianWhatsAppNumber,
  WA_ME_ORIGIN,
} from "../wa-dispatcher.ts";
import {
  CUSTOM_THEME_QUOTE_ONLY_PRICE_LABEL,
  CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL,
} from "./constants.ts";

/**
 * Rupiah starting-price formatter and single-encoded sales WhatsApp CTA builder
 * for the Custom Theme Service page (REQ-063, PLAN §7.3 & §11.4, TASK-061).
 */

export function formatCustomThemeIdrAmount(amountIdr: number): string {
  const safe = Math.max(0, Math.round(amountIdr));
  const grouped = String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Rp ${grouped}`;
}

/**
 * Formats a package's starting price per PLAN §11.4:
 * - Positive IDR integer -> `"Mulai dari Rp 3.500.000"`
 * - `null` -> `"Harga berdasarkan penawaran"`
 */
export function formatCustomThemeStartingPriceLabel(startingPriceIdr: number | null): string {
  if (
    startingPriceIdr === null ||
    !Number.isSafeInteger(startingPriceIdr) ||
    startingPriceIdr <= 0
  ) {
    return CUSTOM_THEME_QUOTE_ONLY_PRICE_LABEL;
  }
  return `Mulai dari ${formatCustomThemeIdrAmount(startingPriceIdr)}`;
}

export interface BuildCustomThemeWhatsAppInput {
  readonly salesWhatsapp: string | null | undefined;
  readonly tenantHandle: string;
  readonly requestCode?: string | null;
  readonly packageName?: string | null;
}

export interface CustomThemeWhatsAppLink {
  readonly url: string;
  readonly phone: string;
  readonly message: string;
}

function sanitizeInlineValue(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Builds an `https://wa.me/<digits>?text=<encoded>` sales consultation link
 * containing the tenant handle, request code (when available), and package name.
 *
 * CRITICAL INVARIANT: Encodes `text` STRICTLY ONCE (`encodeURIComponent(message)`),
 * never pre-encoding tokens or double-encoding `%25...`!
 * Returns `null` when no valid sales WhatsApp number is configured in platform settings.
 */
export function buildCustomThemeWhatsAppUrl(
  input: BuildCustomThemeWhatsAppInput,
): CustomThemeWhatsAppLink | null {
  const rawPhone = input.salesWhatsapp?.trim() ?? "";
  if (!rawPhone) {
    return null;
  }

  let phone: string;
  try {
    phone = normalizeIndonesianWhatsAppNumber(rawPhone);
  } catch {
    return null;
  }

  const handle = sanitizeInlineValue(input.tenantHandle);
  const pkg = sanitizeInlineValue(input.packageName ?? "") || CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL;
  const reqCode = input.requestCode ? sanitizeInlineValue(input.requestCode) : "";

  const lines: string[] = [
    "Halo tim PunyaSitus, saya ingin berkonsultasi mengenai jasa Desain Tema Kustom.",
    `Situs: ${handle}`,
  ];
  if (reqCode) {
    lines.push(`Kode Permintaan: ${reqCode}`);
  }
  lines.push(`Paket: ${pkg}`);

  const message = lines.join("\n");
  const url = `${WA_ME_ORIGIN}/${phone}?text=${encodeURIComponent(message)}`;
  return { url, phone, message };
}

/**
 * Computes the UTC calendar day bucket (`YYYY-MM-DD`) used for atomic
 * 3-requests-per-day-per-tenant rate limiting.
 */
export function computeCustomThemeDayBucket(nowMs: number): string {
  const safeMs = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
  return new Date(safeMs).toISOString().slice(0, 10);
}
