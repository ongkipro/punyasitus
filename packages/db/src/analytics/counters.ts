import {
  classifyInsightSource,
  formatUtcDayAndHour,
  inferInsightContentKind,
  isLikelyIdentifierOrHashToken,
  sanitizeBareReferrerHost,
  sanitizeInsightUtmToken,
  type InsightContentKind,
  type InsightSourceBucket,
} from "@punyasitus/core/analytics/insights";

/**
 * First-party cookieless click counters and dashboard metrics repository (TASK-030, TASK-065, TASK-072, REQ-017, REQ-073).
 *
 * Operates exclusively against a tenant's physically isolated `TenantStore` SQLite Durable Object
 * (`analytics_daily`, `pages`, `posts`, `offerings`).
 *
 * Privacy & integrity invariants (PLAN §6, §7.3, REQ-017, REQ-033, REQ-039):
 * - Strict event allowlist (`wa_click`, `external_click`, `lead_submitted`, `page_view`).
 * - Strict PII rejection: forbids `email`, `phone`, `name`, `message`, `address`, `ip`,
 *   query strings, or any unknown fields.
 * - Resource reference verification: rejects fabricated, non-existent, draft, or trashed
 *   `resourceId` / `targetSlug` references with `422 INVALID_RESOURCE_REFERENCE`.
 * - Atomic daily UPSERT on `(day, path)` in `analytics_daily`.
 * - Clicks are interest signals, never confirmed sales or purchases.
 */

export const ALLOWED_FIRST_PARTY_EVENTS = [
  "wa_click",
  "external_click",
  "lead_submitted",
  "page_view",
] as const;

export type FirstPartyEventType = (typeof ALLOWED_FIRST_PARTY_EVENTS)[number];

export const ALLOWED_RESOURCE_TYPES = ["page", "post", "offering"] as const;
export type AnalyticsResourceType = (typeof ALLOWED_RESOURCE_TYPES)[number];

export const ALLOWED_TARGET_KINDS = [
  "page",
  "post",
  "service",
  "product",
  "tour",
  "vehicle",
  "outlet",
  "header",
  "floating_wa",
] as const;
export type AnalyticsTargetKind = (typeof ALLOWED_TARGET_KINDS)[number];

export const ALLOWED_SOURCE_CATEGORIES = [
  "direct",
  "search",
  "social",
  "ai_assistant",
  "referral",
  "campaign",
] as const;
export type AnalyticsSourceCategory = (typeof ALLOWED_SOURCE_CATEGORIES)[number];

export const DEFAULT_ANALYTICS_TIMEZONE = "Asia/Jakarta";
export const MAX_EVENT_PATH_LENGTH = 200;
export const DEFAULT_EVENT_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EVENT_DEDUP_PRUNE_BATCH_SIZE = 50;
export const MAX_EVENT_DEDUP_PRUNE_BATCH_SIZE = 200;
export const MAX_EVENT_ID_LENGTH = 64;
export const MAX_DAILY_CONTENT_PATHS = 200;
export const MAX_DAILY_UTM_SOURCES = 50;
export const INSIGHTS_RETENTION_DAYS = 90;
export const DEFAULT_INSIGHTS_PRUNE_BATCH_SIZE = 100;
export const OVERFLOW_CONTENT_PATH = "/_other";
export const OVERFLOW_UTM_SOURCE = "_other";

export const ALLOWED_ROUTE_KINDS = [
  "page",
  "post",
  "catalog",
  "offering",
  "taxonomy",
  "other",
] as const;
export type AnalyticsRouteKind = (typeof ALLOWED_ROUTE_KINDS)[number];

const ALLOWED_EVENT_SET: ReadonlySet<string> = new Set(ALLOWED_FIRST_PARTY_EVENTS);
const ALLOWED_RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(ALLOWED_RESOURCE_TYPES);
const ALLOWED_TARGET_KIND_SET: ReadonlySet<string> = new Set(ALLOWED_TARGET_KINDS);
const ALLOWED_SOURCE_CATEGORY_SET: ReadonlySet<string> = new Set(ALLOWED_SOURCE_CATEGORIES);
const ALLOWED_ROUTE_KIND_SET: ReadonlySet<string> = new Set(ALLOWED_ROUTE_KINDS);

const ALLOWED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "eventType",
  "eventName",
  "eventId",
  "path",
  "resourceType",
  "resourceId",
  "targetKind",
  "targetSlug",
  "routeKind",
  "sourceCategory",
  "referrerHost",
  "utmSource",
  "utmMedium",
  "consentVersion",
  "honeypot",
]);

/**
 * Explicit lowercase PII and query-bearing field names strictly rejected on event ingestion.
 */
