/**
 * First-Party Traffic, WhatsApp Click & Lead Attribution Engine
 * (`AI Assistant` & Standard Channels — REQ-095, REQ-073, PLAN §19.6, DESIGN §9).
 *
 * Security & Precision Invariants:
 * - Strict hostname parsing + exact / subdomain suffix matching (`host === domain || host.endsWith("." + domain)`).
 *   NEVER uses substring matching (`evil-chatgpt.com`, `notclaude.ai`, `chatgpt.com.attacker.test`
 *   will NEVER falsely match `ai_assistant`).
 * - Checks `AI Assistant` hosts BEFORE organic search hosts so `gemini.google.com` and
 *   `copilot.microsoft.com` always classify as `ai_assistant`, not `organic_search`.
 * - Ignores same-site referrers when `siteHost` / `tenantHosts` are provided.
 * - Never stores full referrer URLs, query strings, or visitor PII.
 */

export const ATTRIBUTION_CHANNELS = [
  "ai_assistant",
  "organic_search",
  "paid",
  "social",
  "referral",
  "direct",
] as const;

export type AttributionChannel = (typeof ATTRIBUTION_CHANNELS)[number];

/**
 * Matches `TenantStore.analytics_hourly_sources.source_bucket` CHECK constraint.
 */
export type HourlySourceBucket =
  | "direct"
  | "organic_search"
  | "social"
  | "referral"
  | "ai_assistant"
  | "campaign";

/**
 * Matches `packages/db/src/analytics/counters.ts` `AnalyticsSourceCategory`.
 */
export type EventSourceCategory =
  | "direct"
  | "search"
  | "social"
  | "ai_assistant"
  | "referral"
  | "campaign";

export type AiAssistantProvider =
  | "chatgpt"
  | "claude"
  | "perplexity"
  | "gemini"
  | "copilot"
  | "utm";

export const AI_ASSISTANT_HOST_MAP: Readonly<Record<string, Exclude<AiAssistantProvider, "utm">>> = {
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "claude.ai": "claude",
  "perplexity.ai": "perplexity",
  "gemini.google.com": "gemini",
  "copilot.microsoft.com": "copilot",
} as const;

export const AI_ASSISTANT_HOSTS = Object.keys(AI_ASSISTANT_HOST_MAP) as readonly string[];

export const AI_ASSISTANT_UTM_MEDIUMS: ReadonlySet<string> = new Set([
  "ai-assistant",
  "ai_assistant",
]);

const AI_ASSISTANT_UTM_SOURCE_ALIASES: Readonly<Record<string, Exclude<AiAssistantProvider, "utm">>> = {
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  chatgpt: "chatgpt",
  "claude.ai": "claude",
  claude: "claude",
  "perplexity.ai": "perplexity",
  perplexity: "perplexity",
  "gemini.google.com": "gemini",
  gemini: "gemini",
  "copilot.microsoft.com": "copilot",
  copilot: "copilot",
};

const PAID_UTM_MEDIUMS: ReadonlySet<string> = new Set([
  "cpc",
  "ppc",
  "paid",
  "paid_search",
  "paid-search",
  "paid_social",
  "paid-social",
  "paid_display",
  "paid-display",
  "display",
  "cpm",
  "ads",
  "ad",
  "banner",
  "sponsored",
]);

const SOCIAL_UTM_MEDIUMS: ReadonlySet<string> = new Set([
  "social",
  "social-media",
  "social_media",
  "organic-social",
  "organic_social",
]);

const ORGANIC_SEARCH_EXACT_HOSTS: readonly string[] = [
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
  "instagram.com",
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

export const ATTRIBUTION_CHANNEL_LABELS_ID: Readonly<Record<AttributionChannel, string>> = {
  ai_assistant: "AI Assistant",
  organic_search: "Pencarian Organik",
  paid: "Iklan Berbayar",
  social: "Media Sosial",
  referral: "Rujukan",
  direct: "Langsung / Tidak Diketahui",
};

const SAFE_TOKEN_RE = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const STRICT_HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Extracts and strictly normalizes a lowercase ASCII hostname from either a full
 * referrer URL (`https://chatgpt.com/c/123?foo=bar`) or a bare hostname (`chatgpt.com`).
 * Returns `null` for empty, invalid, malformed, or non-http(s) inputs.
 */
export function extractNormalizedReferrerHost(rawReferrer: string | null | undefined): string | null {
  if (typeof rawReferrer !== "string") return null;
  const trimmed = rawReferrer.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  // Reject control characters or embedded whitespace
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      return null;
    }
  }

  let hostname: string;
  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    hostname = parsed.hostname;
  } else {
    // Reject non-http URI schemes such as javascript:, data:, file:
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z0-9.-]+:\d+$/i.test(trimmed)) {
      return null;
    }
    const withoutPort = trimmed.replace(/:\d+$/, "");
    if (/[/?#\\@<>"']/.test(withoutPort)) {
      return null;
    }
    hostname = withoutPort;
  }

  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253 || !STRICT_HOSTNAME_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Strict domain boundary matcher: returns `true` ONLY when `hostname` is an exact
 * match or a dot-separated subdomain of `domain` (never substring matching).
 */
