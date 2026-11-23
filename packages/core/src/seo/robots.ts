import {
  filterUpcomingDepartureDates,
  SCHEMA_DEFAULT_TIMEZONE,
} from "../schema-generator.ts";
import {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  buildRobotsTxtPolicy,
  escapeHtmlText,
  FACETED_FILTER_DISALLOW_PATTERNS,
  MANAGED_PRIVATE_DISALLOW_PATHS,
  type AiTrainingPolicy,
  type RobotsTxtPolicyInput,
  type RobotsTxtPolicyResult,
  type SiteVisibility,
  type VerifiedTenantHostInput,
} from "./index.ts";

/**
 * AI & Search Visibility `robots.txt` Bot Split & Public Tour Departure Filter
 * (REQ-095, PLAN §19.6, DESIGN §9, TASK-095).
 *
 * Builds strictly on TASK-051 (`packages/core/src/seo/index.ts`) and TASK-015
 * (`packages/core/src/schema-generator.ts`) so there is a single source of truth for:
 * - The 9 Search / User-Triggered AI Fetchers (always allowed on active/grace/locked paid sites)
 * - The 4 Training-Only Crawlers (controlled by owner toggle `aiTrainingPolicy`)
 * - Multi-parameter faceted filter disallow rules on `/kendaraan` & `/produk`
 * - Strict omission of past `tour` departure dates from both public HTML and JSON-LD
 * - Explicit non-generation of speculative `llms.txt`
 */

/**
 * Speculative `llms.txt` generation is intentionally out of scope and disabled (TASK-095 Non-Scope).
 */
export const LLMS_TXT_GENERATION_ENABLED = false as const;

export type SearchAndAiFetcherName = (typeof ALLOWED_SEARCH_AND_AI_FETCHERS)[number];
export type AiTrainingCrawlerName = (typeof AI_TRAINING_ONLY_CRAWLERS)[number];

export interface BotPolicyDescriptor<TName extends string = string> {
  readonly userAgent: TName;
  readonly group: "search_and_ai_fetcher" | "ai_training_crawler";
  readonly vendor: string;
  readonly descriptionId: string;
}

/**
 * Documented 9 search engines and user-triggered AI citation fetchers
 * explicitly allowed on indexable paid tenant sites (REQ-095, PLAN §19.6).
 */
export const SEARCH_AND_AI_FETCHER_DESCRIPTORS: readonly BotPolicyDescriptor<SearchAndAiFetcherName>[] =
  [
    {
      userAgent: "Googlebot",
      group: "search_and_ai_fetcher",
      vendor: "Google",
      descriptionId: "Pengindeksan pencarian utama Google Search",
    },
    {
      userAgent: "Bingbot",
      group: "search_and_ai_fetcher",
      vendor: "Microsoft Bing",
      descriptionId: "Pengindeksan pencarian Bing dan Copilot",
    },
    {
      userAgent: "OAI-SearchBot",
      group: "search_and_ai_fetcher",
      vendor: "OpenAI",
      descriptionId: "Bot indeks pencarian ChatGPT Search",
    },
    {
      userAgent: "ChatGPT-User",
      group: "search_and_ai_fetcher",
      vendor: "OpenAI",
      descriptionId: "Pengambil halaman saat pengguna bertanya di ChatGPT",
    },
    {
      userAgent: "Claude-SearchBot",
      group: "search_and_ai_fetcher",
      vendor: "Anthropic",
      descriptionId: "Bot indeks pencarian Claude",
    },
    {
      userAgent: "Claude-User",
      group: "search_and_ai_fetcher",
      vendor: "Anthropic",
      descriptionId: "Pengambil halaman saat pengguna bertanya di Claude",
    },
    {
      userAgent: "PerplexityBot",
      group: "search_and_ai_fetcher",
      vendor: "Perplexity",
      descriptionId: "Bot indeks pencarian & kutipan Perplexity",
    },
    {
      userAgent: "Perplexity-User",
      group: "search_and_ai_fetcher",
      vendor: "Perplexity",
      descriptionId: "Pengambil halaman saat pengguna bertanya di Perplexity",
    },
    {
      userAgent: "Applebot",
      group: "search_and_ai_fetcher",
      vendor: "Apple",
      descriptionId: "Pengindeksan Spotlight, Siri, dan Apple Search",
    },
  ] as const;

/**
 * Documented 4 AI model-training crawlers controlled by the tenant owner's
 * `aiTrainingPolicy` toggle (`"allow"` vs `"disallow"`, REQ-095, PLAN §19.6).
 */