export const FORBIDDEN_PII_FIELDS: ReadonlySet<string> = new Set([
  "email",
  "e_mail",
  "email_address",
  "emailaddress",
  "phone",
  "phone_number",
  "phonenumber",
  "phone_e164",
  "phonee164",
  "mobile",
  "whatsapp",
  "wa_number",
  "wanumber",
  "name",
  "full_name",
  "fullname",
  "first_name",
  "firstname",
  "last_name",
  "lastname",
  "message",
  "notes",
  "comment",
  "address",
  "street",
  "ip",
  "ip_address",
  "ipaddress",
  "client_ip",
  "clientip",
  "remote_addr",
  "user_agent",
  "useragent",
  "cookie",
  "cookies",
  "query",
  "querystring",
  "query_string",
  "search",
  "params",
  "referrer_query",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PII_IN_PATH_RE =
  /(@|[?&#]|(?:^|[^0-9])(?:\+?62|0)8[0-9]{7,12}(?:$|[^0-9])|[0-9]{10,})/;
const SAFE_PATH_CHAR_RE = /^\/[A-Za-z0-9\-._~/]*$/;
const SAFE_CONSENT_VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

export type EventValidationErrorCode =
  | "INVALID_PAYLOAD"
  | "PII_FIELD_FORBIDDEN"
  | "UNKNOWN_FIELD"
  | "INVALID_EVENT_TYPE"
  | "INVALID_EVENT_ID"
  | "PII_OR_QUERY_IN_PATH"
  | "INVALID_PATH"
  | "INVALID_RESOURCE_REFERENCE"
  | "INVALID_TARGET_REFERENCE"
  | "INVALID_ROUTE_KIND"
  | "INVALID_SOURCE_CATEGORY"
  | "INVALID_REFERRER_HOST"
  | "INVALID_UTM_TOKEN"
  | "INVALID_CONSENT_VERSION";

export interface EventValidationFieldError {
  readonly field: string;
  readonly code: EventValidationErrorCode;
  readonly message: string;
}

export interface NormalizedFirstPartyEvent {
  readonly eventType: FirstPartyEventType;
  readonly eventId?: string;
  readonly path: string;
  readonly resourceType?: AnalyticsResourceType;
  readonly resourceId?: number;
  readonly targetKind?: AnalyticsTargetKind;
  readonly targetSlug?: string;
  readonly routeKind?: AnalyticsRouteKind;
  readonly sourceCategory?: AnalyticsSourceCategory;
  readonly referrerHost?: string;
  readonly utmSource?: string;
  readonly utmMedium?: string;
  readonly consentVersion?: string;
}

export type ValidateEventPayloadResult =
  | { readonly ok: true; readonly data: NormalizedFirstPartyEvent }
  | {
      readonly ok: false;
      readonly status: 422;
      readonly code: EventValidationErrorCode;
      readonly message: string;
      readonly fields: readonly EventValidationFieldError[];
    };

export type RecordFirstPartyEventResult =
  | {
      readonly ok: true;
      readonly recorded: true;
      readonly deduplicated: false;
      readonly eventId?: string;
      readonly day: string;
      readonly path: string;
      readonly eventType: FirstPartyEventType;
      readonly prunedExpiredCount?: number;
    }
  | {
      readonly ok: true;
      readonly recorded: false;
      readonly deduplicated: true;
      readonly eventId: string;
      readonly day: string;
      readonly path: string;
      readonly eventType: FirstPartyEventType;
      readonly prunedExpiredCount?: number;
    }
  | {
      readonly ok: false;
      readonly status: 422;
      readonly code: EventValidationErrorCode;
      readonly message: string;
      readonly fields: readonly EventValidationFieldError[];
    }
  | {
      readonly ok: false;
      readonly status: 503;
      readonly code: "SERVICE_UNAVAILABLE";
      readonly message: string;
    };

export interface RecordFirstPartyEventOptions {
  readonly nowMs?: number;
  readonly timeZone?: string;
  /** Current verified tenant host so same-site `referrerHost` is stripped server-side (TASK-072). */
  readonly siteHost?: string;
  /** Optional list of all hostnames owned by this tenant (subdomain + custom domain + `www.`). */
  readonly siteHosts?: readonly string[];
  /** Per-event dedup TTL in milliseconds (defaults to 24h per PLAN §5 / TASK-065). */
  readonly dedupTtlMs?: number;
  /**
   * Bounded number of expired `analytics_event_dedup` rows opportunistically pruned
   * at the end of each deduplicated event batch (defaults to 50; 0 disables opportunistic prune).
   */
  readonly pruneBatchSize?: number;
  /** Max distinct content paths tracked per UTC day before folding overflow into `/_other` (default 200). */
  readonly maxDailyContentPaths?: number;
  /** Max distinct `utm_source` tokens tracked per UTC day before folding overflow into `_other` (default 50). */
  readonly maxDailyUtmSources?: number;
  /** Retention window in days for insights aggregate tables before bounded pruning (default 90). */
  readonly insightsRetentionDays?: number;
  /** Max rows pruned per insights aggregate table per event batch (default 100; 0 disables). */
  readonly insightsPruneBatchSize?: number;
}

export type PruneAnalyticsEventDedupResult =
  | { readonly ok: true; readonly deleted: number }
  | {
      readonly ok: false;
      readonly status: 503;
      readonly code: "SERVICE_UNAVAILABLE";
      readonly message: string;
    };

export interface AnalyticsDailyRow {
  readonly day: string;
  readonly path: string;
  readonly pageviews: number;
  readonly unique_visitors: number;
  readonly wa_clicks: number;
  readonly external_clicks: number;
  readonly lead_submits: number;
  readonly updated_at?: number;
}

export interface DailyMetricPoint {
  readonly day: string;
  readonly pageviews: number;
  readonly uniqueVisitors: number;
  readonly waClicks: number;
  readonly externalClicks: number;
  readonly leadSubmits: number;
  readonly totalInterestSignals: number;
}

export interface TopPathMetric {
  readonly path: string;
  readonly pageviews: number;
  readonly waClicks: number;
  readonly externalClicks: number;
  readonly leadSubmits: number;
  readonly totalInterestSignals: number;
}

export interface TenantDashboardMetrics {
  readonly days: 7 | 30;
  readonly startDay: string;
  readonly endDay: string;
  readonly timeZone: string;
  readonly totals: {
    readonly waClicks: number;
    readonly externalClicks: number;
    readonly leadSubmits: number;
    readonly pageviews: number;
    readonly uniqueVisitors: number;
    readonly totalInterestSignals: number;
  };
  readonly daily: readonly DailyMetricPoint[];
  readonly topPaths: readonly TopPathMetric[];
  readonly hasAnyData: boolean;
}

export interface GetTenantDashboardMetricsOptions {
  readonly days?: 7 | 30;
  readonly nowMs?: number;
  readonly timeZone?: string;
  readonly topPathsLimit?: number;
}

function validationFailure(
  code: EventValidationErrorCode,
  field: string,
  message: string,
): Extract<ValidateEventPayloadResult, { readonly ok: false }> {
  return {
    ok: false,
    status: 422,
    code,
    message,
    fields: [{ field, code, message }],
  };
}

/**
 * Recursively scans a payload for any forbidden PII or query-string field name.
 */
export function findForbiddenPiiField(value: unknown, prefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenPiiField(value[i], `${prefix}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_PII_FIELDS.has(key.trim().toLowerCase())) {
      return path;
    }
    const found = findForbiddenPiiField(nested, path);
    if (found) return found;
  }
  return null;
}

/**
 * Normalizes and validates a public event path:
 * - Must start with `/`
 * - Must not contain query strings (`?`, `&`), fragments (`#`), emails, phone numbers,
 *   whitespace, path traversal (`..`), or redundant `//`.
 * - Strips trailing slash except for root `/`.
 */
export function normalizeEventPath(
  rawPath: unknown,
):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: "INVALID_PATH" | "PII_OR_QUERY_IN_PATH"; readonly message: string } {
  if (typeof rawPath !== "string") {
    return {
      ok: false,
      code: "INVALID_PATH",
      message: "Path halaman wajib berupa teks yang diawali '/'.",
    };
  }
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EVENT_PATH_LENGTH || !trimmed.startsWith("/")) {
    return {
      ok: false,
      code: "INVALID_PATH",
      message: `Path halaman harus diawali '/' dengan panjang 1-${MAX_EVENT_PATH_LENGTH} karakter.`,
    };
  }
  if (PII_IN_PATH_RE.test(trimmed)) {
    return {
      ok: false,
      code: "PII_OR_QUERY_IN_PATH",
      message:
        "Path event tidak boleh mengandung query string, fragment, email, atau nomor telepon.",
    };
  }
  if (
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    trimmed.includes("\\") ||
    !SAFE_PATH_CHAR_RE.test(trimmed)
  ) {
    return {
      ok: false,
      code: "INVALID_PATH",
      message: "Path halaman mengandung karakter yang tidak diizinkan.",
    };
  }

  const normalized = trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  return { ok: true, path: normalized };
}

/**
 * Strictly validates and normalizes an incoming first-party event payload.
 * Rejects PII fields, query strings, unknown keys, unknown event types,
 * and incomplete or malformed resource references.
 */
export function validateFirstPartyEventPayload(rawPayload: unknown): ValidateEventPayloadResult {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return validationFailure("INVALID_PAYLOAD", "body", "Payload event harus berupa objek JSON.");
  }

  const record = rawPayload as Record<string, unknown>;

  // 1. Explicit PII / query-field scan runs first so PII attempts surface deterministically.
  const piiField = findForbiddenPiiField(record);
  if (piiField !== null) {
    return validationFailure(
      "PII_FIELD_FORBIDDEN",
      piiField,
      "Data pribadi (PII) atau parameter query tidak diizinkan pada event analitik.",
    );
  }

  // 2. Strict unknown-field rejection (PLAN §6).
  for (const key of Object.keys(record)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
      return validationFailure(
        "UNKNOWN_FIELD",
        key,
        `Field '${key}' tidak diizinkan pada payload event.`,
      );
    }
  }

  // 3. Strict event allowlist (`eventType` or canonical OpenAPI alias `eventName`).
  const rawEventType = record.eventType;
  const rawEventName = record.eventName;

  if (rawEventType !== undefined && typeof rawEventType !== "string") {
    return validationFailure("INVALID_EVENT_TYPE", "eventType", "Tipe event tidak valid.");
  }
  if (rawEventName !== undefined && typeof rawEventName !== "string") {
    return validationFailure("INVALID_EVENT_TYPE", "eventName", "Nama event tidak valid.");
  }
  if (
    typeof rawEventType === "string" &&
    typeof rawEventName === "string" &&
    rawEventType !== rawEventName
  ) {
    return validationFailure(
      "INVALID_EVENT_TYPE",
      "eventType",
      "Nilai eventType dan eventName tidak cocok.",
    );
  }

  const resolvedEvent = rawEventType ?? rawEventName;
  if (typeof resolvedEvent !== "string" || !ALLOWED_EVENT_SET.has(resolvedEvent)) {
    return validationFailure(
      "INVALID_EVENT_TYPE",
      rawEventName !== undefined ? "eventName" : "eventType",
      "Tipe event harus salah satu dari: wa_click, external_click, lead_submitted, atau page_view.",
    );
  }
  const eventType = resolvedEvent as FirstPartyEventType;

  // 4. Optional eventId (strict RFC 4122 UUID; atomic 24h per-tenant dedup in TASK-065).
  // Rejects non-UUIDs, PII (emails/phones/names), query strings, control chars, and oversized values.
  let eventId: string | undefined;
  if (record.eventId !== undefined) {
    if (typeof record.eventId !== "string") {
      return validationFailure(
        "INVALID_EVENT_ID",
        "eventId",
        "eventId harus berupa UUID yang valid tanpa PII atau query string.",
      );
    }
    const trimmedEventId = record.eventId.trim();
    if (
      trimmedEventId.length !== 36 ||
      trimmedEventId.length > MAX_EVENT_ID_LENGTH ||
      /[?&#=/:\\\s@]/.test(trimmedEventId) ||
      !UUID_RE.test(trimmedEventId)
    ) {
      return validationFailure(
        "INVALID_EVENT_ID",
        "eventId",
        "eventId harus berupa UUID yang valid tanpa PII atau query string.",
      );
    }
    eventId = trimmedEventId.toLowerCase();
  }

  // 5. Path validation (no query strings, no PII).
  const pathCheck = normalizeEventPath(record.path);
  if (!pathCheck.ok) {
    return validationFailure(pathCheck.code, "path", pathCheck.message);
  }

  // 6. Optional resourceType + resourceId validation (must be supplied as a complete valid pair).
  const hasResourceType = record.resourceType !== undefined;
  const hasResourceId = record.resourceId !== undefined;
  let resourceType: AnalyticsResourceType | undefined;
  let resourceId: number | undefined;

  if (hasResourceType || hasResourceId) {
    if (!hasResourceType || !hasResourceId) {
      return validationFailure(
        "INVALID_RESOURCE_REFERENCE",
        hasResourceType ? "resourceId" : "resourceType",
        "resourceType dan resourceId harus disertakan bersamaan.",
      );
    }
    if (
      typeof record.resourceType !== "string" ||
      !ALLOWED_RESOURCE_TYPE_SET.has(record.resourceType)
    ) {
      return validationFailure(
        "INVALID_RESOURCE_REFERENCE",
        "resourceType",
        "resourceType harus salah satu dari: page, post, atau offering.",
      );
    }
    if (
      typeof record.resourceId !== "number" ||
      !Number.isSafeInteger(record.resourceId) ||
      record.resourceId < 1
    ) {
      return validationFailure(
        "INVALID_RESOURCE_REFERENCE",
        "resourceId",
        "resourceId harus berupa bilangan bulat positif.",
      );
    }
    resourceType = record.resourceType as AnalyticsResourceType;
    resourceId = record.resourceId;
  }

  // 7. Optional targetKind + targetSlug validation.
  let targetKind: AnalyticsTargetKind | undefined;
  if (record.targetKind !== undefined) {
    if (
      typeof record.targetKind !== "string" ||
      !ALLOWED_TARGET_KIND_SET.has(record.targetKind)
    ) {
      return validationFailure(
        "INVALID_TARGET_REFERENCE",
        "targetKind",
        "targetKind tidak dikenali.",
      );
    }
    targetKind = record.targetKind as AnalyticsTargetKind;
  }

  let targetSlug: string | undefined;
  if (record.targetSlug !== undefined) {
    if (
      typeof record.targetSlug !== "string" ||
      record.targetSlug.length < 1 ||
      record.targetSlug.length > 80 ||
      !SLUG_RE.test(record.targetSlug)
    ) {
      return validationFailure(
        "INVALID_TARGET_REFERENCE",
        "targetSlug",
        "targetSlug harus berupa slug huruf kecil yang valid (1-80 karakter).",
      );
    }
    targetSlug = record.targetSlug;
  }

  if (targetSlug !== undefined && targetKind === undefined) {
    return validationFailure(
      "INVALID_TARGET_REFERENCE",
      "targetKind",
      "targetKind wajib disertakan apabila targetSlug diisi.",
    );
  }

  // 8. Optional routeKind, sourceCategory, referrerHost, utmSource, utmMedium & consentVersion.
  let routeKind: AnalyticsRouteKind | undefined;
  if (record.routeKind !== undefined) {
    if (
      typeof record.routeKind !== "string" ||
      !ALLOWED_ROUTE_KIND_SET.has(record.routeKind)
    ) {
      return validationFailure(
        "INVALID_ROUTE_KIND",
        "routeKind",
        "routeKind tidak valid.",
      );
    }
    routeKind = record.routeKind as AnalyticsRouteKind;
  }

  let sourceCategory: AnalyticsSourceCategory | undefined;
  if (record.sourceCategory !== undefined) {
    if (
      typeof record.sourceCategory !== "string" ||
      !ALLOWED_SOURCE_CATEGORY_SET.has(record.sourceCategory)
    ) {
      return validationFailure(
        "INVALID_SOURCE_CATEGORY",
        "sourceCategory",
        "sourceCategory tidak valid.",
      );
    }
    sourceCategory = record.sourceCategory as AnalyticsSourceCategory;
  }

  let referrerHost: string | undefined;
  if (record.referrerHost !== undefined && record.referrerHost !== null && record.referrerHost !== "") {
    const cleanHost = sanitizeBareReferrerHost(record.referrerHost);
    if (!cleanHost) {
      return validationFailure(
        "INVALID_REFERRER_HOST",
        "referrerHost",
        "referrerHost harus berupa nama host saja tanpa protokol, path, query, atau PII.",
      );
    }
    referrerHost = cleanHost;
  }

  const SAFE_UTM_SYNTAX_RE = /^[a-z0-9][a-z0-9._-]{0,49}$/;
  const EMAIL_QUERY_OR_ID_PHONE_UTM_RE =
    /(@|[?&#=/:\\\s<>"';(){}]|(?:^|[^0-9])(?:\+?62|0)8[0-9]{7,12}(?:$|[^0-9]))/;

  let utmSource: string | undefined;
  if (record.utmSource !== undefined && record.utmSource !== null && record.utmSource !== "") {
    if (typeof record.utmSource !== "string") {
      return validationFailure(
        "INVALID_UTM_TOKEN",
        "utmSource",
        "utmSource harus berupa token huruf kecil 1-50 karakter tanpa query atau PII.",
      );
    }
    const trimmedUtm = record.utmSource.trim().toLowerCase();
    const cleanUtm = sanitizeInsightUtmToken(trimmedUtm);
    if (cleanUtm) {
      utmSource = cleanUtm;
    } else if (
      !EMAIL_QUERY_OR_ID_PHONE_UTM_RE.test(trimmedUtm) &&
      SAFE_UTM_SYNTAX_RE.test(trimmedUtm) &&
      isLikelyIdentifierOrHashToken(trimmedUtm)
    ) {
      // Strip personalized/hash/UUID identifier tokens to "" while preserving the coarse campaign bucket (TASK-072).
      sourceCategory = sourceCategory ?? "campaign";
    } else {
      return validationFailure(
        "INVALID_UTM_TOKEN",
        "utmSource",
        "utmSource harus berupa token huruf kecil 1-50 karakter tanpa query atau PII.",
      );
    }
  }

  let utmMedium: string | undefined;
  if (record.utmMedium !== undefined && record.utmMedium !== null && record.utmMedium !== "") {
    if (typeof record.utmMedium !== "string") {
      return validationFailure(
        "INVALID_UTM_TOKEN",
        "utmMedium",
        "utmMedium harus berupa token huruf kecil 1-50 karakter tanpa query atau PII.",
      );
    }
    const trimmedMed = record.utmMedium.trim().toLowerCase();
    const cleanMedium = sanitizeInsightUtmToken(trimmedMed);
    if (cleanMedium) {
      utmMedium = cleanMedium;
    } else if (
      !EMAIL_QUERY_OR_ID_PHONE_UTM_RE.test(trimmedMed) &&
      SAFE_UTM_SYNTAX_RE.test(trimmedMed) &&
      isLikelyIdentifierOrHashToken(trimmedMed)
    ) {
      sourceCategory = sourceCategory ?? "campaign";
    } else {
      return validationFailure(
        "INVALID_UTM_TOKEN",
        "utmMedium",
        "utmMedium harus berupa token huruf kecil 1-50 karakter tanpa query atau PII.",
      );
    }
  }

  let consentVersion: string | undefined;
  if (record.consentVersion !== undefined) {
    if (
      typeof record.consentVersion !== "string" ||
      !SAFE_CONSENT_VERSION_RE.test(record.consentVersion)
    ) {
      return validationFailure(
        "INVALID_CONSENT_VERSION",
        "consentVersion",
        "consentVersion tidak valid.",
      );
    }
    consentVersion = record.consentVersion;
  }

  // 9. Honeypot must be empty if present.
  if (record.honeypot !== undefined && record.honeypot !== "") {
    return validationFailure(
      "INVALID_PAYLOAD",
      "honeypot",
      "Permintaan tidak dapat diproses.",
    );
  }

  return {
    ok: true,
    data: {
      eventType,
      ...(eventId ? { eventId } : {}),
      path: pathCheck.path,
      ...(resourceType && resourceId !== undefined ? { resourceType, resourceId } : {}),
      ...(targetKind ? { targetKind } : {}),
      ...(targetSlug ? { targetSlug } : {}),
      ...(routeKind ? { routeKind } : {}),
      ...(sourceCategory ? { sourceCategory } : {}),
      ...(referrerHost ? { referrerHost } : {}),
      ...(utmSource ? { utmSource } : {}),
      ...(utmMedium ? { utmMedium } : {}),
      ...(consentVersion ? { consentVersion } : {}),
    },
  };
}

/**
 * Formats an epoch millisecond timestamp as `YYYY-MM-DD` in the given IANA timezone
 * (defaulting to `Asia/Jakarta` per PLAN §5).
 */
export function formatAnalyticsDay(
  nowMs: number,
  timeZone: string = DEFAULT_ANALYTICS_TIMEZONE,
): string {
  const safeMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const date = new Date(safeMs);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Fallback to UTC ISO date when an invalid timezone string is supplied.
  }
  return date.toISOString().slice(0, 10);
}

function buildDaySeries(
  days: 7 | 30,
  nowMs: number,
  timeZone: string,
): { readonly startDay: string; readonly endDay: string; readonly dayKeys: readonly string[] } {
  const dayMs = 86_400_000;
  const endDay = formatAnalyticsDay(nowMs, timeZone);
  const keys: string[] = [];
  // Step backward in UTC days from endDay's midday to avoid DST/offset drift.
  const [yStr, mStr, dStr] = endDay.split("-");
  const anchorUtcMs = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr), 12, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dt = new Date(anchorUtcMs - offset * dayMs);
    keys.push(dt.toISOString().slice(0, 10));
  }
  return {
    startDay: keys[0] ?? endDay,
    endDay: keys[keys.length - 1] ?? endDay,
    dayKeys: keys,
  };
}

/**
 * Verifies that a referenced content resource actually exists and is published (not draft or trashed)
 * inside the tenant's `TenantStore`.
 */
export async function verifyPublishedResourceExists(
  tenantDb: D1Database,
  ref: {
    readonly resourceType?: AnalyticsResourceType;
    readonly resourceId?: number;
    readonly targetKind?: AnalyticsTargetKind;
    readonly targetSlug?: string;
  },
): Promise<{ readonly exists: boolean; readonly resolvedId?: number }> {
  let resolvedId: number | undefined;

  if (ref.resourceType && ref.resourceId !== undefined) {
    let sqlQuery: string;
    if (ref.resourceType === "page") {
      sqlQuery = "SELECT id FROM pages WHERE id = ? AND status = 'published' AND deleted_at IS NULL LIMIT 1";
    } else if (ref.resourceType === "post") {
      sqlQuery = "SELECT id FROM posts WHERE id = ? AND status = 'published' AND deleted_at IS NULL LIMIT 1";
    } else {
      sqlQuery =
        "SELECT id FROM offerings WHERE id = ? AND status = 'published' AND deleted_at IS NULL LIMIT 1";
    }
    const row = await tenantDb.prepare(sqlQuery).bind(ref.resourceId).first<{ id: number }>();
    if (!row) {
      return { exists: false };
    }
    resolvedId = row.id;
  }

  if (ref.targetKind && ref.targetSlug) {
    if (ref.targetKind === "page") {
      const row = await tenantDb
        .prepare("SELECT id FROM pages WHERE slug = ? AND status = 'published' AND deleted_at IS NULL LIMIT 1")
        .bind(ref.targetSlug)
        .first<{ id: number }>();
      if (!row) return { exists: false };
      resolvedId = resolvedId ?? row.id;
    } else if (ref.targetKind === "post") {
      const row = await tenantDb
        .prepare("SELECT id FROM posts WHERE slug = ? AND status = 'published' AND deleted_at IS NULL LIMIT 1")
        .bind(ref.targetSlug)
        .first<{ id: number }>();
      if (!row) return { exists: false };
      resolvedId = resolvedId ?? row.id;
    } else if (
      ref.targetKind === "service" ||
      ref.targetKind === "product" ||
      ref.targetKind === "tour" ||
      ref.targetKind === "vehicle"
    ) {
      const row = await tenantDb
        .prepare(
          "SELECT id FROM offerings WHERE offering_type = ? AND slug = ? AND status = 'published' AND deleted_at IS NULL LIMIT 1",
        )
        .bind(ref.targetKind, ref.targetSlug)
        .first<{ id: number }>();
      if (!row) return { exists: false };
      resolvedId = resolvedId ?? row.id;
    }
  }

  return resolvedId !== undefined ? { exists: true, resolvedId } : { exists: true };
}

/**
 * Builds the canonical, bounded-cardinality, PII-free `analytics_event_dedup.dedup_key`
 * stored inside the tenant's physically isolated `TenantStore` SQLite Durable Object.
 */
export function buildAnalyticsEventDedupKey(eventId: string): string {
  const normalized = eventId.trim().toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw new RangeError("INVALID_EVENT_ID: eventId must be a valid RFC 4122 UUID");
  }
  return `evt:${normalized}`;
}

/**
 * Deletes expired entries (`expires_at <= nowMs`) from `analytics_event_dedup`.
 * Supports an optional bounded `limit` so callers can prune incrementally without stalling the DO.
 */
export async function pruneExpiredAnalyticsEventDedup(
  tenantDb: D1Database | null | undefined,
  options?: {
    readonly nowMs?: number;
    readonly limit?: number;
  },
): Promise<PruneAnalyticsEventDedupResult> {
  if (!tenantDb) {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan penyimpanan analitik sementara tidak tersedia.",
    };
  }

  const nowMs = Math.floor(options?.nowMs ?? Date.now());
  try {
    if (options?.limit !== undefined) {
      const safeLimit = Math.max(
        1,
        Math.min(10_000, Math.floor(options.limit)),
      );
      const res = await tenantDb
        .prepare(
          `DELETE FROM analytics_event_dedup
           WHERE dedup_key IN (
             SELECT dedup_key
             FROM analytics_event_dedup
             WHERE expires_at <= ?
             ORDER BY expires_at ASC
             LIMIT ?
           )`,
        )
        .bind(nowMs, safeLimit)
        .run();
      return { ok: true, deleted: res.meta?.changes ?? 0 };
    }

    const res = await tenantDb
      .prepare("DELETE FROM analytics_event_dedup WHERE expires_at <= ?")
      .bind(nowMs)
      .run();
    return { ok: true, deleted: res.meta?.changes ?? 0 };
  } catch {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan penyimpanan analitik sementara tidak tersedia.",
    };
  }
}

