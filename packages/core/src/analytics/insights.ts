import {
  AI_ASSISTANT_HOST_MAP,
  AI_ASSISTANT_UTM_MEDIUMS,
  extractNormalizedReferrerHost,
  matchesHostnameExactOrSubdomain,
  type HourlySourceBucket,
} from "./attribution.ts";

/**
 * First-Party Insights Pure Engine: Bot UA Drop, Source Classification,
 * Tab-Scoped Arrival Source Persistence, and Dynamic UTC-to-Tenant-Timezone Projection
 * (`packages/core/src/analytics/insights.ts`; TASK-072, REQ-073, REQ-017, REQ-039, PLAN §7.3, §18.4).
 *
 * Privacy-by-design invariants:
 * - ZERO cookies, IP addresses, full User-Agent strings, raw referrer query/paths,
 *   or visitor/session identifiers are ever persisted.
 * - Tab-scoped arrival source uses `sessionStorage` ONLY when an external arrival signal
 *   (external referrer host or sanitized UTM source) is present, preserving source across
 *   same-site navigation without writing storage on plain direct visits.
 * - Hourly buckets are stored in UTC (`day_utc`, `utc_hour` 0..23) and dynamically projected
 *   into the tenant's configured IANA timezone at query time without rewriting rows.
 */

export const INSIGHTS_ESTIMATE_LABEL_ID =
  "Estimasi agregat harian tanpa pelacakan individu — sinyal minat, bukan transaksi terkonfirmasi";

export const INSIGHT_SOURCE_BUCKETS = [
  "search",
  "social",
  "campaign",
  "ai_assistant",
  "referral",
  "direct",
] as const;

export type InsightSourceBucket = (typeof INSIGHT_SOURCE_BUCKETS)[number];

export const INSIGHT_CONTENT_KINDS = [
  "page",
  "post",
  "offering",
  "taxonomy",
  "other",
] as const;

export type InsightContentKind = (typeof INSIGHT_CONTENT_KINDS)[number];

export const INSIGHT_SOURCE_LABELS_ID: Readonly<Record<InsightSourceBucket, string>> = {
  search: "Pencarian",
  social: "Media Sosial",
  campaign: "Kampanye",
  ai_assistant: "AI Assistant",
  referral: "Rujukan",
  direct: "Langsung / Tidak Diketahui",
};

export const INSIGHT_CONTENT_KIND_LABELS_ID: Readonly<Record<InsightContentKind, string>> = {
  page: "Halaman",
  post: "Artikel",
  offering: "Katalog / Penawaran",
  taxonomy: "Arsip / Kategori",
  other: "Lainnya",
};

export const ARRIVAL_SOURCE_SESSION_KEY = "ps_arrival_source_v1";
export const DEFAULT_INSIGHTS_TIMEZONE = "Asia/Jakarta";
export const MAX_UTM_TOKEN_LENGTH = 50;