export const AI_TRAINING_CRAWLER_DESCRIPTORS: readonly BotPolicyDescriptor<AiTrainingCrawlerName>[] =
  [
    {
      userAgent: "GPTBot",
      group: "ai_training_crawler",
      vendor: "OpenAI",
      descriptionId: "Perayap pelatihan model generatif OpenAI",
    },
    {
      userAgent: "ClaudeBot",
      group: "ai_training_crawler",
      vendor: "Anthropic",
      descriptionId: "Perayap pelatihan model generatif Anthropic",
    },
    {
      userAgent: "Google-Extended",
      group: "ai_training_crawler",
      vendor: "Google",
      descriptionId: "Kontrol penggunaan konten untuk pelatihan Gemini/Vertex AI",
    },
    {
      userAgent: "Applebot-Extended",
      group: "ai_training_crawler",
      vendor: "Apple",
      descriptionId: "Kontrol penggunaan konten untuk pelatihan Apple Intelligence",
    },
  ] as const;

export interface RobotsBotSplitSummary {
  readonly indexable: boolean;
  readonly searchBotsAllowed: readonly SearchAndAiFetcherName[];
  readonly trainingBotsAllowed: readonly AiTrainingCrawlerName[];
  readonly trainingBotsDisallowed: readonly AiTrainingCrawlerName[];
  readonly facetedFilterDisallows: readonly string[];
  readonly privateDisallows: readonly string[];
  readonly llmsTxtSupported: false;
}

export interface TenantRobotsTxtEvaluation extends RobotsTxtPolicyResult {
  readonly botSplit: RobotsBotSplitSummary;
}

/**
 * Generates the tenant-scoped `/robots.txt` response model alongside a typed
 * `botSplit` summary for API consumers and the Dashboard AI Crawler Controls UI.
 */
export function generateTenantRobotsTxt(
  input: RobotsTxtPolicyInput,
): TenantRobotsTxtEvaluation {
  const result = buildRobotsTxtPolicy(input);
  const trainingAllowed = result.indexable && result.aiTrainingPolicy === "allow";

  return {
    ...result,
    botSplit: {
      indexable: result.indexable,
      searchBotsAllowed: result.indexable ? [...ALLOWED_SEARCH_AND_AI_FETCHERS] : [],
      trainingBotsAllowed: trainingAllowed ? [...AI_TRAINING_ONLY_CRAWLERS] : [],
      trainingBotsDisallowed: !result.indexable || !trainingAllowed
        ? [...AI_TRAINING_ONLY_CRAWLERS]
        : [],
      facetedFilterDisallows: result.indexable ? [...FACETED_FILTER_DISALLOW_PATTERNS] : [],
      privateDisallows: result.indexable ? [...MANAGED_PRIVATE_DISALLOW_PATHS] : [],
      llmsTxtSupported: LLMS_TXT_GENERATION_ENABLED,
    },
  };
}

export interface ParsedRobotsRule {
  readonly directive: "allow" | "disallow";
  readonly pattern: string;
}

export interface ParsedRobotsGroup {
  readonly userAgents: readonly string[];
  readonly rules: readonly ParsedRobotsRule[];
}

/**
 * Parses a standard robots.txt body into user-agent groups and sitemap URLs
 * for deterministic rule verification (RFC 9309 longest-match semantics).
 */
export function parseRobotsTxt(body: string): {
  readonly groups: readonly ParsedRobotsGroup[];
  readonly sitemaps: readonly string[];
} {
  const groups: Array<{ userAgents: string[]; rules: ParsedRobotsRule[] }> = [];
  const sitemaps: string[] = [];
  let current: { userAgents: string[]; rules: ParsedRobotsRule[] } | null = null;
  let seenRuleInGroup = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      current = null;
      seenRuleInGroup = false;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === "user-agent") {
      if (!current || seenRuleInGroup) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
        seenRuleInGroup = false;
      }
      if (value) {
        current.userAgents.push(value);
      }
      continue;
    }

    if ((field === "allow" || field === "disallow") && current) {
      seenRuleInGroup = true;
      current.rules.push({ directive: field, pattern: value });
    }
  }

  return { groups, sitemaps };
}

