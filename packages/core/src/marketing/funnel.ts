import {
  DEMO_THEME_SLUGS,
  FUNNEL_RANGE_OPTIONS,
  FUNNEL_STAGES,
  type DemoThemeSlug,
  type FunnelRangeDays,
  type FunnelStage,
} from "./constants.ts";

/**
 * Cookieless first-party funnel validation, source-channel sanitization & conversion math
 * (REQ-087, PLAN §19.5, TASK-087).
 *
 * Privacy invariants:
 * - Strictly rejects any PII / visitor-identifying keys (`ip`, `email`, `phone`, `cookie`, etc.).
 * - Drops email-like or phone-like values in `sourceChannel` back to `"direct"`.
 * - Never generates or persists session/visitor IDs.
 */

const FUNNEL_STAGE_SET: ReadonlySet<string> = new Set(FUNNEL_STAGES);
const DEMO_THEME_SET: ReadonlySet<string> = new Set(DEMO_THEME_SLUGS);

export const FORBIDDEN_FUNNEL_KEYS: ReadonlySet<string> = new Set([
  "ip",
  "ipAddress",
  "ip_address",
  "email",
  "phone",
  "whatsapp",
  "name",
  "fullName",
  "full_name",
  "userId",
  "user_id",
  "visitorId",
  "visitor_id",
  "sessionId",
  "session_id",
  "cookie",
  "cookies",
  "fingerprint",
  "userAgent",
  "user_agent",
  "rawUrl",
  "rawReferrer",
  "__proto__",
  "constructor",
  "prototype",
]);

const ALLOWED_FUNNEL_KEYS: ReadonlySet<string> = new Set([
  "stage",
  "sourceChannel",
  "themeSlug",
]);

/**
 * Closed allowlist of canonical source-channel buckets stored in `marketing_funnel_daily`.
 * Any arbitrary or unknown `utm_source` collapses to `"other"`, preventing unbounded PK row growth.
 */
export const FUNNEL_SOURCE_CHANNELS = [
  "direct",
  "organic_search",
  "paid",
  "social",
  "whatsapp",
  "referral",
  "ai_assistant",
  "other",
] as const;

export type FunnelSourceChannel = (typeof FUNNEL_SOURCE_CHANNELS)[number];

const DAY_UTC_RE = /^\d{4}-\d{2}-\d{2}$/;
const LONG_DIGIT_RUN_RE = /\d{7,}/;

const PAID_TOKENS = new Set([
  "paid",
  "cpc",
  "ppc",
  "ads",
  "sem",
  "google_ads",
  "google-ads",
  "meta_ads",
  "meta-ads",
  "fb_ads",
  "ig_ads",
  "tiktok_ads",
  "tiktok-ads",
]);

const AI_ASSISTANT_HOSTS = new Set([
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "perplexity.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
]);

const SEARCH_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "google.co.id",
  "www.google.co.id",
  "bing.com",
  "www.bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
]);

const SOCIAL_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "l.instagram.com",
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "l.facebook.com",
  "tiktok.com",
  "www.tiktok.com",
  "linkedin.com",
  "www.linkedin.com",
  "youtube.com",
  "www.youtube.com",
  "x.com",
  "t.co",
  "threads.net",
]);

export interface ValidatedFunnelEventInput {
  readonly stage: FunnelStage;
  readonly sourceChannel: FunnelSourceChannel;
  readonly themeSlug: DemoThemeSlug | "";
}

export type FunnelValidationResult =
  | { readonly ok: true; readonly data: ValidatedFunnelEventInput }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function parseFunnelStage(raw: unknown): FunnelStage | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!FUNNEL_STAGE_SET.has(trimmed)) return null;
  return trimmed as FunnelStage;
}

export function sanitizeThemeSlug(raw: unknown): DemoThemeSlug | "" {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().toLowerCase();
  return DEMO_THEME_SET.has(trimmed) ? (trimmed as DemoThemeSlug) : "";
}

/**
 * Normalizes a traffic source token or referrer host into a closed, PII-free canonical bucket
 * (`direct | organic_search | paid | social | whatsapp | referral | ai_assistant | other`).
 * Email/phone/PII-looking tokens collapse to `"direct"`; arbitrary unknown tokens collapse to `"other"`.
 */