const SAFE_UTM_TOKEN_RE = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const EMAIL_RE = /@/;
const PHONE_RE = /(?:^|[^0-9])(?:\+?62|0)8[0-9]{7,12}(?:$|[^0-9])|[0-9]{10,}/;
const QUERY_OR_URL_CHAR_RE = /[?&#=/:\\\s<>"';(){}]/;
const UUID_LIKE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX_HASH_12_RE = /^(?:[a-z]{1,2}[_-]?)?[0-9a-f]{10,}$/i;
const EMBEDDED_HEX_12_RE = /(?:^|[^a-z0-9])[0-9a-f]{12,}(?:$|[^a-z0-9])/i;
const FIVE_PLUS_DIGITS_RUN_RE = /\d{5,}/;
const YEAR_TOKEN_RE = /(?:^|[_.-])(?:19|20)\d{2}(?=$|[_.-])/g;

const AI_ASSISTANT_UTM_SOURCE_SET: ReadonlySet<string> = new Set([
  "chatgpt",
  "chatgpt.com",
  "chat.openai.com",
  "claude",
  "claude.ai",
  "perplexity",
  "perplexity.ai",
  "gemini",
  "gemini.google.com",
  "copilot",
  "copilot.microsoft.com",
]);

const SEARCH_HOSTS: readonly string[] = [
  "google.com",
  "google.co.id",
  "google.co.uk",
  "google.com.sg",
  "google.com.my",
  "google.com.au",
  "google.co.jp",
  "bing.com",
  "search.yahoo.com",
  "id.search.yahoo.com",
  "yahoo.com",
  "duckduckgo.com",
  "yandex.com",
  "yandex.ru",
  "baidu.com",
  "ecosia.org",
  "search.brave.com",
  "startpage.com",
  "qwant.com",
  "ask.com",
] as const;

const SOCIAL_HOSTS: readonly string[] = [
  "facebook.com",
  "fb.com",
  "m.facebook.com",
  "l.facebook.com",
  "lm.facebook.com",
  "instagram.com",
  "l.instagram.com",
  "twitter.com",
  "x.com",
  "t.co",
  "linkedin.com",
  "lnkd.in",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "pinterest.com",
  "threads.net",
  "reddit.com",
  "whatsapp.com",
  "wa.me",
  "t.me",
  "telegram.org",
] as const;

/**
 * Known crawler, bot, CLI HTTP client, and headless scraper User-Agent signatures.
 * Matched case-insensitively on request `User-Agent` header BEFORE any counter writes.
 * Empty/missing UAs return `false` so legitimate privacy-stripped requests & internal tests work.
 */
const BOT_USER_AGENT_PATTERNS: readonly RegExp[] = [
  /\bgooglebot\b/i,
  /\bbingbot\b/i,
  /\bslurp\b/i,
  /\bduckduckbot\b/i,
  /\bbaiduspider\b/i,
  /\byandex(?:bot|images|mobilebot)\b/i,
  /\bsogou\b/i,
  /\bexabot\b/i,
  /\bfacebot\b/i,
  /\bfacebookexternalhit\b/i,
  /\bia_archiver\b/i,
  /\bapplebot\b/i,
  /\bpetalbot\b/i,
  /\bsemrushbot\b/i,
  /\bahrefsbot\b/i,
  /\bmj12bot\b/i,
  /\bdotbot\b/i,
  /\bbytespider\b/i,
  /\bccbot\b/i,
  /\bamazonbot\b/i,
  /\bmeta-externalagent\b/i,
  /\boai-searchbot\b/i,
  /\bgptbot\b/i,
  /\bchatgpt-user\b/i,
  /\bclaude(?:bot|-web|-searchbot|-user)\b/i,
  /\bperplexitybot\b/i,
  /\btwitterbot\b/i,
  /\blinkedinbot\b/i,
  /\btelegrambot\b/i,
  /\bdiscordbot\b/i,
  /\bslackbot\b/i,
  /\bwhatsapp\//i,
  /\bscreaming frog\b/i,
  /\bcurl\//i,
  /\bwget\//i,
  /\bpython-requests\b/i,
  /\bpython-urllib\b/i,
  /\bhttpx\//i,
  /\baiohttp\//i,
  /\bgo-http-client\b/i,
  /\bapache-httpclient\b/i,
  /\bokhttp\//i,
  /\bnode-fetch\b/i,
  /\bundici\b/i,
  /\baxios\//i,
  /\blibwww-perl\b/i,
  /\bscrapy\b/i,
  /\bheadlesschrome\b/i,
  /\bphantomjs\b/i,
  /\bslimerjs\b/i,
  /\bpuppeteer\b/i,
  /\bplaywright\b/i,
  /\bselenium\b/i,
  /\bwebdriver\b/i,
  /\blighthouse\b/i,
  /\bchrome-lighthouse\b/i,
  /\bpagespeed\b/i,
  /\bgtmetrix\b/i,
  /\bpingdom\b/i,
  /\buptimerobot\b/i,
  /\bstatuscake\b/i,
  /\bdatadog\b/i,
  /\bcheck_http\b/i,
  /\b(?:crawl|crawler|spider|scraper|archiver|bot)\b/i,
] as const;

/**
 * Classifies whether an HTTP `User-Agent` header belongs to a known crawler, bot,
 * CLI HTTP client, or headless scraper that should be quietly dropped (`204`) before
 * incrementing first-party analytics aggregates.
 *
 * NEVER stores or logs the User-Agent string.
 */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (typeof userAgent !== "string") return false;
  const trimmed = userAgent.trim();
  if (trimmed.length === 0) return false;
  const bounded = trimmed.slice(0, 512);
  for (const pattern of BOT_USER_AGENT_PATTERNS) {
    if (pattern.test(bounded)) {
      return true;
    }
  }
  return false;
}

