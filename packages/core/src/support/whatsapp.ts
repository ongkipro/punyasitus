import {
  DASHBOARD_HELP_LINKS,
  type DashboardHelpScreenId,
} from "../help/registry.ts";
import {
  normalizeIndonesianWhatsAppNumber,
  WA_ME_ORIGIN,
} from "../wa-dispatcher.ts";

/**
 * WhatsApp Support Entry Point with Context & Published Hours
 * (REQ-105, REQ-083, PLAN §20.2, TASK-105).
 *
 * Security & privacy invariants:
 * - Prefilled WhatsApp text contains STRICTLY the sanitized website `handle`
 *   and `screenName`: NEVER session tokens, CSRF tokens, passwords, API keys,
 *   cookies, emails, phone numbers, URLs, query parameters, or visitor PII.
 * - Platform support number, published support hours, and response target are
 *   sourced from `PLATFORM_DB.platform_settings`.
 * - Agency-managed websites (`agency_client_links` / REQ-083) present the
 *   agency's support contact FIRST with a clear fallback note before platform support.
 */

export const DEFAULT_SUPPORT_HOURS = "Senin–Jumat, 09.00–17.00 WIB" as const;
export const DEFAULT_SUPPORT_RESPONSE_TARGET = "Maksimal 1 hari kerja" as const;
export const DEFAULT_SUPPORT_FALLBACK_HANDLE = "situs-saya" as const;
export const DEFAULT_SUPPORT_FALLBACK_SCREEN = "Dasbor" as const;
export const MAX_SUPPORT_HANDLE_LENGTH = 63 as const;
export const MAX_SUPPORT_SCREEN_LENGTH = 80 as const;
export const MAX_RAW_SUPPORT_INPUT_LENGTH = 256 as const;

const CONTROL_AND_BIDI_RE = /[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const HTML_TAG_RE = /<[^>]{0,256}>/g;
const URL_RE = /\b(?:https?|ftp|javascript|data|mailto):\/\/?\S+|\bwww\.\S+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,128}\.[A-Za-z]{2,24}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?\b/g;
const AUTH_SCHEME_TOKEN_RE = /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const PREFIXED_SECRET_RE =
  /\b(?:sk|pk|rk|ak|whsec|ghp|gho|ghu|ghs|xoxb|xoxp|cf|ps)_(?:live|test|prod|dev)?_?[A-Za-z0-9_-]{6,}/gi;
const COOKIE_PREFIX_RE = /\b__(?:Host|Secure)-[A-Za-z0-9_-]+(?:=\S+)?/g;
const SENSITIVE_KV_RE =
  /\b(?:session(?:_?id|_?token)?|csrf(?:_?token)?|xsrf(?:_?token)?|token|auth(?:orization)?|cookie|password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|otp|totp|pin|nik|ktp|npwp|email|phone|telp?|hp|wa|whatsapp|visitor(?:_?[a-z]+)?|lead(?:_?[a-z]+)?|customer(?:_?[a-z]+)?)\s*[:=]\s*[^\s,;]+/gi;
const PHONE_NUMBER_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const OPAQUE_TOKEN_RE = /\b(?=[A-Za-z0-9_-]{20,}\b)(?:[A-Za-z]*\d+[A-Za-z0-9_-]*|\d*[A-Za-z]+[A-Za-z0-9_-]*\d+[A-Za-z0-9_-]*)\b/g;
const HANDLE_SECRET_KEYWORD_RE =
  /(?:password|passwd|secret|token|csrf|xsrf|cookie|apikey|api_key|bearer|session|eyj[a-z0-9_-]{4,}|sk_live|sk_test|pk_live|ghp_|__host-|__secure-)/i;
/**
 * Strict email validation rejecting `?`, `&`, `=`, `#`, `%`, spaces, and CRLF
 * so `mailto:` links can never suffer header/query injection.
 */
const STRICT_EMAIL_RE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