/**
 * Validates an event payload, verifies any referenced published resource exists in `TenantStore`,
 * and atomically increments the matching daily counter column in `analytics_daily`.
 *
 * When `eventId` is present (TASK-065, REQ-027, PLAN §5.2, §7.3):
 * Executes inside ONE atomic `TenantStore` `batch()` (`transactionSync`):
 * 1. Prunes this `dedup_key` only if already expired (`expires_at <= nowMs`) so keys past 24h can be reused.
 * 2. Claims `(dedup_key, expires_at, created_at)` via `INSERT OR IGNORE` (`changes() = 1` iff first claim).
 * 3. Increments `analytics_daily` strictly gated on `WHERE changes() = 1` so duplicate retries,
 *    double-clicks, or concurrent races NEVER double-count.
 * 4. Opportunistically prunes up to `pruneBatchSize` expired rows (default 50) AFTER the counter
 *    statement so `changes()` is untouched and `TenantStore` storage remains bounded.
 */
export async function recordFirstPartyEvent(
  tenantDb: D1Database | null | undefined,
  rawPayload: unknown,
  options?: RecordFirstPartyEventOptions,
): Promise<RecordFirstPartyEventResult> {
  const validated = validateFirstPartyEventPayload(rawPayload);
  if (!validated.ok) {
    return validated;
  }

  if (!tenantDb) {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan penyimpanan analitik sementara tidak tersedia.",
    };
  }

  const event = validated.data;
  const nowMs = Math.floor(options?.nowMs ?? Date.now());
  const timeZone = options?.timeZone?.trim() || DEFAULT_ANALYTICS_TIMEZONE;
  const day = formatAnalyticsDay(nowMs, timeZone);

  const ttlMs = options?.dedupTtlMs ?? DEFAULT_EVENT_DEDUP_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000) {
    throw new RangeError("INVALID_EVENT_DEDUP_TTL: dedupTtlMs must be an integer >= 1000");
  }

  try {
    let resolvedResourceId: number | undefined = event.resourceId;
    if (
      (event.resourceType && event.resourceId !== undefined) ||
      (event.targetKind && event.targetSlug)
    ) {
      const check = await verifyPublishedResourceExists(tenantDb, {
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        targetKind: event.targetKind,
        targetSlug: event.targetSlug,
      });
      if (!check.exists) {
        return {
          ok: false,
          status: 422,
          code: "INVALID_RESOURCE_REFERENCE",
          message: "Referensi konten tidak ditemukan atau belum diterbitkan.",
          fields: [
            {
              field: event.resourceId !== undefined ? "resourceId" : "targetSlug",
              code: "INVALID_RESOURCE_REFERENCE",
              message: "Konten yang direferensikan tidak ada atau berstatus bukan published.",
            },
          ],
        };
      }
      resolvedResourceId = check.resolvedId ?? resolvedResourceId;
    }

    const pageviewsInc = event.eventType === "page_view" ? 1 : 0;
    const waClicksInc = event.eventType === "wa_click" ? 1 : 0;
    const externalClicksInc = event.eventType === "external_click" ? 1 : 0;
    const leadSubmitsInc = event.eventType === "lead_submitted" ? 1 : 0;

    // Classify coarse source & compute UTC date/hour buckets (TASK-072, REQ-073)
    const classifiedSource = classifyInsightSource({
      referrerHost: event.referrerHost,
      utmSource: event.utmSource,
      utmMedium: event.utmMedium,
      sourceCategory: event.sourceCategory as InsightSourceBucket | undefined,
      siteHost: options?.siteHost,
      siteHosts: options?.siteHosts,
    });
    const utc = formatUtcDayAndHour(nowMs);
    let effectiveContentKind: InsightContentKind = inferInsightContentKind({
      resourceType: event.resourceType,
      routeKind: event.routeKind,
      targetKind: event.targetKind,
      path: event.path,
    });
    // Only attribute numeric content_id when backed by a verified published resource
    let effectiveContentId = resolvedResourceId ?? 0;
    let effectiveContentPath = event.path;
    let effectiveUtmSource = classifiedSource.utmSource;

    const insightsTbl = await tenantDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analytics_content_daily' LIMIT 1",
      )
      .first<{ name: string }>();
    const hasInsightsTables = insightsTbl?.name === "analytics_content_daily";

    const maxPaths = Math.max(
      1,
      Math.floor(options?.maxDailyContentPaths ?? MAX_DAILY_CONTENT_PATHS),
    );
    const maxUtmSources = Math.max(
      1,
      Math.floor(options?.maxDailyUtmSources ?? MAX_DAILY_UTM_SOURCES),
    );
    const retentionDays = Math.max(
      1,
      Math.floor(options?.insightsRetentionDays ?? INSIGHTS_RETENTION_DAYS),
    );
    const insightsPruneBatchSize = Math.max(
      0,
      Math.min(500, Math.floor(options?.insightsPruneBatchSize ?? DEFAULT_INSIGHTS_PRUNE_BATCH_SIZE)),
    );
    const retentionCutoffDayUtc = formatUtcDayAndHour(nowMs - retentionDays * 86_400_000).dayUtc;

    if (hasInsightsTables) {
      // Bound anonymous daily path cardinality (default 200 distinct paths/day -> fold overflow into `/_other`)
      if (effectiveContentPath !== OVERFLOW_CONTENT_PATH) {
        const existingPath = await tenantDb
          .prepare(
            "SELECT 1 AS hit FROM analytics_content_daily WHERE day_utc = ? AND path = ? LIMIT 1",
          )
          .bind(utc.dayUtc, effectiveContentPath)
          .first<{ hit: number }>();
        if (!existingPath) {
          const pathCountRow = await tenantDb
            .prepare(
              "SELECT COUNT(DISTINCT path) AS cnt FROM analytics_content_daily WHERE day_utc = ? AND path != ?",
            )
            .bind(utc.dayUtc, OVERFLOW_CONTENT_PATH)
            .first<{ cnt: number }>();
          if (Number(pathCountRow?.cnt ?? 0) >= maxPaths) {
            effectiveContentPath = OVERFLOW_CONTENT_PATH;
            effectiveContentKind = "other";
            effectiveContentId = 0;
          }
        }
      }

      // Bound anonymous daily utm_source cardinality (default 50 distinct tokens/day -> fold overflow into `_other`)
      if (effectiveUtmSource !== "" && effectiveUtmSource !== OVERFLOW_UTM_SOURCE) {
        const existingUtm = await tenantDb
          .prepare(
            "SELECT 1 AS hit FROM analytics_sources_daily WHERE day_utc = ? AND utm_source = ? LIMIT 1",
          )
          .bind(utc.dayUtc, effectiveUtmSource)
          .first<{ hit: number }>();
        if (!existingUtm) {
          const utmCountRow = await tenantDb
            .prepare(
              "SELECT COUNT(DISTINCT utm_source) AS cnt FROM analytics_sources_daily WHERE day_utc = ? AND utm_source != '' AND utm_source != ?",
            )
            .bind(utc.dayUtc, OVERFLOW_UTM_SOURCE)
            .first<{ cnt: number }>();
          if (Number(utmCountRow?.cnt ?? 0) >= maxUtmSources) {
            effectiveUtmSource = OVERFLOW_UTM_SOURCE;
          }
        }
      }
    }

    const pushBoundedInsightsRetentionPrunes = (stmts: D1PreparedStatement[]) => {
      if (!hasInsightsTables || insightsPruneBatchSize <= 0) return;
      stmts.push(
        tenantDb
          .prepare(
            `DELETE FROM analytics_content_daily
             WHERE rowid IN (
               SELECT rowid
               FROM analytics_content_daily
               WHERE day_utc < ?
               ORDER BY day_utc ASC
               LIMIT ?
             )`,
          )
          .bind(retentionCutoffDayUtc, insightsPruneBatchSize),
        tenantDb
          .prepare(
            `DELETE FROM analytics_hourly_utc
             WHERE rowid IN (
               SELECT rowid
               FROM analytics_hourly_utc
               WHERE day_utc < ?
               ORDER BY day_utc ASC
               LIMIT ?
             )`,
          )
          .bind(retentionCutoffDayUtc, insightsPruneBatchSize),
        tenantDb
          .prepare(
            `DELETE FROM analytics_sources_daily
             WHERE rowid IN (
               SELECT rowid
               FROM analytics_sources_daily
               WHERE day_utc < ?
               ORDER BY day_utc ASC
               LIMIT ?
             )`,
          )
          .bind(retentionCutoffDayUtc, insightsPruneBatchSize),
      );
    };

    if (event.eventId) {
      const dedupKey = buildAnalyticsEventDedupKey(event.eventId);
      const expiresAt = nowMs + ttlMs;
      const pruneBatchSize = Math.max(
        0,
        Math.min(
          MAX_EVENT_DEDUP_PRUNE_BATCH_SIZE,
          Math.floor(options?.pruneBatchSize ?? DEFAULT_EVENT_DEDUP_PRUNE_BATCH_SIZE),
        ),
      );

      // Every aggregate statement is gated on `WHERE changes() = 1` chained directly from
      // `INSERT OR IGNORE INTO analytics_event_dedup` so fresh claims update all aggregate tables
      // (keeping changes() = 1) while duplicate claims skip every aggregate table (keeping changes() = 0).
      const statements: D1PreparedStatement[] = [
        tenantDb
          .prepare("DELETE FROM analytics_event_dedup WHERE dedup_key = ? AND expires_at <= ?")
          .bind(dedupKey, nowMs),
        tenantDb
          .prepare(
            `INSERT OR IGNORE INTO analytics_event_dedup (dedup_key, expires_at, created_at)
             VALUES (?, ?, ?)`,
          )
          .bind(dedupKey, expiresAt, nowMs),
        tenantDb
          .prepare(
            `INSERT INTO analytics_daily (
               day,
               path,
               pageviews,
               unique_visitors,
               wa_clicks,
               external_clicks,
               lead_submits,
               updated_at
             )
             SELECT ?, ?, ?, 0, ?, ?, ?, ?
             WHERE changes() = 1
             ON CONFLICT(day, path) DO UPDATE SET
               pageviews = analytics_daily.pageviews + excluded.pageviews,
               wa_clicks = analytics_daily.wa_clicks + excluded.wa_clicks,
               external_clicks = analytics_daily.external_clicks + excluded.external_clicks,
               lead_submits = analytics_daily.lead_submits + excluded.lead_submits,
               updated_at = excluded.updated_at`,
          )
          .bind(
            day,
            event.path,
            pageviewsInc,
            waClicksInc,
            externalClicksInc,
            leadSubmitsInc,
            nowMs,
          ),
      ];

      if (pageviewsInc > 0) {
        statements.push(
          tenantDb
            .prepare(
              `INSERT INTO analytics_hourly_sources (
                 hour_bucket,
                 source_bucket,
                 utm_source,
                 visits,
                 updated_at
               )
               SELECT ?, ?, ?, ?, ?
               WHERE changes() = 1
               ON CONFLICT(hour_bucket, source_bucket, utm_source) DO UPDATE SET
                 visits = analytics_hourly_sources.visits + excluded.visits,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              utc.hourBucketUtc,
              classifiedSource.hourlySourceBucket,
              effectiveUtmSource,
              pageviewsInc,
              nowMs,
            ),
        );
      }

      if (hasInsightsTables) {
        statements.push(
          tenantDb
            .prepare(
              `INSERT INTO analytics_content_daily (
                 day_utc,
                 content_kind,
                 content_id,
                 path,
                 page_views,
                 wa_clicks,
                 external_clicks,
                 lead_submits,
                 updated_at
               )
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
               WHERE changes() = 1
               ON CONFLICT(day_utc, content_kind, content_id, path) DO UPDATE SET
                 page_views = analytics_content_daily.page_views + excluded.page_views,
                 wa_clicks = analytics_content_daily.wa_clicks + excluded.wa_clicks,
                 external_clicks = analytics_content_daily.external_clicks + excluded.external_clicks,
                 lead_submits = analytics_content_daily.lead_submits + excluded.lead_submits,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              utc.dayUtc,
              effectiveContentKind,
              effectiveContentId,
              effectiveContentPath,
              pageviewsInc,
              waClicksInc,
              externalClicksInc,
              leadSubmitsInc,
              nowMs,
            ),
          tenantDb
            .prepare(
              `INSERT INTO analytics_hourly_utc (
                 day_utc,
                 utc_hour,
                 page_views,
                 wa_clicks,
                 external_clicks,
                 lead_submits,
                 updated_at
               )
               SELECT ?, ?, ?, ?, ?, ?, ?
               WHERE changes() = 1
               ON CONFLICT(day_utc, utc_hour) DO UPDATE SET
                 page_views = analytics_hourly_utc.page_views + excluded.page_views,
                 wa_clicks = analytics_hourly_utc.wa_clicks + excluded.wa_clicks,
                 external_clicks = analytics_hourly_utc.external_clicks + excluded.external_clicks,
                 lead_submits = analytics_hourly_utc.lead_submits + excluded.lead_submits,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              utc.dayUtc,
              utc.utcHour,
              pageviewsInc,
              waClicksInc,
              externalClicksInc,
              leadSubmitsInc,
              nowMs,
            ),
          tenantDb
            .prepare(
              `INSERT INTO analytics_sources_daily (
                 day_utc,
                 source_bucket,
                 utm_source,
                 page_views,
                 wa_clicks,
                 external_clicks,
                 lead_submits,
                 updated_at
               )
               SELECT ?, ?, ?, ?, ?, ?, ?, ?
               WHERE changes() = 1
               ON CONFLICT(day_utc, source_bucket, utm_source) DO UPDATE SET
                 page_views = analytics_sources_daily.page_views + excluded.page_views,
                 wa_clicks = analytics_sources_daily.wa_clicks + excluded.wa_clicks,
                 external_clicks = analytics_sources_daily.external_clicks + excluded.external_clicks,
                 lead_submits = analytics_sources_daily.lead_submits + excluded.lead_submits,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              utc.dayUtc,
              classifiedSource.sourceBucket,
              effectiveUtmSource,
              pageviewsInc,
              waClicksInc,
              externalClicksInc,
              leadSubmitsInc,
              nowMs,
            ),
        );
      }

      let dedupPruneIndex = -1;
      if (pruneBatchSize > 0) {
        dedupPruneIndex = statements.length;
        statements.push(
          tenantDb
            .prepare(
              `DELETE FROM analytics_event_dedup
               WHERE dedup_key IN (
                 SELECT dedup_key
                 FROM analytics_event_dedup
                 WHERE expires_at <= ?
                 ORDER BY expires_at ASC
                 LIMIT ?
               )`,
            )
            .bind(nowMs, pruneBatchSize),
        );
      }

      pushBoundedInsightsRetentionPrunes(statements);

      const batchResults = await tenantDb.batch(statements);
      const claimed = (batchResults[1]?.meta?.changes ?? 0) === 1;
      const prunedExpiredCount =
        dedupPruneIndex >= 0 ? (batchResults[dedupPruneIndex]?.meta?.changes ?? 0) : 0;

      if (!claimed) {
        return {
          ok: true,
          recorded: false,
          deduplicated: true,
          eventId: event.eventId,
          day,
          path: event.path,
          eventType: event.eventType,
          prunedExpiredCount,
        };
      }

      return {
        ok: true,
        recorded: true,
        deduplicated: false,
        eventId: event.eventId,
        day,
        path: event.path,
        eventType: event.eventType,
        prunedExpiredCount,
      };
    }

    const statements: D1PreparedStatement[] = [
      tenantDb
        .prepare(
          `INSERT INTO analytics_daily (
             day,
             path,
             pageviews,
             unique_visitors,
             wa_clicks,
             external_clicks,
             lead_submits,
             updated_at
           )
           VALUES (?, ?, ?, 0, ?, ?, ?, ?)
           ON CONFLICT(day, path) DO UPDATE SET
             pageviews = analytics_daily.pageviews + excluded.pageviews,
             wa_clicks = analytics_daily.wa_clicks + excluded.wa_clicks,
             external_clicks = analytics_daily.external_clicks + excluded.external_clicks,
             lead_submits = analytics_daily.lead_submits + excluded.lead_submits,
             updated_at = excluded.updated_at`,
        )
        .bind(
          day,
          event.path,
          pageviewsInc,
          waClicksInc,
          externalClicksInc,
          leadSubmitsInc,
          nowMs,
        ),
    ];

    if (pageviewsInc > 0) {
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO analytics_hourly_sources (
               hour_bucket,
               source_bucket,
               utm_source,
               visits,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(hour_bucket, source_bucket, utm_source) DO UPDATE SET
               visits = analytics_hourly_sources.visits + excluded.visits,
               updated_at = excluded.updated_at`,
          )
          .bind(
            utc.hourBucketUtc,
            classifiedSource.hourlySourceBucket,
            effectiveUtmSource,
            pageviewsInc,
            nowMs,
          ),
      );
    }

    if (hasInsightsTables) {
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO analytics_content_daily (
               day_utc,
               content_kind,
               content_id,
               path,
               page_views,
               wa_clicks,
               external_clicks,
               lead_submits,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(day_utc, content_kind, content_id, path) DO UPDATE SET
               page_views = analytics_content_daily.page_views + excluded.page_views,
               wa_clicks = analytics_content_daily.wa_clicks + excluded.wa_clicks,
               external_clicks = analytics_content_daily.external_clicks + excluded.external_clicks,
               lead_submits = analytics_content_daily.lead_submits + excluded.lead_submits,
               updated_at = excluded.updated_at`,
          )
          .bind(
            utc.dayUtc,
            effectiveContentKind,
            effectiveContentId,
            effectiveContentPath,
            pageviewsInc,
            waClicksInc,
            externalClicksInc,
            leadSubmitsInc,
            nowMs,
          ),
        tenantDb
          .prepare(
            `INSERT INTO analytics_hourly_utc (
               day_utc,
               utc_hour,
               page_views,
               wa_clicks,
               external_clicks,
               lead_submits,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(day_utc, utc_hour) DO UPDATE SET
               page_views = analytics_hourly_utc.page_views + excluded.page_views,
               wa_clicks = analytics_hourly_utc.wa_clicks + excluded.wa_clicks,
               external_clicks = analytics_hourly_utc.external_clicks + excluded.external_clicks,
               lead_submits = analytics_hourly_utc.lead_submits + excluded.lead_submits,
               updated_at = excluded.updated_at`,
          )
          .bind(
            utc.dayUtc,
            utc.utcHour,
            pageviewsInc,
            waClicksInc,
            externalClicksInc,
            leadSubmitsInc,
            nowMs,
          ),
        tenantDb
          .prepare(
            `INSERT INTO analytics_sources_daily (
               day_utc,
               source_bucket,
               utm_source,
               page_views,
               wa_clicks,
               external_clicks,
               lead_submits,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(day_utc, source_bucket, utm_source) DO UPDATE SET
               page_views = analytics_sources_daily.page_views + excluded.page_views,
               wa_clicks = analytics_sources_daily.wa_clicks + excluded.wa_clicks,
               external_clicks = analytics_sources_daily.external_clicks + excluded.external_clicks,
               lead_submits = analytics_sources_daily.lead_submits + excluded.lead_submits,
               updated_at = excluded.updated_at`,
          )
          .bind(
            utc.dayUtc,
            classifiedSource.sourceBucket,
            effectiveUtmSource,
            pageviewsInc,
            waClicksInc,
            externalClicksInc,
            leadSubmitsInc,
            nowMs,
          ),
      );
    }

    pushBoundedInsightsRetentionPrunes(statements);
    await tenantDb.batch(statements);

    return {
      ok: true,
      recorded: true,
      deduplicated: false,
      day,
      path: event.path,
      eventType: event.eventType,
    };
  } catch {
    return {
      ok: false,
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Layanan penyimpanan analitik sementara tidak tersedia.",
    };
  }
}