/**
 * Detects personalized visitor IDs, UUIDs, hex hashes, or high-digit identifier tokens
 * (e.g. `u8f3a9c12b4e`, `sub-48213`, `550e8400-e29b-41d4-a716-446655440000`, `deadbeef1234`)
 * while preserving legitimate campaign tokens (`promo_lebaran`, `ig_q4_2026`, `google_ads`).
 */
export function isLikelyIdentifierOrHashToken(token: string): boolean {
  const lower = token.trim().toLowerCase();
  if (!lower) return false;
  if (UUID_LIKE_RE.test(lower)) return true;
  if (FIVE_PLUS_DIGITS_RUN_RE.test(lower)) return true;
  if (EMBEDDED_HEX_12_RE.test(lower) && /\d/.test(lower)) return true;

  const digitMatches = lower.match(/\d/g);
  const totalDigits = digitMatches ? digitMatches.length : 0;
  if (HEX_HASH_12_RE.test(lower) && totalDigits >= 2) {
    return true;
  }

  // Strip valid calendar years (e.g. `_2026`, `-2025`) before counting remaining digits
  // so legitimate tokens like `ig_q4_2026` stay allowed while `u8f3a9c12b4e` is stripped.
  const withoutYears = lower.replace(YEAR_TOKEN_RE, "");
  const remainingDigits = (withoutYears.match(/\d/g) ?? []).length;
  if (remainingDigits >= 5) {
    return true;
  }

  return false;
}

/**
 * Normalizes a hostname for same-site comparison by lowercasing, stripping trailing dot,
 * and removing a leading `www.` prefix (`www.example.com` <-> `example.com`).
 */