const DASHBOARD_PATH_SCREEN_MAP: Readonly<Record<string, DashboardHelpScreenId>> = {
  "": "overview",
  overview: "overview",
  beranda: "overview",
  onboarding: "onboarding",
  leads: "leads",
  prospek: "leads",
  offerings: "offering",
  offering: "offering",
  penawaran: "offering",
  "offerings/new": "offering_new",
  pages: "pages",
  halaman: "pages",
  posts: "posts",
  blog: "posts",
  media: "media",
  menus: "menus",
  appearance: "appearance",
  tampilan: "appearance",
  preview: "preview",
  plugins: "plugins",
  seo: "seo",
  settings: "settings",
  pengaturan: "settings",
  "settings/identity": "settings_identity",
  "settings/domains": "settings_domains",
  "settings/analytics": "settings_analytics",
  "settings/members": "settings_members",
  billing: "billing",
  tagihan: "billing",
  receipts: "receipts",
  kuitansi: "receipts",
  "service-status": "service_status",
  qr: "qr_code",
  "qr-code": "qr_code",
  security: "account_security",
};

export interface PlatformSupportSettingsInput {
  readonly salesWhatsapp?: string | null;
  readonly supportWhatsapp?: string | null;
  readonly supportEmail?: string | null;
  readonly supportHours?: string | null;
  readonly supportResponseTarget?: string | null;
  readonly configured?: boolean;
}

export interface ResolvedPlatformSupportSettings {
  readonly whatsappNumber: string | null;
  readonly whatsappDisplay: string | null;
  readonly whatsappConfigured: boolean;
  readonly supportEmail: string | null;
  readonly supportHours: string;
  readonly supportResponseTarget: string;
  readonly configured: boolean;
}

export interface AgencySupportContactInput {
  readonly agencyId: string;
  readonly agencyName: string;
  readonly whatsappNumber?: string | null;
  readonly email?: string | null;
  readonly supportHours?: string | null;
  readonly responseTarget?: string | null;
  readonly note?: string | null;
}

export interface SupportWhatsAppLink {
  readonly url: string;
  readonly phone: string;
  readonly message: string;
  readonly handle: string;
  readonly screenName: string;
}

export interface PlatformSupportChannelViewModel {
  readonly kind: "platform";
  readonly label: string;
  readonly whatsappNumber: string | null;
  readonly whatsappDisplay: string | null;
  readonly whatsappUrl: string | null;
  readonly email: string | null;
  readonly mailtoUrl: string | null;
  readonly supportHours: string;
  readonly responseTarget: string;
  readonly configured: boolean;
}

export interface AgencySupportChannelViewModel {
  readonly kind: "agency";
  readonly agencyId: string;
  readonly agencyName: string;
  readonly whatsappNumber: string | null;
  readonly whatsappDisplay: string | null;
  readonly whatsappUrl: string | null;
  readonly email: string | null;
  readonly mailtoUrl: string | null;
  readonly supportHours: string | null;
  readonly responseTarget: string | null;
  readonly fallbackNote: string;
}

export interface DashboardSupportViewModel {
  readonly mode: "agency_first" | "platform";
  readonly handle: string;
  readonly screenName: string;
  readonly screenId: DashboardHelpScreenId | null;
  readonly prefilledMessage: string;
  readonly primaryChannel: AgencySupportChannelViewModel | PlatformSupportChannelViewModel;
  readonly platformChannel: PlatformSupportChannelViewModel;
}

export interface ResolveDashboardSupportInput {
  readonly handle: string;
  readonly screen: DashboardHelpScreenId | string;
  readonly platformSettings?: PlatformSupportSettingsInput | null;
  readonly agencyContact?: AgencySupportContactInput | null;
}

function isDashboardHelpScreenId(value: string): value is DashboardHelpScreenId {
  return Object.prototype.hasOwnProperty.call(DASHBOARD_HELP_LINKS, value);
}

function tryNormalizeWhatsApp(rawPhone: string | null | undefined): string | null {
  if (typeof rawPhone !== "string") return null;
  const trimmed = rawPhone.trim();
  if (!trimmed) return null;
  try {
    return normalizeIndonesianWhatsAppNumber(trimmed);
  } catch {
    return null;
  }
}

function sanitizeOptionalDisplayText(
  raw: string | null | undefined,
  maxLen = 120,
): string | null {
  if (typeof raw !== "string") return null;
  const bounded = raw.slice(0, MAX_RAW_SUPPORT_INPUT_LENGTH);
  const cleaned = bounded
    .replace(CONTROL_AND_BIDI_RE, " ")
    .replace(HTML_TAG_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen).trim() || null;
}

function sanitizeOptionalEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const bounded = raw.slice(0, MAX_RAW_SUPPORT_INPUT_LENGTH);
  if (CONTROL_AND_BIDI_RE.test(bounded)) {
    CONTROL_AND_BIDI_RE.lastIndex = 0;
    return null;
  }
  CONTROL_AND_BIDI_RE.lastIndex = 0;
  const cleaned = bounded.trim().toLowerCase();
  if (
    !cleaned ||
    cleaned.length > 254 ||
    cleaned.includes("..") ||
    !STRICT_EMAIL_RE.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

/**
 * Formats canonical Indonesian E.164 digits (`6281234567890`) into a clean
 * human-readable display string (`+62 812-3456-7890`).
 */
export function formatIndonesianWhatsAppDisplay(normalizedPhone: string): string {
  const digits = normalizedPhone.replace(/\D/g, "");
  if (!digits.startsWith("62") || digits.length < 10) {
    return normalizedPhone;
  }
  const local = digits.slice(2);
  if (local.length <= 7) {
    return `+62 ${local}`;
  }
  const part1 = local.slice(0, 3);
  const part2 = local.slice(3, 7);
  const part3 = local.slice(7);
  return `+62 ${part1}-${part2}-${part3}`;
}

/**
 * Strictly sanitizes a website handle for inclusion in a support message.
 * Keeps ONLY `[a-z0-9-]` slug characters, strips URLs/queries/hashes/emails,
 * and rejects adversarial credential-shaped strings so secrets can never leak.
 */
export function sanitizeSupportHandle(rawHandle: string | null | undefined): string {
  if (typeof rawHandle !== "string") {
    return DEFAULT_SUPPORT_FALLBACK_HANDLE;
  }

  let candidate = rawHandle
    .slice(0, MAX_RAW_SUPPORT_INPUT_LENGTH)
    .replace(CONTROL_AND_BIDI_RE, " ")
    .trim();
  if (!candidate) {
    return DEFAULT_SUPPORT_FALLBACK_HANDLE;
  }

  // Strip full URL prefixes or host suffixes if someone passed a URL instead of a handle.
  candidate = candidate.replace(/^https?:\/\//i, "");
  // Cut off query strings, fragments, whitespace, credential delimiters, and path segments.
  candidate = candidate.split(/[?#\s@=;:]/, 1)[0] ?? "";
  candidate = candidate.split("/", 1)[0] ?? "";
  // If a subdomain like `kopi-nusantara.situsku.click` was passed, keep only the handle label.
  candidate = candidate.split(".", 1)[0] ?? "";

  if (HANDLE_SECRET_KEYWORD_RE.test(candidate)) {
    return DEFAULT_SUPPORT_FALLBACK_HANDLE;
  }

  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SUPPORT_HANDLE_LENGTH)
    .replace(/-+$/g, "");

  // Guard against long opaque hex/random tokens masquerading as handles.
  if (
    !normalized ||
    (/^[0-9a-f]{24,}$/.test(normalized) && !normalized.includes("-"))
  ) {
    return DEFAULT_SUPPORT_FALLBACK_HANDLE;
  }

  return normalized;
}

/**
 * Strictly sanitizes a screen identifier or label into a safe Indonesian screen name.
 * - Known `DashboardHelpScreenId` keys resolve directly to their canonical Indonesian label.
 * - Dashboard route paths (e.g. `/dashboard/<handle>/settings/domains?token=...`) strip
 *   query/hash and map to known screen labels.
 * - Arbitrary strings are stripped of URLs, query strings, JWTs, Bearer/API tokens,
 *   passwords, cookies, emails, phone numbers, and visitor PII patterns.
 */
export function sanitizeSupportScreenName(
  rawScreen: string | DashboardHelpScreenId | null | undefined,
): { readonly screenName: string; readonly screenId: DashboardHelpScreenId | null } {
  if (typeof rawScreen !== "string") {
    return { screenName: DEFAULT_SUPPORT_FALLBACK_SCREEN, screenId: null };
  }

  const trimmed = rawScreen
    .slice(0, MAX_RAW_SUPPORT_INPUT_LENGTH)
    .replace(CONTROL_AND_BIDI_RE, " ")
    .trim();
  if (!trimmed) {
    return { screenName: DEFAULT_SUPPORT_FALLBACK_SCREEN, screenId: null };
  }

  // 1. Direct canonical screen ID lookup (e.g. "settings_domains", "billing", "overview").
  if (isDashboardHelpScreenId(trimmed)) {
    return {
      screenName: DASHBOARD_HELP_LINKS[trimmed].screenLabel,
      screenId: trimmed,
    };
  }

  // 2. Dashboard path extraction (e.g. "/dashboard/kopi-nusantara/settings/domains?token=secret").
  const pathCandidate = trimmed.split(/[?#]/, 1)[0] ?? "";
  const dashboardPathMatch = /^\/dashboard\/[^/]+(?:\/(.*))?$/i.exec(pathCandidate);
  if (dashboardPathMatch) {
    const subPath = (dashboardPathMatch[1] ?? "")
      .toLowerCase()
      .replace(/^\/+|\/+$/g, "");
    const mappedDirect = DASHBOARD_PATH_SCREEN_MAP[subPath];
    if (mappedDirect) {
      return {
        screenName: DASHBOARD_HELP_LINKS[mappedDirect].screenLabel,
        screenId: mappedDirect,
      };
    }
    const firstSegment = subPath.split("/", 1)[0] ?? "";
    const mappedFirst = DASHBOARD_PATH_SCREEN_MAP[firstSegment];
    if (mappedFirst) {
      return {
        screenName: DASHBOARD_HELP_LINKS[mappedFirst].screenLabel,
        screenId: mappedFirst,
      };
    }
  }

  // 3. Aggressive stripping of query/hash tails, URLs, credentials, tokens, and PII.
  let cleaned = trimmed;
  // Remove query string or fragment appendages attached to tokens/paths.
  cleaned = cleaned.replace(/[?#]\S+/g, " ");
  cleaned = cleaned.replace(HTML_TAG_RE, " ");
  cleaned = cleaned.replace(URL_RE, " ");
  cleaned = cleaned.replace(JWT_RE, " ");
  cleaned = cleaned.replace(COOKIE_PREFIX_RE, " ");
  cleaned = cleaned.replace(PREFIXED_SECRET_RE, " ");
  cleaned = cleaned.replace(AUTH_SCHEME_TOKEN_RE, " ");
  cleaned = cleaned.replace(SENSITIVE_KV_RE, " ");
  cleaned = cleaned.replace(EMAIL_RE, " ");
  cleaned = cleaned.replace(PHONE_NUMBER_RE, " ");
  cleaned = cleaned.replace(OPAQUE_TOKEN_RE, " ");

  // Allow only clean Indonesian display punctuation and alphanumerics.
  cleaned = cleaned
    .replace(/[^A-Za-z0-9\u00C0-\u024F\s&/(),.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Remove dangling secret-only label remnants (e.g. if input was just "password" or "csrf_token").
  const cleanedWords = cleaned
    .split(" ")
    .filter((word) => {
      if (word === "&") return true;
      const bare = word.toLowerCase().replace(/[^a-z0-9_-]/g, "");
      return (
        bare.length > 0 &&
        ![
          "password",
          "passwd",
          "pwd",
          "secret",
          "token",
          "csrf",
          "xsrf",
          "cookie",
          "apikey",
          "api_key",
          "session_token",
          "bearer",
        ].includes(bare)
      );
    });

  const finalScreen = cleanedWords
    .join(" ")
    .replace(/^[-/,.\s]+|[-/,.\s]+$/g, "")
    .slice(0, MAX_SUPPORT_SCREEN_LENGTH)
    .trim();

  if (!finalScreen) {
    return { screenName: DEFAULT_SUPPORT_FALLBACK_SCREEN, screenId: null };
  }

  return { screenName: finalScreen, screenId: null };
}

/**
 * Defense-in-depth detector returning any sensitive data categories found in a
 * candidate support string (empty array means clean).
 */
export function detectSupportSensitiveDataLeaks(text: string): readonly string[] {
  const leaks: string[] = [];
  if (JWT_RE.test(text)) leaks.push("jwt");
  JWT_RE.lastIndex = 0;
  if (PREFIXED_SECRET_RE.test(text)) leaks.push("api_key");
  PREFIXED_SECRET_RE.lastIndex = 0;
  if (COOKIE_PREFIX_RE.test(text)) leaks.push("cookie");
  COOKIE_PREFIX_RE.lastIndex = 0;
  if (AUTH_SCHEME_TOKEN_RE.test(text)) leaks.push("auth_token");
  AUTH_SCHEME_TOKEN_RE.lastIndex = 0;
  if (SENSITIVE_KV_RE.test(text)) leaks.push("sensitive_kv");
  SENSITIVE_KV_RE.lastIndex = 0;
  if (EMAIL_RE.test(text)) leaks.push("email");
  EMAIL_RE.lastIndex = 0;
  if (PHONE_NUMBER_RE.test(text)) leaks.push("phone");
  PHONE_NUMBER_RE.lastIndex = 0;
  if (URL_RE.test(text)) leaks.push("url");
  URL_RE.lastIndex = 0;
  return leaks;
}

/**
 * Builds the canonical Indonesian prefilled WhatsApp support message per PLAN §20.2:
 * `"Halo, saya butuh bantuan untuk situs {handle}, halaman {screen}."`
 *
 * Strictly contains ONLY the sanitized website handle and screen name.
 */
export function buildSupportPrefilledMessage(
  rawHandle: string | null | undefined,
  rawScreen: string | DashboardHelpScreenId | null | undefined,
): {
  readonly handle: string;
  readonly screenName: string;
  readonly screenId: DashboardHelpScreenId | null;
  readonly message: string;
} {
  const handle = sanitizeSupportHandle(rawHandle);
  const { screenName, screenId } = sanitizeSupportScreenName(rawScreen);
  const candidate = `Halo, saya butuh bantuan untuk situs ${handle}, halaman ${screenName}.`;

  // Final defense-in-depth invariant check: if anything sensitive somehow survived, fall back safely.
  if (detectSupportSensitiveDataLeaks(candidate).length > 0) {
    return {
      handle: DEFAULT_SUPPORT_FALLBACK_HANDLE,
      screenName: DEFAULT_SUPPORT_FALLBACK_SCREEN,
      screenId: null,
      message: `Halo, saya butuh bantuan untuk situs ${DEFAULT_SUPPORT_FALLBACK_HANDLE}, halaman ${DEFAULT_SUPPORT_FALLBACK_SCREEN}.`,
    };
  }

  return {
    handle,
    screenName,
    screenId,
    message: candidate,
  };
}

/**
 * Builds a single-encoded `https://wa.me/<digits>?text=<encoded>` URL for
 * dashboard support using an Indonesian E.164 WhatsApp number.
 * Returns `null` when no valid WhatsApp number is configured.
 */
export function buildSupportWhatsAppUrl(input: {
  readonly phone: string | null | undefined;
  readonly handle: string | null | undefined;
  readonly screen: string | DashboardHelpScreenId | null | undefined;
}): SupportWhatsAppLink | null {
  const phone = tryNormalizeWhatsApp(input.phone);
  if (!phone) {
    return null;
  }

  const { handle, screenName, message } = buildSupportPrefilledMessage(
    input.handle,
    input.screen,
  );
  const url = `${WA_ME_ORIGIN}/${phone}?text=${encodeURIComponent(message)}`;

  return {
    url,
    phone,
    message,
    handle,
    screenName,
  };
}

/**
 * Normalizes platform support settings read from `PLATFORM_DB.platform_settings`
 * (`platform.public_settings`) with safe Indonesian defaults for hours & response target.
 */
export function resolvePlatformSupportSettings(
  raw: PlatformSupportSettingsInput | null | undefined,
): ResolvedPlatformSupportSettings {
  const normalizedPhone =
    tryNormalizeWhatsApp(raw?.supportWhatsapp) ?? tryNormalizeWhatsApp(raw?.salesWhatsapp);
  const supportEmail = sanitizeOptionalEmail(raw?.supportEmail);
  const supportHours =
    sanitizeOptionalDisplayText(raw?.supportHours, 120) ?? DEFAULT_SUPPORT_HOURS;
  const supportResponseTarget =
    sanitizeOptionalDisplayText(raw?.supportResponseTarget, 120) ??
    DEFAULT_SUPPORT_RESPONSE_TARGET;

  return {
    whatsappNumber: normalizedPhone,
    whatsappDisplay: normalizedPhone ? formatIndonesianWhatsAppDisplay(normalizedPhone) : null,
    whatsappConfigured: normalizedPhone !== null,
    supportEmail,
    supportHours,
    supportResponseTarget,
    configured: Boolean(raw?.configured && normalizedPhone),
  };
}

export function buildSafeMailtoUrl(
  email: string | null | undefined,
  handle: string,
  screenName: string,
): string | null {
  const safeEmail = sanitizeOptionalEmail(email);
  if (!safeEmail) return null;

  const atIndex = safeEmail.indexOf("@");
  if (atIndex <= 0 || atIndex === safeEmail.length - 1) return null;
  const localPart = safeEmail.slice(0, atIndex);
  const domainPart = safeEmail.slice(atIndex + 1);
  const safeHandle = sanitizeSupportHandle(handle);
  const safeScreen = sanitizeSupportScreenName(screenName).screenName;
  const subject = `Bantuan situs ${safeHandle} (${safeScreen})`;
  return `mailto:${encodeURIComponent(localPart)}@${encodeURIComponent(domainPart)}?subject=${encodeURIComponent(subject)}`;
}

/**
 * Resolves the complete dashboard support view model for a signed-in user:
 * - Standard website -> platform WhatsApp number, published hours, and response target.
 * - Agency-managed website (REQ-083 / REQ-105) -> agency contact FIRST (WhatsApp / email
 *   and clear guidance), with platform support available strictly as a secondary fallback.
 */
export function resolveDashboardSupportModel(
  input: ResolveDashboardSupportInput,
): DashboardSupportViewModel {
  const context = buildSupportPrefilledMessage(input.handle, input.screen);
  const platform = resolvePlatformSupportSettings(input.platformSettings);

  const platformWaLink = platform.whatsappNumber
    ? buildSupportWhatsAppUrl({
        phone: platform.whatsappNumber,
        handle: context.handle,
        screen: context.screenName,
      })
    : null;

  const platformChannel: PlatformSupportChannelViewModel = {
    kind: "platform",
    label: "Tim Dukungan PunyaSitus",
    whatsappNumber: platform.whatsappNumber,
    whatsappDisplay: platform.whatsappDisplay,
    whatsappUrl: platformWaLink?.url ?? null,
    email: platform.supportEmail,
    mailtoUrl: buildSafeMailtoUrl(platform.supportEmail, context.handle, context.screenName),
    supportHours: platform.supportHours,
    responseTarget: platform.supportResponseTarget,
    configured: platform.whatsappConfigured,
  };

  const agency = input.agencyContact;
  const agencyName = sanitizeOptionalDisplayText(agency?.agencyName, 100);
  const agencyId = agency?.agencyId?.trim() ?? "";

  if (agency && agencyId && agencyName) {
    const agencyPhone = tryNormalizeWhatsApp(agency.whatsappNumber);
    const agencyWaLink = agencyPhone
      ? buildSupportWhatsAppUrl({
          phone: agencyPhone,
          handle: context.handle,
          screen: context.screenName,
        })
      : null;
    const agencyEmail = sanitizeOptionalEmail(agency.email);
    const agencyHours = sanitizeOptionalDisplayText(agency.supportHours, 120);
    const agencyTarget = sanitizeOptionalDisplayText(agency.responseTarget, 120);
    const customNote = sanitizeOptionalDisplayText(agency.note, 220);

    const fallbackNote =
      customNote ??
      (agencyWaLink || agencyEmail
        ? `Situs ini dikelola oleh agensi ${agencyName}. Hubungi agensi Anda terlebih dahulu untuk bantuan konten, desain, atau tagihan.`
        : `Situs ini dikelola oleh agensi ${agencyName}. Hubungi pengelola agensi Anda terlebih dahulu; dukungan teknis platform tersedia di bawah sebagai cadangan.`);

    const agencyChannel: AgencySupportChannelViewModel = {
      kind: "agency",
      agencyId,
      agencyName,
      whatsappNumber: agencyPhone,
      whatsappDisplay: agencyPhone ? formatIndonesianWhatsAppDisplay(agencyPhone) : null,
      whatsappUrl: agencyWaLink?.url ?? null,
      email: agencyEmail,
      mailtoUrl: buildSafeMailtoUrl(agencyEmail, context.handle, context.screenName),
      supportHours: agencyHours,
      responseTarget: agencyTarget,
      fallbackNote,
    };

    return {
      mode: "agency_first",
      handle: context.handle,
      screenName: context.screenName,
      screenId: context.screenId,
      prefilledMessage: context.message,
      primaryChannel: agencyChannel,
      platformChannel,
    };
  }

  return {
    mode: "platform",
    handle: context.handle,
    screenName: context.screenName,
    screenId: context.screenId,
    prefilledMessage: context.message,
    primaryChannel: platformChannel,
    platformChannel,
  };
}