function matchesRobotsPattern(pathWithQuery: string, pattern: string): boolean {
  if (pattern === "") {
    return false;
  }
  const anchoredEnd = pattern.endsWith("$");
  const core = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const escaped = core
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}${anchoredEnd ? "$" : ""}`);
  return regex.test(pathWithQuery);
}

/**
 * Evaluates whether a given `userAgent` is allowed to crawl `pathWithQuery`
 * under RFC 9309 group matching + longest-pattern precedence.
 */
export function isPathAllowedByRobotsTxt(
  robotsBody: string,
  userAgent: string,
  pathWithQuery: string,
): boolean {
  const parsed = parseRobotsTxt(robotsBody);
  const normalizedUa = userAgent.trim().toLowerCase();
  const targetPath = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;

  // Select most specific matching user-agent group (exact case-insensitive match beats `*`).
  const exactRules: ParsedRobotsRule[] = [];
  const wildcardRules: ParsedRobotsRule[] = [];

  for (const group of parsed.groups) {
    const lowerAgents = group.userAgents.map((ua) => ua.toLowerCase());
    if (lowerAgents.includes(normalizedUa)) {
      exactRules.push(...group.rules);
    } else if (lowerAgents.includes("*")) {
      wildcardRules.push(...group.rules);
    }
  }

  const activeRules = exactRules.length > 0 ? exactRules : wildcardRules;
  if (activeRules.length === 0) {
    return true;
  }

  let bestMatch: ParsedRobotsRule | null = null;
  for (const rule of activeRules) {
    if (!matchesRobotsPattern(targetPath, rule.pattern)) continue;
    if (!bestMatch || rule.pattern.length > bestMatch.pattern.length) {
      bestMatch = rule;
    } else if (
      rule.pattern.length === bestMatch.pattern.length &&
      rule.directive === "allow"
    ) {
      // RFC 9309: Allow wins ties of identical length.
      bestMatch = rule;
    }
  }

  return bestMatch ? bestMatch.directive === "allow" : true;
}

/**
 * Rejects speculative `llms.txt` or `llms-full.txt` paths so public handlers never
 * emit fabricated LLM index files (TASK-095 Non-Scope).
 */
export function isSpeculativeLlmsTxtPath(rawPathname: string): boolean {
  const lower = rawPathname.trim().toLowerCase();
  return lower === "/llms.txt" || lower === "/llms-full.txt" || lower.endsWith("/llms.txt");
}

// ---------------------------------------------------------------------------
// Public Tour Departure Filtering (Single Source of Truth for HTML + JSON-LD)
// ---------------------------------------------------------------------------

export interface PublicTourDepartureInput {
  readonly departureDate: string;
  readonly seatsAvailable?: number | null;
  readonly status?: "open" | "limited" | "full" | "closed" | string | null;
  readonly priceOverride?: number | null;
}

/**
 * Filters published tour departures so past dates (`departureDate < today` in tenant
 * timezone) and closed departures are omitted identically from visible public HTML
 * and Schema.org `TouristTrip` JSON-LD (REQ-095, PLAN §19.6).
 */
export function filterPublicTourDepartures<T extends PublicTourDepartureInput>(
  departures: readonly T[],
  now: Date | string | number,
  timezone: string = SCHEMA_DEFAULT_TIMEZONE,
): readonly T[] {
  const openDepartures = departures.filter((dep) => dep.status !== "closed");
  const allowedDates = new Set(
    filterUpcomingDepartureDates(
      openDepartures.map((dep) => dep.departureDate),
      now,
      timezone,
    ),
  );

  return openDepartures
    .filter((dep) => allowedDates.has(dep.departureDate.trim()))
    .sort((a, b) => a.departureDate.localeCompare(b.departureDate));
}

/**
 * Renders the semantic HTML `<dl>` / `<ul>` tour departure schedule block using
 * strictly upcoming departures — guaranteeing past tour dates never appear in
 * public HTML for search engines or AI citation fetchers (REQ-095).
 */
export function renderPublicTourDeparturesHtml(
  departures: readonly PublicTourDepartureInput[],
  now: Date | string | number,
  timezone: string = SCHEMA_DEFAULT_TIMEZONE,
): string {
  const upcoming = filterPublicTourDepartures(departures, now, timezone);
  if (upcoming.length === 0) {
    return '<p data-tour-departures="empty">Jadwal keberangkatan terbaru sedang diperbarui. Hubungi kami melalui WhatsApp untuk informasi jadwal berikutnya.</p>';
  }

  const items = upcoming.map((dep) => {
    const safeDate = escapeHtmlText(dep.departureDate.trim());
    const statusLabel =
      dep.status === "full"
        ? "Penuh"
        : dep.status === "limited"
          ? "Kuota Terbatas"
          : "Tersedia";
    return `<li data-departure-date="${safeDate}"><time datetime="${safeDate}">${safeDate}</time> — ${escapeHtmlText(statusLabel)}</li>`;
  });

  return `<ul data-tour-departures="upcoming">${items.join("")}</ul>`;
}

export {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  buildRobotsTxtPolicy,
  FACETED_FILTER_DISALLOW_PATTERNS,
  MANAGED_PRIVATE_DISALLOW_PATHS,
  type AiTrainingPolicy,
  type RobotsTxtPolicyInput,
  type RobotsTxtPolicyResult,
  type SiteVisibility,
  type VerifiedTenantHostInput,
};