function toSafeCount(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

/**
 * Pure aggregation over `analytics_daily` rows producing totals, contiguous daily breakdown,
 * and top paths sorted by interest signals (`waClicks + externalClicks + leadSubmits`).
 */
export function aggregateAnalyticsDailyRows(
  rows: readonly AnalyticsDailyRow[],
  options?: GetTenantDashboardMetricsOptions,
): TenantDashboardMetrics {
  const days: 7 | 30 = options?.days === 30 ? 30 : 7;
  const nowMs = Math.floor(options?.nowMs ?? Date.now());
  const timeZone = options?.timeZone?.trim() || DEFAULT_ANALYTICS_TIMEZONE;
  const topPathsLimit = Math.max(1, Math.min(50, Math.floor(options?.topPathsLimit ?? 10)));

  const { startDay, endDay, dayKeys } = buildDaySeries(days, nowMs, timeZone);

  const dayMap = new Map<
    string,
    {
      pageviews: number;
      uniqueVisitors: number;
      waClicks: number;
      externalClicks: number;
      leadSubmits: number;
    }
  >();
  for (const key of dayKeys) {
    dayMap.set(key, {
      pageviews: 0,
      uniqueVisitors: 0,
      waClicks: 0,
      externalClicks: 0,
      leadSubmits: 0,
    });
  }

  const pathMap = new Map<
    string,
    {
      pageviews: number;
      waClicks: number;
      externalClicks: number;
      leadSubmits: number;
    }
  >();

  let totalWaClicks = 0;
  let totalExternalClicks = 0;
  let totalLeadSubmits = 0;
  let totalPageviews = 0;
  let totalUniqueVisitors = 0;

  for (const row of rows) {
    if (!row.day || row.day < startDay || row.day > endDay) continue;

    const pageviews = toSafeCount(row.pageviews);
    const uniqueVisitors = toSafeCount(row.unique_visitors);
    const waClicks = toSafeCount(row.wa_clicks);
    const externalClicks = toSafeCount(row.external_clicks);
    const leadSubmits = toSafeCount(row.lead_submits);

    totalPageviews += pageviews;
    totalUniqueVisitors += uniqueVisitors;
    totalWaClicks += waClicks;
    totalExternalClicks += externalClicks;
    totalLeadSubmits += leadSubmits;

    const dayAgg = dayMap.get(row.day);
    if (dayAgg) {
      dayAgg.pageviews += pageviews;
      dayAgg.uniqueVisitors += uniqueVisitors;
      dayAgg.waClicks += waClicks;
      dayAgg.externalClicks += externalClicks;
      dayAgg.leadSubmits += leadSubmits;
    }

    const existingPath = pathMap.get(row.path) ?? {
      pageviews: 0,
      waClicks: 0,
      externalClicks: 0,
      leadSubmits: 0,
    };
    existingPath.pageviews += pageviews;
    existingPath.waClicks += waClicks;
    existingPath.externalClicks += externalClicks;
    existingPath.leadSubmits += leadSubmits;
    pathMap.set(row.path, existingPath);
  }

  const daily: DailyMetricPoint[] = dayKeys.map((day) => {
    const agg = dayMap.get(day)!;
    return {
      day,
      pageviews: agg.pageviews,
      uniqueVisitors: agg.uniqueVisitors,
      waClicks: agg.waClicks,
      externalClicks: agg.externalClicks,
      leadSubmits: agg.leadSubmits,
      totalInterestSignals: agg.waClicks + agg.externalClicks + agg.leadSubmits,
    };
  });

  const topPaths: TopPathMetric[] = Array.from(pathMap.entries())
    .map(([path, agg]) => ({
      path,
      pageviews: agg.pageviews,
      waClicks: agg.waClicks,
      externalClicks: agg.externalClicks,
      leadSubmits: agg.leadSubmits,
      totalInterestSignals: agg.waClicks + agg.externalClicks + agg.leadSubmits,
    }))
    .filter((entry) => entry.totalInterestSignals > 0 || entry.pageviews > 0)
    .sort((a, b) => {
      if (b.totalInterestSignals !== a.totalInterestSignals) {
        return b.totalInterestSignals - a.totalInterestSignals;
      }
      if (b.pageviews !== a.pageviews) {
        return b.pageviews - a.pageviews;
      }
      return a.path.localeCompare(b.path);
    })
    .slice(0, topPathsLimit);

  const totalInterestSignals = totalWaClicks + totalExternalClicks + totalLeadSubmits;
  const hasAnyData = totalInterestSignals > 0 || totalPageviews > 0;

  return {
    days,
    startDay,
    endDay,
    timeZone,
    totals: {
      waClicks: totalWaClicks,
      externalClicks: totalExternalClicks,
      leadSubmits: totalLeadSubmits,
      pageviews: totalPageviews,
      uniqueVisitors: totalUniqueVisitors,
      totalInterestSignals,
    },
    daily,
    topPaths,
    hasAnyData,
  };
}

/**
 * Creates a deterministic empty `TenantDashboardMetrics` summary for zero-data or initial states.
 */
export function createEmptyDashboardMetrics(
  options?: GetTenantDashboardMetricsOptions,
): TenantDashboardMetrics {
  return aggregateAnalyticsDailyRows([], options);
}

/**
 * Queries `TenantStore.analytics_daily` for the requested rolling window (`7` or `30` days)
 * and returns aggregated KPI totals, daily series, and top paths.
 */
export async function getTenantDashboardMetrics(
  tenantDb: D1Database,
  options?: GetTenantDashboardMetricsOptions,
): Promise<TenantDashboardMetrics> {
  const days: 7 | 30 = options?.days === 30 ? 30 : 7;
  const nowMs = Math.floor(options?.nowMs ?? Date.now());
  const timeZone = options?.timeZone?.trim() || DEFAULT_ANALYTICS_TIMEZONE;
  const { startDay, endDay } = buildDaySeries(days, nowMs, timeZone);

  const result = await tenantDb
    .prepare(
      `SELECT day, path, pageviews, unique_visitors, wa_clicks, external_clicks, lead_submits, updated_at
       FROM analytics_daily
       WHERE day >= ? AND day <= ?
       ORDER BY day ASC, path ASC`,
    )
    .bind(startDay, endDay)
    .all<AnalyticsDailyRow>();

  return aggregateAnalyticsDailyRows(result.results ?? [], {
    days,
    nowMs,
    timeZone,
    topPathsLimit: options?.topPathsLimit,
  });
}