export function matchesHostnameExactOrSubdomain(hostname: string, domain: string): boolean {
  const cleanHost = hostname.trim().toLowerCase().replace(/\.$/, "");
  const cleanDomain = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!cleanHost || !cleanDomain) return false;
  return cleanHost === cleanDomain || cleanHost.endsWith(`.${cleanDomain}`);
}

function sanitizeUtmToken(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized || !SAFE_TOKEN_RE.test(normalized)) return null;
  return normalized;
}

function matchAiAssistantHost(hostname: string): Exclude<AiAssistantProvider, "utm"> | null {
  for (const [domain, provider] of Object.entries(AI_ASSISTANT_HOST_MAP)) {
    if (matchesHostnameExactOrSubdomain(hostname, domain)) {
      return provider;
    }
  }
  return null;
}

function isOrganicSearchHost(hostname: string): boolean {
  // Exclude gemini.google.com & copilot.microsoft.com (handled as AI Assistant first)
  if (matchAiAssistantHost(hostname) !== null) {
    return false;
  }
  for (const domain of ORGANIC_SEARCH_EXACT_HOSTS) {
    if (matchesHostnameExactOrSubdomain(hostname, domain)) {
      return true;
    }
  }
  // Support regional Google Search TLDs such as www.google.de, www.google.fr
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

export interface AttributionInput {
  /** Full referrer URL (`document.referrer`) or bare referrer host. */
  readonly referrer?: string | null;
  /** Optional pre-parsed referrer host (used if `referrer` is omitted). */
  readonly referrerHost?: string | null;
  readonly utmSource?: string | null;
  readonly utmMedium?: string | null;
  readonly utmCampaign?: string | null;
  /** Optional current site hostname(s) so self-referrals are treated as direct. */
  readonly siteHost?: string | null;
  readonly tenantHosts?: readonly string[];
}

export interface AttributionResult {
  readonly channel: AttributionChannel;
  readonly label: string;
  readonly hourlySourceBucket: HourlySourceBucket;
  readonly eventSourceCategory: EventSourceCategory;
  readonly referrerHost: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly matchedAssistant: AiAssistantProvider | null;
}

export function toHourlySourceBucket(channel: AttributionChannel): HourlySourceBucket {
  switch (channel) {
    case "ai_assistant":
      return "ai_assistant";
    case "organic_search":
      return "organic_search";
    case "social":
      return "social";
    case "paid":
      return "campaign";
    case "referral":
      return "referral";
    case "direct":
      return "direct";
  }
}

export function toEventSourceCategory(channel: AttributionChannel): EventSourceCategory {
  switch (channel) {
    case "ai_assistant":
      return "ai_assistant";
    case "organic_search":
      return "search";
    case "social":
      return "social";
    case "paid":
      return "campaign";
    case "referral":
      return "referral";
    case "direct":
      return "direct";
  }
}

/**
 * Classifies a visitor event, WhatsApp click, or lead submission into its canonical
 * attribution channel (`ai_assistant`, `organic_search`, `paid`, `social`, `referral`, `direct`).
 */
export function classifyTrafficAttribution(input: AttributionInput): AttributionResult {
  const utmSource = sanitizeUtmToken(input.utmSource);
  const utmMedium = sanitizeUtmToken(input.utmMedium);

  let referrerHost = extractNormalizedReferrerHost(input.referrer ?? input.referrerHost);

  // Drop same-site referrer so internal navigation never becomes external referral
  if (referrerHost) {
    const ownHosts = new Set<string>();
    const mainSiteHost = extractNormalizedReferrerHost(input.siteHost);
    if (mainSiteHost) ownHosts.add(mainSiteHost);
    if (input.tenantHosts) {
      for (const h of input.tenantHosts) {
        const clean = extractNormalizedReferrerHost(h);
        if (clean) ownHosts.add(clean);
      }
    }
    if (ownHosts.has(referrerHost)) {
      referrerHost = null;
    }
  }

  let channel: AttributionChannel;
  let matchedAssistant: AiAssistantProvider | null = null;

  // 1. AI Assistant attribution (highest priority; REQ-095, PLAN §19.6)
  const assistantFromRef = referrerHost ? matchAiAssistantHost(referrerHost) : null;
  const assistantFromUtmSource = utmSource ? (AI_ASSISTANT_UTM_SOURCE_ALIASES[utmSource] ?? null) : null;
  const isAiAssistantUtmMedium = utmMedium !== null && AI_ASSISTANT_UTM_MEDIUMS.has(utmMedium);

  if (isAiAssistantUtmMedium || assistantFromRef !== null || assistantFromUtmSource !== null) {
    channel = "ai_assistant";
    matchedAssistant = assistantFromRef ?? assistantFromUtmSource ?? "utm";
  } else if (utmMedium !== null && PAID_UTM_MEDIUMS.has(utmMedium)) {
    // 2. Paid campaign attribution
    channel = "paid";
  } else if (utmMedium === "organic" || (referrerHost !== null && isOrganicSearchHost(referrerHost))) {
    // 3. Organic search attribution
    channel = "organic_search";
  } else if (
    (utmMedium !== null && SOCIAL_UTM_MEDIUMS.has(utmMedium)) ||
    (referrerHost !== null && isSocialHost(referrerHost))
  ) {
    // 4. Social attribution
    channel = "social";
  } else if (referrerHost !== null || utmMedium === "referral" || utmSource !== null) {
    // 5. External referral or untagged non-AI campaign source
    channel = "referral";
  } else {
    // 6. Direct / unknown (typed URLs, bookmarks, untagged chat links)
    channel = "direct";
  }

  return {
    channel,
    label: ATTRIBUTION_CHANNEL_LABELS_ID[channel],
    hourlySourceBucket: toHourlySourceBucket(channel),
    eventSourceCategory: toEventSourceCategory(channel),
    referrerHost,
    utmSource,
    utmMedium,
    matchedAssistant,
  };
}

/**
 * Convenience helper parsing `utm_source` / `utm_medium` / `utm_campaign` directly
 * from a landing URL alongside a referrer string (for events, WA clicks, and leads).
 */
export function classifyAttributionFromUrlAndReferrer(params: {
  readonly landingUrl?: string | null;
  readonly referrer?: string | null;
  readonly siteHost?: string | null;
  readonly tenantHosts?: readonly string[];
}): AttributionResult {
  let utmSource: string | null = null;
  let utmMedium: string | null = null;
  let utmCampaign: string | null = null;

  if (params.landingUrl) {
    try {
      const parsed = new URL(params.landingUrl, "https://example.invalid");
      for (const [key, value] of parsed.searchParams.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === "utm_source" && utmSource === null) {
          utmSource = value;
        } else if (lowerKey === "utm_medium" && utmMedium === null) {
          utmMedium = value;
        } else if (lowerKey === "utm_campaign" && utmCampaign === null) {
          utmCampaign = value;
        }
      }
    } catch {
      // Ignore malformed landing URL
    }
  }

  return classifyTrafficAttribution({
    referrer: params.referrer,
    utmSource,
    utmMedium,
    utmCampaign,
    siteHost: params.siteHost,
    tenantHosts: params.tenantHosts,
  });
}