export function sanitizeSourceChannel(raw: unknown): FunnelSourceChannel {
  if (typeof raw !== "string") return "direct";
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "direct") return "direct";

  // Reject anything that looks like an email address, phone number, or query string with PII.
  if (
    trimmed.includes("@") ||
    trimmed.includes("?") ||
    trimmed.includes("=") ||
    LONG_DIGIT_RUN_RE.test(trimmed)
  ) {
    return "direct";
  }

  if (AI_ASSISTANT_HOSTS.has(trimmed) || trimmed === "ai-assistant" || trimmed === "ai_assistant") {
    return "ai_assistant";
  }
  if (
    SEARCH_HOSTS.has(trimmed) ||
    trimmed === "google" ||
    trimmed === "bing" ||
    trimmed === "organic" ||
    trimmed === "organic_search"
  ) {
    return "organic_search";
  }
  if (PAID_TOKENS.has(trimmed)) {
    return "paid";
  }
  if (
    SOCIAL_HOSTS.has(trimmed) ||
    trimmed === "social" ||
    trimmed === "ig" ||
    trimmed === "fb" ||
    trimmed === "tiktok"
  ) {
    return "social";
  }
  if (trimmed === "wa" || trimmed === "whatsapp" || trimmed === "wa.me") {
    return "whatsapp";
  }
  if (trimmed === "ref" || trimmed === "referral" || trimmed === "affiliate") {
    return "referral";
  }

  return "other";
}

export function formatUtcDay(timestampMs: number = Date.now()): string {
  const safeMs = Number.isFinite(timestampMs) ? Math.trunc(timestampMs) : Date.now();
  const date = new Date(safeMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isValidUtcDay(dayUtc: unknown): dayUtc is string {
  if (typeof dayUtc !== "string" || !DAY_UTC_RE.test(dayUtc)) return false;
  const parsed = Date.parse(`${dayUtc}T00:00:00.000Z`);
  return Number.isFinite(parsed) && formatUtcDay(parsed) === dayUtc;
}

export function parseFunnelRangeDays(raw: unknown): FunnelRangeDays {
  const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  for (const allowed of FUNNEL_RANGE_OPTIONS) {
    if (num === allowed) return allowed;
  }
  return 30;
}

export function validateFunnelEventPayload(rawBody: unknown): FunnelValidationResult {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: "Payload funnel harus berupa objek JSON.",
    };
  }

  const record = rawBody as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_FUNNEL_KEYS.has(key)) {
      return {
        ok: false,
        code: "PII_FIELD_FORBIDDEN",
        message: `Field "${key}" dilarang pada pelacakan funnel tanpa cookie/PII.`,
      };
    }
    if (!ALLOWED_FUNNEL_KEYS.has(key)) {
      return {
        ok: false,
        code: "UNKNOWN_FIELD",
        message: `Field tidak dikenal "${key}".`,
      };
    }
  }

  const stage = parseFunnelStage(record.stage);
  if (!stage) {
    return {
      ok: false,
      code: "INVALID_STAGE",
      message: `Tahap funnel tidak valid. Gunakan salah satu: ${FUNNEL_STAGES.join(", ")}.`,
    };
  }

  if (
    record.themeSlug !== undefined &&
    record.themeSlug !== null &&
    record.themeSlug !== "" &&
    sanitizeThemeSlug(record.themeSlug) === ""
  ) {
    return {
      ok: false,
      code: "INVALID_THEME_SLUG",
      message: `Slug tema tidak valid. Gunakan salah satu: ${DEMO_THEME_SLUGS.join(", ")}.`,
    };
  }

  return {
    ok: true,
    data: {
      stage,
      sourceChannel: sanitizeSourceChannel(record.sourceChannel),
      themeSlug: sanitizeThemeSlug(record.themeSlug),
    },
  };
}

/**
 * Computes a safe 1-decimal percentage (`0.0` .. `999.9`). Returns `0` when denominator <= 0.
 */
export function computeConversionRatePct(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0 || numerator <= 0) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(1));
}
