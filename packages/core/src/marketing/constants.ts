import {
  BILLING_CURRENCY,
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
  NO_REFUND_NOTICE,
  NON_PKP_TAX_NOTICE,
} from "../billing/constants.ts";

/**
 * Canonical constants for the PunyaSitus platform marketing surface (`punyasitus.com`),
 * synthetic demo tenants, and cookieless funnel analytics (REQ-087, PLAN §19.5, TASK-087).
 */

export const FUNNEL_STAGES = [
  "visit",
  "demo_view",
  "signup_start",
  "email_verified",
  "trial_created",
  "first_payment",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_STAGE_LABELS: Readonly<Record<FunnelStage, string>> = {
  visit: "Kunjungan Situs",
  demo_view: "Lihat Demo Tema",
  signup_start: "Mulai Pendaftaran",
  email_verified: "Email Terverifikasi",
  trial_created: "Trial 7 Hari Aktif",
  first_payment: "Pembayaran Pertama",
};

export const FUNNEL_STAGE_DESCRIPTIONS: Readonly<Record<FunnelStage, string>> = {
  visit: "Kunjungan agregat harian ke halaman pemasaran punyasitus.com.",
  demo_view: "Kunjungan agregat ke salah satu dari 6 situs demo vertikal.",
  signup_start: "Klik atau mulai alur pendaftaran akun baru di app.punyasitus.com.",
  email_verified: "Akun baru menyelesaikan verifikasi email atau Google Sign-In.",
  trial_created: "Workspace situs uji coba 7 hari berhasil diprovisioning.",
  first_payment: "Pembayaran langganan pertama terkonfirmasi lunas.",
};

export const DEMO_THEME_SLUGS = [
  "compro",
  "sales",
  "travel",
  "catalog",
  "resto",
  "dealer",
] as const;

export type DemoThemeSlug = (typeof DEMO_THEME_SLUGS)[number];

export const MARKETING_JS_BUDGET_GZIP_BYTES = 25 * 1024; // 25 KiB gzipped (REQ-040, TASK-087)
export const DEFAULT_TRIAL_DAYS = 7 as const;

export const MARKETING_URLS = {
  apexOrigin: "https://punyasitus.com",
  appSignup: "https://app.punyasitus.com/auth/signup",
  appLogin: "https://app.punyasitus.com/auth/login",
} as const;

export const DEFAULT_MARKETING_CONTACT = {
  salesWhatsapp: "6281200000000",
  supportEmail: "halo@punyasitus.com",
  supportHours: "Senin–Jumat, 09.00–17.00 WIB",
  supportResponseTarget: "Maksimal 1 hari kerja",
} as const;

export const DEMO_READ_ONLY_ERROR_CODE = "DEMO_READ_ONLY" as const;
export const DEMO_BANNER_TITLE = "Situs Demo PunyaSitus — Contoh Tampilan" as const;

export const FUNNEL_RANGE_OPTIONS = [7, 30, 90] as const;
export type FunnelRangeDays = (typeof FUNNEL_RANGE_OPTIONS)[number];

export const MARKETING_PRICING_DEFAULTS = {
  monthlyPriceIdr: DEFAULT_MONTHLY_PRICE_IDR,
  yearlyPriceIdr: DEFAULT_YEARLY_PRICE_IDR,
  trialDays: DEFAULT_TRIAL_DAYS,
  currency: BILLING_CURRENCY,
  nonPkpDisclosure: NON_PKP_TAX_NOTICE,
  noRefundDisclosure: NO_REFUND_NOTICE,
} as const;

/**
 * Formats an integer Indonesian Rupiah value deterministically without locale drift.
 * Example: `179000` -> `"Rp 179.000"`.
 */
export function formatIdr(amountIdr: number): string {
  const safe = Number.isFinite(amountIdr) ? Math.trunc(amountIdr) : 0;
  const negative = safe < 0;
  const digits = String(Math.abs(safe));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return negative ? `-Rp ${grouped}` : `Rp ${grouped}`;
}

/**
 * Safely serializes JSON-LD for inline `<script type="application/ld+json">`,
 * escaping `<`, `>`, `&`, and Unicode line separators so dynamic values can never
 * break out of the script element.
 */
export function safeJsonLdStringify(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