// ---------------------------------------------------------------------------
// Dashboard Channel Summary Aggregation (Insights `AI Assistant` Channel Row)
// ---------------------------------------------------------------------------

export interface ChannelMetricInput {
  readonly channel: AttributionChannel;
  readonly visits?: number;
  readonly waClicks?: number;
  readonly leads?: number;
}

export interface ChannelMetricRow {
  readonly channel: AttributionChannel;
  readonly label: string;
  readonly visits: number;
  readonly waClicks: number;
  readonly leads: number;
  readonly totalSignals: number;
  readonly sharePercent: number;
}

function safeInt(val: number | undefined): number {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) return 0;
  return Math.floor(val);
}

/**
 * Maps a persisted DB `source_bucket` / `source_category` value into a canonical
 * `AttributionChannel` so Insights aggregates `analytics_hourly_sources` and `leads`
 * consistently into the `AI Assistant` and standard rows.
 */
export function normalizeStoredSourceToChannel(rawSource: string | null | undefined): AttributionChannel {
  const lower = (rawSource ?? "").trim().toLowerCase();
  switch (lower) {
    case "ai_assistant":
    case "ai-assistant":
      return "ai_assistant";
    case "organic_search":
    case "search":
      return "organic_search";
    case "paid":
    case "campaign":
      return "paid";
    case "social":
      return "social";
    case "referral":
      return "referral";
    case "direct":
    default:
      return "direct";
  }
}

/**
 * Aggregates channel counts into a deterministic table always including the
 * `ai_assistant` (`AI Assistant`) row plus all canonical channels.
 */
export function buildChannelAttributionSummary(
  entries: readonly ChannelMetricInput[],
): readonly ChannelMetricRow[] {
  const buckets = new Map<
    AttributionChannel,
    { visits: number; waClicks: number; leads: number }
  >();
  for (const ch of ATTRIBUTION_CHANNELS) {
    buckets.set(ch, { visits: 0, waClicks: 0, leads: 0 });
  }

  for (const entry of entries) {
    const acc = buckets.get(entry.channel);
    if (!acc) continue;
    acc.visits += safeInt(entry.visits);
    acc.waClicks += safeInt(entry.waClicks);
    acc.leads += safeInt(entry.leads);
  }

  let grandTotal = 0;
  for (const acc of buckets.values()) {
    grandTotal += acc.visits + acc.waClicks + acc.leads;
  }

  return ATTRIBUTION_CHANNELS.map((channel) => {
    const acc = buckets.get(channel)!;
    const totalSignals = acc.visits + acc.waClicks + acc.leads;
    const sharePercent =
      grandTotal > 0 ? Math.round((totalSignals / grandTotal) * 1000) / 10 : 0;
    return {
      channel,
      label: ATTRIBUTION_CHANNEL_LABELS_ID[channel],
      visits: acc.visits,
      waClicks: acc.waClicks,
      leads: acc.leads,
      totalSignals,
      sharePercent,
    };
  });
}