export function normalizeHostForSameSiteComparison(rawHost: string | null | undefined): string | null {
  const host = extractNormalizedReferrerHost(rawHost);
  if (!host) return null;
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Sanitizes a coarse UTM token (`utm_source` or `utm_medium`) to 1-50 lowercase safe chars,
 * strictly rejecting emails, phone numbers, query characters, URLs, control characters,
 * and visitor-ID / hash tokens (UUIDs, hex hashes, high-digit IDs).
 */
export function sanitizeInsightUtmToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let cleaned = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      cleaned += raw[i];
    }
  }
  const normalized = cleaned.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_UTM_TOKEN_LENGTH) {
    return null;
  }
  if (
    EMAIL_RE.test(normalized) ||
    QUERY_OR_URL_CHAR_RE.test(normalized) ||
    PHONE_RE.test(normalized)
  ) {
    return null;
  }
  if (!SAFE_UTM_TOKEN_RE.test(normalized)) {
    return null;
  }
  if (isLikelyIdentifierOrHashToken(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Strictly validates a bare lowercase referrer hostname (no protocol, path, query, port, or PII).
 */
export function sanitizeBareReferrerHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253) return null;
  if (trimmed.includes("://") || /[/?#\\@<>"':\s]/.test(trimmed)) {
    return null;
  }
  if (PHONE_RE.test(trimmed)) return null;
  return extractNormalizedReferrerHost(trimmed);
}

function isAiAssistantHost(hostname: string): boolean {
  for (const domain of Object.keys(AI_ASSISTANT_HOST_MAP)) {
    if (matchesHostnameExactOrSubdomain(hostname, domain)) {
      return true;
    }
  }
  return false;
}

function isSearchHost(hostname: string): boolean {
  if (isAiAssistantHost(hostname)) return false;
  for (const domain of SEARCH_HOSTS) {
    if (matchesHostnameExactOrSubdomain(hostname, domain)) {
      return true;
    }
  }
  if (/^(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(hostname)) {
    return true;
  }
  return false;
}

function isSocialHost(hostname: string): boolean {
  for (const domain of SOCIAL_HOSTS) {
    if (matchesHostnameExactOrSubdomain(hostname, domain)) {
      return true;
    }
  }
  return false;
}

export interface ClassifyInsightSourceInput {
  /** Full referrer URL (`document.referrer`) or bare hostname. */
  readonly referrer?: string | null;
  /** Pre-parsed bare referrer host (host-only). */
  readonly referrerHost?: string | null;
  readonly utmSource?: string | null;
  readonly utmMedium?: string | null;
  /** Explicit coarse source category (used when neither referrerHost nor utmSource is supplied). */
  readonly sourceCategory?: InsightSourceBucket | null;
  /** Current tenant site hostname (same-site referrers incl. `www.` are stripped). */
  readonly siteHost?: string | null;
  /** Optional list of all hostnames owned by this tenant (subdomain + custom domain + `www.`). */
  readonly siteHosts?: readonly string[];
  readonly tenantHosts?: readonly string[];
}

export interface ClassifiedInsightSource {
  readonly sourceBucket: InsightSourceBucket;
  readonly hourlySourceBucket: HourlySourceBucket;
  readonly label: string;
  readonly referrerHost: string | null;
  readonly utmSource: string;
  readonly utmMedium: string | null;
}

export function mapInsightBucketToHourlySourceBucket(
  bucket: InsightSourceBucket,
): HourlySourceBucket {
  switch (bucket) {
    case "search":
      return "organic_search";
    case "social":
      return "social";
    case "campaign":
      return "campaign";
    case "ai_assistant":
      return "ai_assistant";
    case "referral":
      return "referral";
    case "direct":
      return "direct";
  }
}

/**
 * Classifies a visitor arrival into a coarse privacy-safe traffic source bucket
 * (`search`, `social`, `campaign`, `ai_assistant`, `referral`, `direct`).
 *
 * Rules (PRD REQ-073, PLAN §18.4, TASK-072):
 * - Drops same-site referrers (`siteHost` / `tenantHosts`).
 * - AI assistant hosts/UTMs map to `ai_assistant`.
 * - Any non-AI `utm_source` (or paid/campaign `utm_medium`) maps to `campaign` with
 *   sanitized coarse `utmSource` token preserved (unless `utmMedium === "organic"`).
 * - External search engine hostnames map to `search`.
 * - External social hostnames map to `social`.
 * - Other external hostnames map to `referral`.
 * - Empty referrer + no UTM maps to `direct` ("Langsung / Tidak Diketahui").
 */
export function classifyInsightSource(input: ClassifyInsightSourceInput): ClassifiedInsightSource {
  const rawUtmSourceTrimmed = typeof input.utmSource === "string" ? input.utmSource.trim() : "";
  const rawUtmMediumTrimmed = typeof input.utmMedium === "string" ? input.utmMedium.trim() : "";
  const utmSource = sanitizeInsightUtmToken(input.utmSource);
  const utmMedium = sanitizeInsightUtmToken(input.utmMedium);
  const hadStrippedIdentifierUtmSource =
    rawUtmSourceTrimmed.length > 0 &&
    utmSource === null &&
    !EMAIL_RE.test(rawUtmSourceTrimmed) &&
    !QUERY_OR_URL_CHAR_RE.test(rawUtmSourceTrimmed) &&
    SAFE_UTM_TOKEN_RE.test(rawUtmSourceTrimmed.toLowerCase());
  const hadStrippedIdentifierUtmMedium =
    rawUtmMediumTrimmed.length > 0 &&
    utmMedium === null &&
    !EMAIL_RE.test(rawUtmMediumTrimmed) &&
    !QUERY_OR_URL_CHAR_RE.test(rawUtmMediumTrimmed) &&
    SAFE_UTM_TOKEN_RE.test(rawUtmMediumTrimmed.toLowerCase());

  let referrerHost = extractNormalizedReferrerHost(input.referrer ?? input.referrerHost);

  if (referrerHost) {
    const ownHosts = new Set<string>();
    const addOwnHost = (raw: string | null | undefined) => {
      const normalized = normalizeHostForSameSiteComparison(raw);
      if (normalized) ownHosts.add(normalized);
    };
    addOwnHost(input.siteHost);
    if (input.siteHosts) {
      for (const host of input.siteHosts) addOwnHost(host);
    }
    if (input.tenantHosts) {
      for (const host of input.tenantHosts) addOwnHost(host);
    }
    const normalizedRef = normalizeHostForSameSiteComparison(referrerHost);
    if (normalizedRef && ownHosts.has(normalizedRef)) {
      referrerHost = null;
    }
  }

  let sourceBucket: InsightSourceBucket;

  const isAiRef = referrerHost !== null && isAiAssistantHost(referrerHost);
  const isAiUtmSource = utmSource !== null && AI_ASSISTANT_UTM_SOURCE_SET.has(utmSource);
  const isAiUtmMedium = utmMedium !== null && AI_ASSISTANT_UTM_MEDIUMS.has(utmMedium);

  if (isAiRef || isAiUtmSource || isAiUtmMedium) {
    sourceBucket = "ai_assistant";
  } else if (utmMedium === "organic") {
    sourceBucket = "search";
  } else if (
    utmSource !== null ||
    utmMedium !== null ||
    hadStrippedIdentifierUtmSource ||
    hadStrippedIdentifierUtmMedium
  ) {
    // Explicit UTM-tagged campaign arrival (identifier/hash tokens stripped to "" while keeping coarse campaign bucket)
    sourceBucket = "campaign";
  } else if (referrerHost !== null && isSearchHost(referrerHost)) {
    sourceBucket = "search";
  } else if (referrerHost !== null && isSocialHost(referrerHost)) {
    sourceBucket = "social";
  } else if (referrerHost !== null) {
    sourceBucket = "referral";
  } else if (
    input.sourceCategory &&
    (INSIGHT_SOURCE_BUCKETS as readonly string[]).includes(input.sourceCategory)
  ) {
    sourceBucket = input.sourceCategory;
  } else {
    sourceBucket = "direct";
  }

  return {
    sourceBucket,
    hourlySourceBucket: mapInsightBucketToHourlySourceBucket(sourceBucket),
    label: INSIGHT_SOURCE_LABELS_ID[sourceBucket],
    referrerHost,
    utmSource: sourceBucket === "campaign" || sourceBucket === "ai_assistant" ? (utmSource ?? "") : "",
    utmMedium,
  };
}

// ---------------------------------------------------------------------------
// Tab-Scoped Arrival Source Persistence (`sessionStorage`, ZERO cookies!)
// ---------------------------------------------------------------------------

export interface ArrivalSessionStorageLike {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem?: (key: string) => void;
}

export interface PersistedArrivalSource {
  readonly sourceCategory: InsightSourceBucket;
  readonly referrerHost?: string;
  readonly utmSource?: string;
  readonly utmMedium?: string;
}

export interface ResolveTabArrivalSourceParams {
  readonly locationHref: string;
  readonly documentReferrer?: string | null;
  readonly siteHost?: string | null;
  readonly siteHosts?: readonly string[];
  readonly storage?: ArrivalSessionStorageLike | null;
}

function parseSavedArrivalSource(raw: string | null): PersistedArrivalSource | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const cat = parsed.sourceCategory;
    if (typeof cat !== "string" || !(INSIGHT_SOURCE_BUCKETS as readonly string[]).includes(cat)) {
      return null;
    }
    const referrerHost = sanitizeBareReferrerHost(parsed.referrerHost) ?? undefined;
    const utmSource = sanitizeInsightUtmToken(parsed.utmSource) ?? undefined;
    const utmMedium = sanitizeInsightUtmToken(parsed.utmMedium) ?? undefined;
    return {
      sourceCategory: cat as InsightSourceBucket,
      ...(referrerHost ? { referrerHost } : {}),
      ...(utmSource ? { utmSource } : {}),
      ...(utmMedium ? { utmMedium } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Resolves the visitor's coarse arrival source for the current browser tab:
 * 1. If the current landing URL carries sanitized UTM parameters (`utm_source` / `utm_medium`)
 *    or an external (non-same-site) `document.referrer` hostname, classifies and saves ONLY
 *    coarse arrival metadata into `sessionStorage` (`ps_arrival_source_v1`, NEVER a cookie).
 * 2. On subsequent same-site navigations (`document.referrer` is same host or empty, no new UTM),
 *    reuses the saved `sessionStorage` arrival source so internal clicks NEVER overwrite the
 *    original search / social / campaign / referral arrival source!
 * 3. On a plain direct visit with no prior saved source, returns `{ sourceCategory: "direct" }`
 *    WITHOUT writing anything to `sessionStorage` (preserving zero pre-consent storage writes).
 */
export function resolveTabArrivalSource(
  params: ResolveTabArrivalSourceParams,
): PersistedArrivalSource {
  let rawUtmSource: string | null = null;
  let rawUtmMedium: string | null = null;
  let utmSource: string | null = null;
  let utmMedium: string | null = null;
  let derivedSiteHost = extractNormalizedReferrerHost(params.siteHost);

  try {
    const parsedUrl = new URL(params.locationHref, "https://example.invalid");
    if (!derivedSiteHost && parsedUrl.hostname && parsedUrl.hostname !== "example.invalid") {
      derivedSiteHost = extractNormalizedReferrerHost(parsedUrl.hostname);
    }
    for (const [k, v] of parsedUrl.searchParams.entries()) {
      const lower = k.toLowerCase();
      if (lower === "utm_source" && rawUtmSource === null) {
        rawUtmSource = v;
        utmSource = sanitizeInsightUtmToken(v);
      } else if (lower === "utm_medium" && rawUtmMedium === null) {
        rawUtmMedium = v;
        utmMedium = sanitizeInsightUtmToken(v);
      }
    }
  } catch {
    // Ignore malformed location URL
  }

  const ownNormalizedHosts = new Set<string>();
  const normMain = normalizeHostForSameSiteComparison(derivedSiteHost);
  if (normMain) ownNormalizedHosts.add(normMain);
  if (params.siteHosts) {
    for (const h of params.siteHosts) {
      const n = normalizeHostForSameSiteComparison(h);
      if (n) ownNormalizedHosts.add(n);
    }
  }

  let externalReferrerHost = extractNormalizedReferrerHost(params.documentReferrer);
  const normRef = normalizeHostForSameSiteComparison(externalReferrerHost);
  if (normRef && ownNormalizedHosts.has(normRef)) {
    externalReferrerHost = null;
  }

  const hasRawUtmSignal =
    (rawUtmSource !== null && rawUtmSource.trim().length > 0) ||
    (rawUtmMedium !== null && rawUtmMedium.trim().length > 0);
  const hasFreshExternalArrival =
    utmSource !== null || utmMedium !== null || hasRawUtmSignal || externalReferrerHost !== null;

  if (hasFreshExternalArrival) {
    const classified = classifyInsightSource({
      referrerHost: externalReferrerHost,
      utmSource: rawUtmSource,
      utmMedium: rawUtmMedium,
      siteHost: derivedSiteHost,
      siteHosts: params.siteHosts,
    });
    const persisted: PersistedArrivalSource = {
      sourceCategory: classified.sourceBucket,
      ...(classified.referrerHost ? { referrerHost: classified.referrerHost } : {}),
      ...(classified.utmSource ? { utmSource: classified.utmSource } : {}),
      ...(classified.utmMedium ? { utmMedium: classified.utmMedium } : {}),
    };
    try {
      params.storage?.setItem(ARRIVAL_SOURCE_SESSION_KEY, JSON.stringify(persisted));
    } catch {
      // Fault-isolated (private browsing / disabled sessionStorage)
    }
    return persisted;
  }

  // Same-site navigation or empty referrer: preserve existing tab arrival source if present
  try {
    const existing = parseSavedArrivalSource(
      params.storage?.getItem(ARRIVAL_SOURCE_SESSION_KEY) ?? null,
    );
    if (existing) {
      return existing;
    }
  } catch {
    // Fault-isolated
  }

  // Plain direct visit with no prior saved external arrival: do NOT write sessionStorage
  return { sourceCategory: "direct" };
}

// ---------------------------------------------------------------------------
// Content Kind Inference & Dynamic UTC -> Tenant Timezone Projection
// ---------------------------------------------------------------------------

/**
 * Infers coarse content kind (`page`, `post`, `offering`, `taxonomy`, `other`)
 * from explicit route/resource hints or a normalized public path.
 */
export function inferInsightContentKind(params: {
  readonly resourceType?: "page" | "post" | "offering" | null;
  readonly routeKind?: "page" | "post" | "catalog" | "offering" | "taxonomy" | "other" | null;
  readonly targetKind?: string | null;
  readonly path: string;
}): InsightContentKind {
  if (params.resourceType === "page" || params.resourceType === "post" || params.resourceType === "offering") {
    return params.resourceType;
  }
  if (params.routeKind) {
    if (params.routeKind === "catalog" || params.routeKind === "offering") return "offering";
    if (
      params.routeKind === "page" ||
      params.routeKind === "post" ||
      params.routeKind === "taxonomy" ||
      params.routeKind === "other"
    ) {
      return params.routeKind;
    }
  }
  if (params.targetKind) {
    if (params.targetKind === "page") return "page";
    if (params.targetKind === "post") return "post";
    if (
      params.targetKind === "service" ||
      params.targetKind === "product" ||
      params.targetKind === "tour" ||
      params.targetKind === "vehicle"
    ) {
      return "offering";
    }
  }

  const p = params.path.trim().toLowerCase();
  if (/^\/blog\/[^/]+/.test(p)) return "post";
  if (/^\/(?:layanan|produk|tour|kendaraan)\/[^/]+/.test(p)) return "offering";
  if (
    p === "/blog" ||
    p === "/layanan" ||
    p === "/produk" ||
    p === "/tour" ||
    p === "/kendaraan" ||
    /^\/(?:kategori|tag|blog\/kategori|blog\/tag)(?:\/|$)/.test(p)
  ) {
    return "taxonomy";
  }
  if (p.startsWith("/")) return "page";
  return "other";
}

/**
 * Formats an epoch millisecond timestamp as UTC day (`YYYY-MM-DD`) and UTC hour (`0..23`).
 */
export function formatUtcDayAndHour(nowMs: number): {
  readonly dayUtc: string;
  readonly utcHour: number;
  readonly hourBucketUtc: string;
} {
  const safeMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const dt = new Date(safeMs);
  const dayUtc = dt.toISOString().slice(0, 10);
  const utcHour = dt.getUTCHours();
  const hourBucketUtc = `${dayUtc}T${String(utcHour).padStart(2, "0")}`;
  return { dayUtc, utcHour, hourBucketUtc };
}

/**
 * Validates an IANA timezone string using `Intl.DateTimeFormat`, falling back to `Asia/Jakarta`.
 */
export function normalizeInsightsTimeZone(rawTimeZone: string | null | undefined): string {
  const candidate = typeof rawTimeZone === "string" ? rawTimeZone.trim() : "";
  if (!candidate) return DEFAULT_INSIGHTS_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_INSIGHTS_TIMEZONE;
  }
}

/**
 * Human-readable Indonesian timezone abbreviation/label for dashboard peak hours headers.
 */
export function formatIndonesianTimezoneBadge(timeZone: string): string {
  switch (timeZone) {
    case "Asia/Jakarta":
      return "WIB (Asia/Jakarta)";
    case "Asia/Makassar":
      return "WITA (Asia/Makassar)";
    case "Asia/Jayapura":
      return "WIT (Asia/Jayapura)";
    case "UTC":
      return "UTC";
    default:
      return timeZone;
  }
}

export interface StoredUtcHourRow {
  readonly day_utc: string;
  readonly utc_hour: number;
  readonly page_views: number;
  readonly wa_clicks: number;
  readonly external_clicks: number;
  readonly lead_submits: number;
}

export interface ProjectedPeakHourBucket {
  /** Local hour in tenant timezone (`0..23`). */
  readonly hour: number;
  /** Formatted 24h label (`"00:00"` .. `"23:00"`). */
  readonly label: string;
  readonly pageViews: number;
  readonly waClicks: number;
  readonly externalClicks: number;
  readonly leadSubmits: number;
  readonly totalActivity: number;
}

export interface ProjectedPeakHoursResult {
  readonly timeZone: string;
  readonly timeZoneLabel: string;
  readonly hours: readonly ProjectedPeakHourBucket[];
  readonly peakHour: ProjectedPeakHourBucket | null;
  readonly maxHourlyActivity: number;
}

/**
 * Projects a single stored UTC `(day_utc, utc_hour)` bucket into the target IANA timezone's
 * local calendar day (`YYYY-MM-DD`) and local hour (`0..23`) without mutating stored rows.
 */
export function projectUtcDayHourToTimezone(
  dayUtc: string,
  utcHour: number,
  timeZone: string,
): { readonly localDay: string; readonly localHour: number } | null {
  const parts = dayUtc.split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d) ||
    !Number.isInteger(utcHour) ||
    utcHour < 0 ||
    utcHour > 23
  ) {
    return null;
  }

  const instant = new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
  if (Number.isNaN(instant.getTime())) return null;

  const safeTz = normalizeInsightsTimeZone(timeZone);
  const fmtParts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const year = fmtParts.find((p) => p.type === "year")?.value;
  const month = fmtParts.find((p) => p.type === "month")?.value;
  const day = fmtParts.find((p) => p.type === "day")?.value;
  const hourRaw = fmtParts.find((p) => p.type === "hour")?.value;
  if (!year || !month || !day || hourRaw === undefined) return null;

  const parsedHour = Number(hourRaw) % 24;
  return {
    localDay: `${year}-${month}-${day}`,
    localHour: parsedHour,
  };
}

function safeNonNegInt(val: unknown): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Dynamically projects stored UTC hourly aggregate rows into 24 local hour buckets (`0..23`)
 * in the tenant's configured IANA timezone (`Asia/Jakarta`, `Asia/Makassar`, `Asia/Jayapura`, etc.),
 * optionally filtered to an inclusive local day range `[startLocalDay, endLocalDay]`.
 *
 * Changing the tenant timezone immediately re-projects all peak hours WITHOUT rewriting stored rows.
 */
export function projectUtcHourlyRowsToTimezone(
  rows: readonly StoredUtcHourRow[],
  options: {
    readonly timeZone: string;
    readonly startLocalDay?: string;
    readonly endLocalDay?: string;
  },
): ProjectedPeakHoursResult {
  const timeZone = normalizeInsightsTimeZone(options.timeZone);
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, "0")}:00`,
    pageViews: 0,
    waClicks: 0,
    externalClicks: 0,
    leadSubmits: 0,
    totalActivity: 0,
  }));

  for (const row of rows) {
    const projected = projectUtcDayHourToTimezone(row.day_utc, row.utc_hour, timeZone);
    if (!projected) continue;
    if (options.startLocalDay && projected.localDay < options.startLocalDay) continue;
    if (options.endLocalDay && projected.localDay > options.endLocalDay) continue;

    const bucket = buckets[projected.localHour];
    if (!bucket) continue;

    const pv = safeNonNegInt(row.page_views);
    const wa = safeNonNegInt(row.wa_clicks);
    const ext = safeNonNegInt(row.external_clicks);
    const leads = safeNonNegInt(row.lead_submits);

    bucket.pageViews += pv;
    bucket.waClicks += wa;
    bucket.externalClicks += ext;
    bucket.leadSubmits += leads;
    bucket.totalActivity += pv + wa + ext + leads;
  }

  let peakHour: ProjectedPeakHourBucket | null = null;
  let maxHourlyActivity = 0;
  for (const b of buckets) {
    if (b.totalActivity > maxHourlyActivity) {
      maxHourlyActivity = b.totalActivity;
      peakHour = b;
    }
  }

  return {
    timeZone,
    timeZoneLabel: formatIndonesianTimezoneBadge(timeZone),
    hours: buckets,
    peakHour,
    maxHourlyActivity,
  };
}
